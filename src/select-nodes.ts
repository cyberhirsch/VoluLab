import { EditOp, SelectMode, SelectOp, StateOp } from './edit-ops';
import { IndexRanges } from './index-ranges';
import { Splat } from './splat';
import { State } from './splat-state';

/**
 * Select nodes that select by a rule rather than by a gesture: by motion,
 * by colour, by a region that can move over time, by an attribute, by
 * growing or shrinking what is selected, and by combining the selections
 * of other select nodes.
 *
 * They are select nodes in every sense the rest of the editor knows: each
 * is a StateOp that writes the selected bit and nothing else, so the nodes
 * after it - delete, split, colour, holdout - act on what it leaves
 * selected, as they act on a select node's. Like a select node it says what
 * the selection is afterwards and is applied as a toggle of the difference,
 * which is what makes it undo, replay and bypass the same way.
 *
 * Every numeric setting is a plain number in `params`, read through
 * `value(key, frame)`. Without keys that is the number; the keyframe work
 * hooks `SelectionNodeOp.keyed` to give a keyed value at a frame. The
 * region node asks per frame, so a keyed region follows what it is keyed to.
 */

type SelectionNodeKind = 'motion' | 'colour' | 'region' | 'attribute' | 'grow' | 'combine';

// TOGGLE in edit-ops' BitOp, which is a const enum and not exported
const BIT_TOGGLE = 2 as ConstructorParameters<typeof StateOp>[3];

// the splat shader drops a gaussian faded below 1/255: dt^2 * falloff > ln 255
const FADE_CUT = Math.log(255);

// SH band 0's basis constant: a DC coefficient c shows as 0.5 + SH_C0 * c
const SH_C0 = 0.28209479177387814;

const sigmoid = (v: number) => 1 / (1 + Math.exp(-v));

/** A gaussian the selection can reach: neither hidden nor deleted. */
const reachable = (state: Uint8Array, i: number) => (state[i] & (State.locked | State.deleted)) === 0;

/**
 * Where each gaussian is in the world, 3 floats each. A 4D model's
 * gaussians are where they are at their own temporal centre, which is where
 * their stored position puts them.
 */
const worldCenters = (splat: Splat): Float32Array => {
    const data = splat.splatData;
    const n = data.numSplats;
    const x = data.getProp('x') as Float32Array;
    const y = data.getProp('y') as Float32Array;
    const z = data.getProp('z') as Float32Array;
    const m = splat.worldTransform.data;
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n; ++i) {
        const px = x[i], py = y[i], pz = z[i];
        out[i * 3] = m[0] * px + m[4] * py + m[8] * pz + m[12];
        out[i * 3 + 1] = m[1] * px + m[5] * py + m[9] * pz + m[13];
        out[i * 3 + 2] = m[2] * px + m[6] * py + m[10] * pz + m[14];
    }
    return out;
};

/** How many frames a 4D model's own sequence has, at least 1. */
const modelFrames = (splat: Splat) => Math.max(1, splat.motionFrames || 1);

/**
 * A 4D gaussian's lifetime in normalised time: centre and half-width. A
 * gaussian with no falloff lives for the whole sequence.
 */
const lifetime = (splat: Splat, i: number) => {
    const { velocityTime, falloff } = splat.motion;
    const tc = velocityTime[i * 4 + 3];
    const reach = falloff[i] > 0 ? Math.sqrt(FADE_CUT / falloff[i]) : Infinity;
    return { tc, reach };
};

abstract class SelectionNodeOp extends StateOp {
    /**
     * A keyed value of a node's parameter at a frame of the model, or
     * undefined where the parameter has no keys. Set by the keyframe work;
     * unset, every parameter is its number.
     */
    static keyed: ((op: SelectionNodeOp, key: string, frame: number) => number | undefined) | null = null;

    /** whether an op is applied in the history now: set by the editor */
    static applied: ((op: EditOp) => boolean) | null = null;

    abstract readonly kind: SelectionNodeKind;

    /** how what it catches combines with the selection coming in */
    mode: SelectMode = 'set';

    /** what the selection is called, for a combine node it is wired into */
    label = '';

    /** the node's numeric settings: plain numbers, so they can be keyed */
    params: Record<string, number>;

