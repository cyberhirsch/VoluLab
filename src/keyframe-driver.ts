import { EditOp, principalOp } from './edit-ops';
import { Events } from './events';
import { Keyed, ParamSpec, paramsOf, setKey, trackOf, valueAt } from './keyframes';

/**
 * Plays the keys: as the timeline moves, each applied node with keyed
 * parameters gets the values of the frame written into it, and is replayed.
 *
 * A replay goes through the history (edit.refresh), so everything after the
 * node follows. Where that is more than needed, a node class can say how to
 * show new values on its own (`keyableLive`) - a transform node with nothing
 * after it that places the object only has to move the object.
 *
 * The driver also catches an edit of a keyed parameter: when the value a
 * node holds is not the one the driver put there, someone typed it, and it
 * becomes a key at the frame shown. A field need not know it is keyed.
 *
 * Nodes that change with time without keys - a track's placement per frame -
 * take part the same way through `animate` (FrameDriven).
 */

/**
 * A node whose effect depends on the frame by itself. `animate` shows the
 * frame and says whether that needs a replay of the node (true) or was done
 * in place (false). `later` is what comes after the node in the history,
 * applied, for a node to tell whether it may work in place.
 */
type FrameDriven = {
    animate: (frame: number, later: EditOp[]) => boolean;
};

const isFrameDriven = (op: any): op is FrameDriven => typeof op?.animate === 'function';

/**
 * Show a node's new values without a replay, if the node can: returns
 * whether it did. Given what comes after the node in the history.
 */
type LiveUpdate<T> = (op: T, later: EditOp[]) => boolean;

const live = new Map<object, LiveUpdate<any>>();

/** Say how a node class shows new keyed values in place (see LiveUpdate). */
const keyableLive = <T>(ctor: abstract new (...args: any[]) => T, update: LiveUpdate<T>) => {
    live.set(ctor.prototype, update);
};

const liveOf = (op: object): LiveUpdate<any> | null => {
    for (let proto = Object.getPrototypeOf(op); proto; proto = Object.getPrototypeOf(proto)) {
        const f = live.get(proto);
        if (f) return f;
    }
    return null;
};

// Equal as far as a parameter can tell: some read back through float32
// storage (a crop's volume is a Mat4), so a value set is not the value read
const same = (a: number, b: number) => a === b || Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

const registerKeyframeDriver = (events: Events) => {
    // per op: the frame it was last driven at, the values it was given
    // (want) and what it read back once they were set (got). An edit is a
    // read that differs from `got`, never from `want`: a value need not come
    // back exactly as it was set
    const driven = new WeakMap<object, { frame: number, want: Map<string, number>, got: Map<string, number> }>();

    let frame = 0;
    let running: Promise<void> | null = null;
    let again = false;

    const history = () => (events.invoke('edit.history') as { ops: EditOp[], cursor: number }) ?? { ops: [], cursor: 0 };

    const keyedSpecs = (op: object): ParamSpec[] => paramsOf(op).filter(s => trackOf(op as Keyed, s.id));

    // An edit of a keyed value since it was driven: a key at the frame shown
    const catchEdits = () => {
        const { ops, cursor } = history();
        const at = frame;
        for (let i = 0; i < cursor; ++i) {
            const op = principalOp(ops[i]);
            const was = driven.get(op);
            if (!was || was.frame !== at) continue;
            keyedSpecs(op).forEach((spec) => {
                const now = spec.get(op);
                const before = was.got.get(spec.id);
                if (before !== undefined && Number.isFinite(now) && !same(now, before)) {
                    setKey(op, spec.id, at, now);
                    was.want.set(spec.id, now);
                    was.got.set(spec.id, now);
                }
            });
        }
    };

    const passes = async () => {
        do {
            again = false;
            catchEdits();
            const at = frame;
            const { ops, cursor } = history();
            const replays: { op: EditOp, apply: () => void }[] = [];

            for (let i = 0; i < cursor; ++i) {
                const outer = ops[i];
                if (outer.bypassed) continue;
                const op = principalOp(outer);
                const later = ops.slice(i + 1, cursor).filter(o => !o.bypassed);

                const specs = keyedSpecs(op);
                if (specs.length) {
                    const was = driven.get(op);
                    const want = new Map<string, number>();
                    let changed = false;
                    specs.forEach((spec) => {
                        const v = valueAt(op as Keyed, spec, at);
                        want.set(spec.id, v);
                        // given this value already, and it reads as it did then
                        const kept = was && was.want.has(spec.id) && same(v, was.want.get(spec.id)) &&
                            was.got.has(spec.id) && same(spec.get(op), was.got.get(spec.id));
                        if (!kept && !same(v, spec.get(op))) changed = true;
                    });
                    const got = new Map<string, number>();
                    if (!changed) specs.forEach(spec => got.set(spec.id, spec.get(op)));
                    driven.set(op, { frame: at, want, got });
                    if (changed) {
                        const apply = () => specs.forEach((spec) => {
                            spec.set(op, want.get(spec.id));
                            got.set(spec.id, spec.get(op));
                        });
                        const update = liveOf(op);
                        // set first, then shown in place - or handed to
                        // the replay, which reverses the node first
                        let done = false;
                        if (update) {
                            apply();
                            done = update(op, later);
                        }
                        if (!done) replays.push({ op: outer, apply });
                    }
                }

                if (isFrameDriven(op) && op.animate(at, later)) {
                    replays.push({ op: outer, apply: () => {} });
                }
            }

            // in chain order; each finds its index again, since a replay
            // can be queued behind other edits
            for (const { op, apply } of replays) {
                const index = history().ops.indexOf(op);
                if (index >= 0) await events.invoke('edit.refresh', index, apply);
            }
        } while (again);
    };

    // Resolves once the frame is shown through every key, the replays it
    // asked for included; a call while a pass runs joins that pass
    const drive = (): Promise<void> => {
        if (running) {
            again = true;
            return running;
        }
        running = passes().finally(() => {
            running = null;
        });
        return running;
    };

    const toFrame = (f: number) => {
        if (!Number.isFinite(f) || f === frame) return;
        frame = f;
        drive();
    };

    events.on('timeline.frame', (f: number) => toFrame(f));
    // playback and the video export step the time between frames
    events.on('timeline.time', (t: number) => toFrame(t));
    // once playback stops, the frame shown is the whole one the timeline
    // stands on: a key typed then goes there, not between frames
    events.on('timeline.playing', (playing: boolean) => {
        if (!playing) toFrame(events.invoke('timeline.frame') ?? frame);
    });

    // after any edit: keys may have been added, a node keyed, a value typed.
    // While the driver runs its own replays end in this too; the pass it
    // asks for then finds nothing to do
    events.on('edit.changed', () => drive());

    // the frame keys are put at, and the driver's way in for the UI
    events.function('keyframes.frame', () => frame);
    events.function('keyframes.drive', () => drive());
    // the video export: resolves once the time it set is shown through the keys
    events.function('keyframes.settled', () => running ?? Promise.resolve());
};

export { registerKeyframeDriver, keyableLive, type FrameDriven, type LiveUpdate };
