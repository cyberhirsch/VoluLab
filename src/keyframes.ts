/**
 * Keyframes: any numeric parameter of any node can be keyed over time.
 *
 * A node does not know about keys. What knows is the parameter's
 * description (ParamSpec): how to read the value from the op and how to
 * write it back. A node class opts in by describing its numeric parameters
 * once, with `keyable(Class, [...])`; from then on
 *
 *  - the node pane puts a key button and a curve beside every field that
 *    names one of those parameters (ui/keyframe-ui.ts),
 *  - the keyframe driver (keyframe-driver.ts) writes the keyed values into
 *    the op as the timeline moves and replays the node,
 *  - a project stores the keys with the node (doc.ts, `keyframes`).
 *
 * The keys live on the op itself, in `op.keys`, by parameter id, so they go
 * where the op goes: undo of the node takes them with it, a bypassed node
 * keeps them, a project restores them onto the node it restores.
 *
 * Frames are timeline frames, fractional between frames: the video export
 * steps the time in between, and a keyed value follows it smoothly.
 */

type Interp = 'linear' | 'ease' | 'step';

/** One key. `interp` is how the value travels from this key to the next. */
type Key = { frame: number; value: number; interp: Interp };

/** A parameter's keys, sorted by frame, no two on one frame. */
type Track = Key[];

/** What an op carries once one of its parameters is keyed. */
type Keyed = { keys?: Record<string, Track> };

/**
 * A numeric parameter of a node, as the keyframe system sees it.
 *
 * `set` has to leave the op ready to be replayed with the new value: a node
 * that caches what it resolved forgets it there (as CropOp.setVolume does).
 * The driver always calls it inside the history's refresh, which reverses the
 * node first - see EditHistory.refresh.
 */
type ParamSpec<T = any> = {
    /** stable: it is what a project stores the keys under */
    id: string;
    /** what the curve editor calls it; the field's own label otherwise */
    label?: string;
    get: (op: T) => number;
    set: (op: T, value: number) => void;
    /** where the curve editor's value axis starts and ends, if known */
    min?: number;
    max?: number;
    /** a whole number, such as a frame or a count: keyed values round */
    integer?: boolean;
};

// by class; looked up along the prototype chain, so a subclass inherits
const registry = new Map<object, ParamSpec[]>();

/**
 * Describe the keyable parameters of a node class. Called once, next to
 * the class or anywhere before the node is shown. A second call for the
 * same class adds to the first (a parameter with the same id is replaced).
 */
const keyable = <T>(ctor: abstract new (...args: any[]) => T, specs: ParamSpec<T>[]) => {
    const list = registry.get(ctor.prototype) ?? [];
    specs.forEach((spec) => {
        const at = list.findIndex(s => s.id === spec.id);
        if (at >= 0) list[at] = spec as ParamSpec;
        else list.push(spec as ParamSpec);
    });
    registry.set(ctor.prototype, list);
};

/** The keyable parameters of an op, its class's and those it inherits. */
const paramsOf = (op: object): ParamSpec[] => {
    const out: ParamSpec[] = [];
    const seen = new Set<string>();
    for (let proto = op ? Object.getPrototypeOf(op) : null; proto; proto = Object.getPrototypeOf(proto)) {
        (registry.get(proto) ?? []).forEach((spec) => {
            if (!seen.has(spec.id)) {
                seen.add(spec.id);
                out.push(spec);
            }
        });
    }
    return out;
};

const paramOf = (op: object, id: string) => paramsOf(op).find(s => s.id === id) ?? null;

const trackOf = (op: object, id: string): Track | null => {
    const track = (op as Keyed)?.keys?.[id];
    return track && track.length ? track : null;
};

const isKeyed = (op: object) => !!(op as Keyed)?.keys && Object.values((op as Keyed).keys).some(t => t.length > 0);

// smoothstep: leaves and arrives with no speed, which is what "ease" means
// to anyone who has used an animation tool
const ease = (u: number) => u * u * (3 - 2 * u);