    /** what is selected once the node has run, as SelectOp.result */
    result: IndexRanges | null = null;

    /** how many gaussians the rule caught when it last ran, or -1 */
    caught = -1;

    /** why it caught nothing it could have, when it last ran: a locale key */
    warning: string | null = null;

    constructor(splat: Splat, params: Record<string, number>) {
        super(splat, null, State.selected, BIT_TOGGLE);
        this.params = { ...params };

        this.resolver = async (s: Splat) => {
            const n = s.splatData.numSplats;
            const state = s.splatData.getProp('state') as Uint8Array;
            this.warning = null;

            const hit = await this.hits(s);

            const desired = new Uint8Array(n);
            let caught = 0;
            for (let i = 0; i < n; ++i) {
                const was = (state[i] & State.selected) ? 1 : 0;
                const h = hit[i] && reachable(state, i) ? 1 : 0;
                caught += h;
                switch (this.mode) {
                    case 'set': desired[i] = h; break;
                    case 'add': desired[i] = was | h; break;
                    case 'remove': desired[i] = h ? 0 : was; break;
                    case 'intersect': desired[i] = was & h; break;
                }
            }
            this.caught = caught;

            this.result = IndexRanges.fromPredicate(n, i => desired[i] === 1 && reachable(state, i));

            // the op states the result: toggle where the selection and it
            // disagree, among the gaussians a selection can reach
            return IndexRanges.fromPredicate(n, i => reachable(state, i) && ((state[i] === State.selected) !== (desired[i] === 1)));
        };
    }

    /** 1 for each gaussian the rule catches, before the mode folds it in. */
    protected abstract hits(splat: Splat): Uint8Array | Promise<Uint8Array>;

    /** a line for the graph, under the node's title */
    abstract describe(): string;

    /** A parameter, keyed at the frame if it has keys there. */
    value(key: string, frame = 0): number {
        const keyed = SelectionNodeOp.keyed?.(this, key, frame);
        return keyed ?? this.params[key];
    }

    /** whether any parameter has keys, which makes the node ask per frame */
    protected anyKeyed(keys: string[]) {
        if (!SelectionNodeOp.keyed) return false;
        return keys.some(k => SelectionNodeOp.keyed(this, k, 0) !== undefined);
    }

    setParam(key: string, v: number) {
        if (!Number.isFinite(v)) return;
        this.params[key] = v;
        this.invalidate();
    }

    setMode(mode: SelectMode) {
        this.mode = mode;
        this.invalidate();
    }

    get sourceLabel() {
        return this.label ? `${this.label} · ${this.describe()}` : this.describe();
    }

    /** the settings a project keeps, besides the common ones */
    protected extra(): Record<string, any> {
        return {};
    }

    /** take back what extra() gave */
    restoreExtra(_stored: Record<string, any>) {
        // nothing by default
    }

    /** everything a project needs to make the node again */
    get settings(): Record<string, any> {
        return { kind: this.kind, mode: this.mode, label: this.label, params: { ...this.params }, ...this.extra() };
    }

    destroy() {
        super.destroy();
        this.result = null;
    }
}

// ---------------------------------------------------------------------------
// select by motion

type MotionMetric = 'speed' | 'distance';

/**
 * Selects a 4D model's gaussians by how fast they move or how far they
 * travel in a range of frames, from the velocity the model plays with -
 * the one the debug view's speed and velocity channels show. Speed is in
 * units per frame, distance in units over the range; a gaussian that is not
 * drawn anywhere in the range is not caught. On a 3D object everything
 * stands still: speed 0.
 */
class MotionSelectOp extends SelectionNodeOp {
    name = 'selectByMotion';
    readonly kind = 'motion';

    metric: MotionMetric;

    constructor(splat: Splat, metric: MotionMetric = 'speed', params: Record<string, number> = {}) {
        super(splat, { from: 0, to: -1, min: 0.001, max: 1e6, ...params });
        this.metric = metric;
    }

    setMetric(metric: MotionMetric) {
        this.metric = metric;
        this.invalidate();
    }

