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

const same = (a: number, b: number) => a === b || Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

const registerKeyframeDriver = (events: Events) => {
    // per op: the frame it was last driven at and the values it was given
    const driven = new WeakMap<object, { frame: number, values: Map<string, number> }>();

    let frame = 0;
    let running = false;
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
                const before = was.values.get(spec.id);
                if (before !== undefined && Number.isFinite(now) && !same(now, before)) {
                    setKey(op, spec.id, at, now);
                    was.values.set(spec.id, now);
                }
            });
        }
    };

    const drive = async () => {
        if (running) {
            again = true;
            return;
        }
        running = true;
        try {
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
                        const values = new Map<string, number>();
                        let changed = false;
                        specs.forEach((spec) => {
                            const v = valueAt(op as Keyed, spec, at);
                            values.set(spec.id, v);
                            if (!same(v, spec.get(op))) changed = true;
                        });
                        driven.set(op, { frame: at, values });
                        if (changed) {
                            const apply = () => specs.forEach(spec => spec.set(op, values.get(spec.id)));
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
        } finally {
            running = false;
        }
    };

    const toFrame = (f: number) => {
        if (!Number.isFinite(f) || f === frame) return;
        frame = f;
        drive();
    };

    events.on('timeline.frame', (f: number) => toFrame(f));
    // the video export steps the time between frames
    events.on('timeline.time', (t: number) => toFrame(t));

    // after any edit: keys may have been added, a node keyed, a value typed.
    // While the driver runs its own replays end in this too; the pass it
    // asks for then finds nothing to do
    events.on('edit.changed', () => drive());

    // the frame keys are put at, and the driver's way in for the UI
    events.function('keyframes.frame', () => frame);
    events.function('keyframes.drive', () => drive());
};

export { registerKeyframeDriver, keyableLive, type FrameDriven, type LiveUpdate };