/** The track's value at a frame: held before the first key and after the last. */
const evaluate = (track: Track, frame: number): number => {
    if (!track.length) return NaN;
    if (frame <= track[0].frame) return track[0].value;
    const last = track[track.length - 1];
    if (frame >= last.frame) return last.value;

    // the segment the frame is in
    let lo = 0;
    let hi = track.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (track[mid].frame <= frame) lo = mid;
        else hi = mid;
    }
    const a = track[lo];
    const b = track[hi];
    if (a.interp === 'step') return a.value;
    const u = (frame - a.frame) / Math.max(1e-9, b.frame - a.frame);
    return a.value + (b.value - a.value) * (a.interp === 'ease' ? ease(u) : u);
};

/** The value a parameter has at a frame: its key's, or the op's own if unkeyed. */
const valueAt = (op: object, spec: ParamSpec, frame: number) => {
    const track = trackOf(op, spec.id);
    if (!track) return spec.get(op);
    const v = evaluate(track, frame);
    return spec.integer ? Math.round(v) : v;
};

const keyAt = (track: Track | null, frame: number) => track?.find(k => Math.abs(k.frame - frame) < 1e-6) ?? null;

/**
 * Put a key on a parameter at a frame, or move the one there to the value.
 * A new key takes the interpolation of the key before it, or linear.
 */
const setKey = (target: object, id: string, frame: number, value: number, interp?: Interp) => {
    const op = target as Keyed;
    op.keys ??= {};
    const track = op.keys[id] ??= [];
    const at = keyAt(track, frame);
    if (at) {
        at.value = value;
        if (interp) at.interp = interp;
        return at;
    }
    const before = [...track].reverse().find(k => k.frame < frame);
    const key: Key = { frame, value, interp: interp ?? before?.interp ?? 'linear' };
    track.push(key);
    track.sort((a, b) => a.frame - b.frame);
    return key;
};

const removeKey = (target: object, id: string, frame: number) => {
    const op = target as Keyed;
    const track = op.keys?.[id];
    if (!track) return;
    const i = track.findIndex(k => Math.abs(k.frame - frame) < 1e-6);
    if (i >= 0) track.splice(i, 1);
    if (!track.length) delete op.keys[id];
};

/** Take every key off a parameter; the op keeps the value it has now. */
const clearKeys = (target: object, id: string) => {
    const op = target as Keyed;
    if (op.keys) delete op.keys[id];
};

/** A key moved along the timeline, onto `frame`; one already there makes way. */
const moveKey = (target: object, id: string, key: Key, frame: number) => {
    const op = target as Keyed;
    const track = op.keys?.[id];
    if (!track) return;
    const other = keyAt(track, frame);
    if (other && other !== key) track.splice(track.indexOf(other), 1);
    key.frame = frame;
    track.sort((a, b) => a.frame - b.frame);
};

/** The keys as a project stores them: plain arrays, nothing else. */
const packKeys = (target: object): Record<string, [number, number, Interp][]> | null => {
    if (!isKeyed(target)) return null;
    const op = target as Keyed;
    const out: Record<string, [number, number, Interp][]> = {};
    Object.entries(op.keys).forEach(([id, track]) => {
        if (track.length) out[id] = track.map(k => [k.frame, k.value, k.interp]);
    });
    return out;
};

const INTERPS: Interp[] = ['linear', 'ease', 'step'];

/** And back onto an op; anything that does not read as keys is dropped. */
const unpackKeys = (target: object, stored: unknown) => {
    const op = target as Keyed;
    if (!stored || typeof stored !== 'object') return;
    Object.entries(stored as Record<string, unknown>).forEach(([id, keys]) => {
        if (!Array.isArray(keys)) return;
        keys.forEach((k) => {
            if (Array.isArray(k) && Number.isFinite(k[0]) && Number.isFinite(k[1])) {
                setKey(op, id, k[0], k[1], INTERPS.includes(k[2]) ? k[2] : 'linear');
            }
        });
    });
};

export {
    type Interp,
    type Key,
    type Track,
    type Keyed,
    type ParamSpec,
    INTERPS,
    keyable,
    paramsOf,
    paramOf,
    trackOf,
    isKeyed,
    evaluate,
    valueAt,
    keyAt,
    setKey,
    removeKey,
    clearKeys,
    moveKey,
    packKeys,
    unpackKeys
};