    /** the range of model frames, `to` of -1 being the last */
    range(splat: Splat): [number, number] {
        const frames = modelFrames(splat);
        const from = Math.max(0, Math.min(frames - 1, Math.round(this.params.from)));
        const to = this.params.to < 0 ? frames - 1 : Math.max(from, Math.min(frames - 1, Math.round(this.params.to)));
        return [from, to];
    }

    /**
     * The measure per gaussian, NaN for one not drawn in the range: what the
     * node selects on, and what the face draws the histogram of.
     */
    values(splat: Splat): Float32Array {
        const n = splat.splatData.numSplats;
        const out = new Float32Array(n);
        if (!splat.motion) return out;

        const frames = modelFrames(splat);
        const [from, to] = this.range(splat);
        const t0 = from / frames;
        const t1 = to / frames;
        const vt = splat.motion.velocityTime;
        for (let i = 0; i < n; ++i) {
            const { tc, reach } = lifetime(splat, i);
            const lo = Math.max(t0, tc - reach);
            const hi = Math.min(t1, tc + reach);
            if (!(lo <= hi)) {
                out[i] = NaN;
                continue;
            }
            // per unit of normalised time, which is the whole sequence
            const speed = Math.hypot(vt[i * 4], vt[i * 4 + 1], vt[i * 4 + 2]);
            out[i] = this.metric === 'speed' ? speed / frames : speed * (hi - lo);
        }
        return out;
    }

    protected hits(splat: Splat) {
        if (!splat.motion) this.warning = 'node.selmotion.still';
        const v = this.values(splat);
        const lo = this.value('min');
        const hi = this.value('max');
        const out = new Uint8Array(v.length);
        for (let i = 0; i < v.length; ++i) {
            out[i] = v[i] >= lo && v[i] <= hi ? 1 : 0;
        }
        return out;
    }

    describe() {
        return `${this.metric} ${+this.params.min.toPrecision(3)}–${this.params.max >= 1e6 ? '∞' : +this.params.max.toPrecision(3)}`;
    }

    protected extra() {
        return { metric: this.metric };
    }

    restoreExtra(stored: Record<string, any>) {
        this.metric = stored.metric === 'distance' ? 'distance' : 'speed';
    }
}

// ---------------------------------------------------------------------------
// the nodes, by kind

// the kinds built, in menu order
const SELECTION_NODE_KINDS: SelectionNodeKind[] = ['motion'];

/** the op name each kind goes by, for the graph's labels */
const SELECTION_NODE_NAMES: Record<SelectionNodeKind, string> = {
    motion: 'selectByMotion',
    colour: 'selectByColour',
    region: 'selectByRegion',
    attribute: 'selectByAttribute',
    grow: 'growSelection',
    combine: 'combineSelections'
};

/** a select node of either sort: a gesture's, or one of these */
const isSelectionSource = (op: unknown): op is SelectOp | SelectionNodeOp => {
    return op instanceof SelectOp || op instanceof SelectionNodeOp;
};

/** A new node of a kind, with its defaults; null for a kind not built yet. */
const makeSelectionNode = (kind: string, splat: Splat): SelectionNodeOp | null => {
    switch (kind) {
        case 'motion': return new MotionSelectOp(splat);
        default: return null;
    }
};

/** A node from what `settings` gave, ready to add; null for one not known. */
const selectionNodeFrom = (splat: Splat, stored: Record<string, any>): SelectionNodeOp | null => {
    const op = makeSelectionNode(stored?.kind, splat);
    if (!op) return null;
    if (['set', 'add', 'remove', 'intersect'].includes(stored.mode)) op.mode = stored.mode;
    op.label = typeof stored.label === 'string' ? stored.label : '';
    Object.entries(stored.params ?? {}).forEach(([k, v]) => {
        if (typeof v === 'number' && Number.isFinite(v)) op.params[k] = v;
    });
    op.restoreExtra(stored);
    return op;
};

export {
    SelectionNodeOp,
    type SelectionNodeKind,
    MotionSelectOp,
    type MotionMetric,
    SELECTION_NODE_KINDS,
    SELECTION_NODE_NAMES,
    isSelectionSource,
    makeSelectionNode,
    selectionNodeFrom,
    worldCenters,
    modelFrames,
    lifetime,
    reachable,
    sigmoid,
    SH_C0,
    FADE_CUT
};
