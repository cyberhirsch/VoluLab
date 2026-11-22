import { Mat4, Quat, Vec3 } from 'playcanvas';

import { EditOp, PortSpec, SelectMode, SelectOp, StateOp } from './edit-ops';
import { HoldoutOp } from './holdout';
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

/**
 * How far apart an object's gaussians typically are, in world units: the
 * side of the cube each would have to itself in the middle 96% of the
 * centres along each axis. Not from the bound, which a few far floaters
 * make many times too large (the alley's spacing is 0.8 by the bound, 0.12 so).
 */
const typicalSpacing = (splat: Splat) => {
    const p = worldCenters(splat);
    const n = splat.splatData.numSplats;
    const step = Math.max(1, Math.floor(n / 100000));
    let volume = 1;
    for (let k = 0; k < 3; ++k) {
        const v: number[] = [];
        for (let i = 0; i < n; i += step) v.push(p[i * 3 + k]);
        v.sort((a, b) => a - b);
        volume *= Math.max(1e-6, v[Math.floor(v.length * 0.98)] - v[Math.floor(v.length * 0.02)]);
    }
    return Math.cbrt(volume * 0.96 / Math.max(1, n));
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

type KeyedHook = (op: SelectionNodeOp, key: string, frame: number) => number | undefined;
type PositionHook = (op: EditOp) => { index: number, applied: boolean };

// what the static hooks below hold. In an object of their own rather than
// as static fields: a static never assigned inside the bundle is inlined as
// its initial value by the minifier, and the hook set from outside ignored
const hooks: { keyed: KeyedHook | null, position: PositionHook | null } = { keyed: null, position: null };

abstract class SelectionNodeOp extends StateOp {
    /**
     * A keyed value of a node's parameter at a frame of the model, or
     * undefined where the parameter has no keys. Set by the keyframe work;
     * unset, every parameter is its number.
     */
    static set keyed(hook: KeyedHook | null) {
        hooks.keyed = hook;
    }

    static get keyed() {
        return hooks.keyed;
    }

    /** where an op stands in the history and whether it is applied now: set by the editor */
    static set position(hook: PositionHook | null) {
        hooks.position = hook;
    }

    static get position() {
        return hooks.position;
    }

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

/** a select node of either sort: a gesture's, or one of these */
const isSelectionSource = (op: unknown): op is SelectOp | SelectionNodeOp => {
    return op instanceof SelectOp || op instanceof SelectionNodeOp;
};

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
// select by colour

type ColourSpace = 'rgb' | 'hsv';

/** hue in degrees, saturation and value 0..1 */
const toHsv = (r: number, g: number, b: number): [number, number, number] => {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d > 0) {
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
        if (h < 0) h += 360;
    }
    return [h, max > 0 ? d / max : 0, max];
};

const decodeDc = (v: number) => Math.min(1, Math.max(0, 0.5 + v * SH_C0));

/**
 * Selects by how close a gaussian's colour is to a picked one: as a
 * distance in RGB, or by tolerances on hue, saturation and value apart, for
 * keying out a backdrop or isolating something by its colour. The colour
 * is the gaussian's own base colour, before the view-dependent part and
 * before any colour node. A 4D model is selected over all its time.
 */
class ColourSelectOp extends SelectionNodeOp {
    name = 'selectByColour';
    readonly kind = 'colour';

    space: ColourSpace;

    /** the mean colour of what came in selected, when it last ran */
    incomingMean: [number, number, number] | null = null;

    constructor(splat: Splat, space: ColourSpace = 'rgb', params: Record<string, number> = {}) {
        super(splat, { r: 0, g: 1, b: 0, tolerance: 0.2, hue: 20, saturation: 0.3, brightness: 0.3, ...params });
        this.space = space;
    }

    setSpace(space: ColourSpace) {
        this.space = space;
        this.invalidate();
    }

    protected hits(splat: Splat) {
        const data = splat.splatData;
        const n = data.numSplats;
        const out = new Uint8Array(n);
        const R = data.getProp('f_dc_0') as Float32Array;
        const G = data.getProp('f_dc_1') as Float32Array;
        const B = data.getProp('f_dc_2') as Float32Array;
        if (!R || !G || !B) return out;

        // the colour of what comes in selected, for "take from selection"
        const state = data.getProp('state') as Uint8Array;
        let sr = 0, sg = 0, sb = 0, sn = 0;
        for (let i = 0; i < n; ++i) {
            if (state[i] === State.selected) {
                sr += decodeDc(R[i]);
                sg += decodeDc(G[i]);
                sb += decodeDc(B[i]);
                sn++;
            }
        }
        this.incomingMean = sn ? [sr / sn, sg / sn, sb / sn] : null;

        const r = this.value('r'), g = this.value('g'), b = this.value('b');
        if (this.space === 'rgb') {
            const tol = this.value('tolerance');
            const tol2 = tol * tol;
            for (let i = 0; i < n; ++i) {
                const dr = decodeDc(R[i]) - r, dg = decodeDc(G[i]) - g, db = decodeDc(B[i]) - b;
                out[i] = dr * dr + dg * dg + db * db <= tol2 ? 1 : 0;
            }
            return out;
        }

        const [h0, s0, v0] = toHsv(r, g, b);
        const ht = this.value('hue'), st = this.value('saturation'), vt = this.value('brightness');
        for (let i = 0; i < n; ++i) {
            const [h, s, v] = toHsv(decodeDc(R[i]), decodeDc(G[i]), decodeDc(B[i]));
            let dh = Math.abs(h - h0);
            if (dh > 180) dh = 360 - dh;
            // hue means little where there is hardly any colour
            const hueOk = dh <= ht || (s < 0.05 && s0 < 0.05);
            out[i] = hueOk && Math.abs(s - s0) <= st && Math.abs(v - v0) <= vt ? 1 : 0;
        }
        return out;
    }

    describe() {
        const hex = [this.params.r, this.params.g, this.params.b].map(v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
        return this.space === 'rgb' ? `#${hex} ±${+this.params.tolerance.toFixed(3)}` : `#${hex} hsv`;
    }

    protected extra() {
        return { space: this.space };
    }

    restoreExtra(stored: Record<string, any>) {
        this.space = stored.space === 'hsv' ? 'hsv' : 'rgb';
    }
}

// ---------------------------------------------------------------------------
// select by region over time

type RegionShape = 'box' | 'sphere' | 'cylinder';

const REGION_KEYS = ['px', 'py', 'pz', 'rx', 'ry', 'rz', 'sx', 'sy', 'sz'];

const regionQuat = new Quat();
const regionPos = new Vec3();
const regionSize = new Vec3();

/** is a point in the unit shape: a cube of side 1, a sphere or cylinder (along y) of diameter 1 */
const inUnitShape = (shape: RegionShape, x: number, y: number, z: number) => {
    switch (shape) {
        case 'box': return Math.abs(x) <= 0.5 && Math.abs(y) <= 0.5 && Math.abs(z) <= 0.5;
        case 'sphere': return x * x + y * y + z * z <= 0.25;
        case 'cylinder': return x * x + z * z <= 0.25 && Math.abs(y) <= 0.5;
    }
};

/**
 * A box, sphere or cylinder in the world that selects what is inside it,
 * over a range of frames. Its place, turn and size are nine plain numbers,
 * so the keyframe work can key them; the node asks for them at each frame
 * of the model and tests each gaussian of a 4D model against the region as
 * it stands at that gaussian's own moment, where the gaussian is then. A
 * keyed region therefore follows a moving subject. Without keys the region
 * stands still, and a 4D model's gaussians are caught by where they are at
 * their temporal centre. Gaussians whose lifetime misses the range of
 * frames are not caught.
 */
class RegionSelectOp extends SelectionNodeOp {
    name = 'selectByRegion';
    readonly kind = 'region';

    shape: RegionShape;

    constructor(splat: Splat, shape: RegionShape = 'box', params: Record<string, number> = {}) {
        super(splat, { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, from: 0, to: -1, ...params });
        this.shape = shape;
    }

    /** A region around an object: in its middle, half as wide as it. */
    static around(splat: Splat, shape: RegionShape = 'box') {
        const bound = splat.worldBound;
        const c = bound.center;
        const h = bound.halfExtents;
        return new RegionSelectOp(splat, shape, { px: c.x, py: c.y, pz: c.z, sx: Math.max(h.x, 1e-3), sy: Math.max(h.y, 1e-3), sz: Math.max(h.z, 1e-3) });
    }

    setShape(shape: RegionShape) {
        this.shape = shape;
        this.invalidate();
    }

    /** the region at a frame of the model: unit shape to world */
    matrixAt(frame: number, out = new Mat4()) {
        const v = (k: string) => this.value(k, frame);
        regionPos.set(v('px'), v('py'), v('pz'));
        regionQuat.setFromEulerAngles(v('rx'), v('ry'), v('rz'));
        regionSize.set(v('sx') || 1e-6, v('sy') || 1e-6, v('sz') || 1e-6);
        return out.setTRS(regionPos, regionQuat, regionSize);
    }

    /** the range of model frames, `to` of -1 being the last */
    range(splat: Splat): [number, number] {
        const frames = modelFrames(splat);
        const from = Math.max(0, Math.min(frames - 1, Math.round(this.params.from)));
        const to = this.params.to < 0 ? frames - 1 : Math.max(from, Math.min(frames - 1, Math.round(this.params.to)));
        return [from, to];
    }

    // the keys the region last ran with, on a 4D model
    private ranKeys = '';

    /**
     * On a 4D model the keyed region is read per frame of the model when it
     * runs (see `hits`), so the timeline moving changes nothing; its keys
     * changing does, and has the node run again (keyframe-driver.ts).
     */
    animate(_frame: number, _later: EditOp[]) {
        // (the driver asks applied nodes only)
        if (!this.splat?.motion) return false;
        if (JSON.stringify((this as { keys?: unknown }).keys ?? null) === this.ranKeys) return false;
        this.invalidate();
        return true;
    }

    protected hits(splat: Splat) {
        this.ranKeys = JSON.stringify((this as { keys?: unknown }).keys ?? null);
        const n = splat.splatData.numSplats;
        const out = new Uint8Array(n);
        const centers = worldCenters(splat);
        const motion = splat.motion;
        const frames = modelFrames(splat);
        const [from, to] = this.range(splat);

        // the inverse of the region at each frame asked for, made once
        const keyed = this.anyKeyed(REGION_KEYS);
        const inverses = new Map<number, Float32Array>();
        const inverseAt = (frame: number) => {
            const f = keyed ? frame : 0;
            let m = inverses.get(f);
            if (!m) {
                m = new Float32Array(this.matrixAt(f).invert().data);
                inverses.set(f, m);
            }
            return m;
        };

        for (let i = 0; i < n; ++i) {
            let frame = 0;
            if (motion) {
                const { tc, reach } = lifetime(splat, i);
                // its lifetime has to meet the range of frames
                if (tc + reach < from / frames || tc - reach > to / frames) continue;
                frame = Math.max(from, Math.min(to, Math.round(tc * frames)));
            }
            const m = inverseAt(frame);
            const x = centers[i * 3], y = centers[i * 3 + 1], z = centers[i * 3 + 2];
            const lx = m[0] * x + m[4] * y + m[8] * z + m[12];
            const ly = m[1] * x + m[5] * y + m[9] * z + m[13];
            const lz = m[2] * x + m[6] * y + m[10] * z + m[14];
            out[i] = inUnitShape(this.shape, lx, ly, lz) ? 1 : 0;
        }
        return out;
    }

    describe() {
        return this.shape;
    }

    protected extra() {
        return { shape: this.shape };
    }

    restoreExtra(stored: Record<string, any>) {
        this.shape = ['box', 'sphere', 'cylinder'].includes(stored.shape) ? stored.shape : 'box';
    }
}

// ---------------------------------------------------------------------------
// select by attribute

type Attribute = 'opacity' | 'scale' | 'elongation' | 'distance' | 'density';

/** a grid cell along one axis, 0..2^17 */
const cellIndex = (v: number, cell: number) => Math.max(0, Math.min(131071, Math.floor(v / cell) + 65536));

/** the uniform scale of a world transform: how long its x axis is */
const worldScale = (m: Mat4) => Math.hypot(m.data[0], m.data[1], m.data[2]);

/**
 * Selects by a measure of each gaussian against a range: how opaque it is,
 * how large (its longest axis, in world units), how elongated (longest
 * over shortest axis - the needles), how far from a camera position, or
 * how dense its neighbourhood is (how many gaussians share its cell of a
 * grid). The node pane draws the measure as a histogram to pick the range
 * from. Floaters are faint, large or alone; needles are elongated.
 */
class AttributeSelectOp extends SelectionNodeOp {
    name = 'selectByAttribute';
    readonly kind = 'attribute';

    attribute: Attribute;

    constructor(splat: Splat, attribute: Attribute = 'opacity', params: Record<string, number> = {}) {
        super(splat, { min: 0, max: 0.1, cx: 0, cy: 0, cz: 0, cell: 0, ...params });
        this.attribute = attribute;
    }

    /** a node that measures from where the camera stands now */
    static fromView(splat: Splat) {
        const op = new AttributeSelectOp(splat);
        op.takeCamera();
        return op;
    }

    takeCamera() {
        const p = this.splat?.scene?.camera?.position;
        if (!p) return;
        this.params.cx = p.x;
        this.params.cy = p.y;
        this.params.cz = p.z;
        this.invalidate();
    }

    /** whether the measure reads best on a log scale */
    get logScale() {
        return this.attribute === 'scale' || this.attribute === 'elongation' || this.attribute === 'density';
    }

    /** a range that suits the attribute, for when it is changed */
    static defaults(attribute: Attribute): [number, number] {
        switch (attribute) {
            case 'opacity': return [0, 0.1];
            case 'scale': return [0.1, 1e6];
            case 'elongation': return [10, 1e6];
            case 'distance': return [0, 10];
            case 'density': return [0, 2];
        }
    }

    setAttribute(attribute: Attribute) {
        this.attribute = attribute;
        [this.params.min, this.params.max] = AttributeSelectOp.defaults(attribute);
        this.invalidate();
    }

    /** the grid cell the density is counted in: the setting, or about 8 gaussians a cell */
    cellSize(splat: Splat) {
        return this.params.cell > 0 ? this.params.cell : typicalSpacing(splat) * 2;
    }

    /** the measure per gaussian: what the node selects on, and the histogram's data */
    values(splat: Splat): Float32Array {
        const data = splat.splatData;
        const n = data.numSplats;
        const out = new Float32Array(n);
        const s = worldScale(splat.worldTransform);
        switch (this.attribute) {
            case 'opacity': {
                const o = data.getProp('opacity') as Float32Array;
                for (let i = 0; i < n; ++i) out[i] = o ? sigmoid(o[i]) : 1;
                break;
            }
            case 'scale':
            case 'elongation': {
                const a = data.getProp('scale_0') as Float32Array;
                const b = data.getProp('scale_1') as Float32Array;
                const c = data.getProp('scale_2') as Float32Array;
                if (!a || !b || !c) break;
                for (let i = 0; i < n; ++i) {
                    // scales are stored as logs
                    const hi = Math.max(a[i], b[i], c[i]);
                    const lo = Math.min(a[i], b[i], c[i]);
                    out[i] = this.attribute === 'scale' ? Math.exp(hi) * s : Math.exp(hi - lo);
                }
                break;
            }
            case 'distance': {
                const p = worldCenters(splat);
                const { cx, cy, cz } = this.params;
                for (let i = 0; i < n; ++i) out[i] = Math.hypot(p[i * 3] - cx, p[i * 3 + 1] - cy, p[i * 3 + 2] - cz);
                break;
            }
            case 'density': {
                const p = worldCenters(splat);
                const cell = this.cellSize(splat);
                const keys = new Float64Array(n);
                const counts = new Map<number, number>();
                for (let i = 0; i < n; ++i) {
                    // one number per cell, exact: 17 bits an axis
                    const k = cellIndex(p[i * 3], cell) * 17179869184 + cellIndex(p[i * 3 + 1], cell) * 131072 + cellIndex(p[i * 3 + 2], cell);
                    keys[i] = k;
                    counts.set(k, (counts.get(k) ?? 0) + 1);
                }
                for (let i = 0; i < n; ++i) out[i] = counts.get(keys[i]);
                break;
            }
        }
        return out;
    }

    protected hits(splat: Splat) {
        const v = this.values(splat);
        const lo = this.value('min');
        const hi = this.value('max');
        const out = new Uint8Array(v.length);
        for (let i = 0; i < v.length; ++i) out[i] = v[i] >= lo && v[i] <= hi ? 1 : 0;
        return out;
    }

    describe() {
        const f = (v: number) => (v >= 1e6 ? '∞' : `${+v.toPrecision(3)}`);
        return `${this.attribute} ${f(this.params.min)}–${f(this.params.max)}`;
    }

    protected extra() {
        return { attribute: this.attribute };
    }

    restoreExtra(stored: Record<string, any>) {
        this.attribute = ['opacity', 'scale', 'elongation', 'distance', 'density'].includes(stored.attribute) ? stored.attribute : 'opacity';
    }
}

// ---------------------------------------------------------------------------
// grow / shrink selection

type GrowDirection = 'grow' | 'shrink';

/**
 * For each gaussian of `from`, mark the gaussians of `to` within `radius`
 * of it (and near it in time, for a 4D model). The pair is symmetric, so
 * the smaller set is walked and the larger put in a hashed grid of cells a
 * radius wide: every neighbour is then in one of 27 cells.
 */
const markNear = (
    centers: Float32Array,
    from: Uint8Array,
    to: Uint8Array,
    radius: number,
    near: (i: number, j: number) => boolean
): Uint8Array => {
    const n = from.length;
    const marked = new Uint8Array(n);
    let nf = 0, nt = 0;
    for (let i = 0; i < n; ++i) {
        nf += from[i];
        nt += to[i];
    }
    if (!nf || !nt || !(radius > 0)) return marked;

    // walk the smaller set; the grid holds the larger
    const walkFrom = nf <= nt;
    const walk = walkFrom ? from : to;
    const grid = walkFrom ? to : from;
    const m = walkFrom ? nf : nt;
    const gridCount = walkFrom ? nt : nf;

    let size = 1;
    while (size < gridCount * 2) size <<= 1;
    const mask = size - 1;
    const head = new Int32Array(size).fill(-1);
    const next = new Int32Array(n).fill(-1);
    const cellOf = (v: number) => Math.floor(v / radius);
    const hash = (x: number, y: number, z: number) => (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & mask;

    for (let i = 0; i < n; ++i) {
        if (!grid[i]) continue;
        const h = hash(cellOf(centers[i * 3]), cellOf(centers[i * 3 + 1]), cellOf(centers[i * 3 + 2]));
        next[i] = head[h];
        head[h] = i;
    }

    const r2 = radius * radius;

    // the grid's gaussians near gaussian i, each handed to `visit` until it
    // says it has seen enough
    const around = (i: number, visit: (j: number) => boolean) => {
        const x = centers[i * 3], y = centers[i * 3 + 1], z = centers[i * 3 + 2];
        const cx = cellOf(x), cy = cellOf(y), cz = cellOf(z);
        for (let dx = -1; dx <= 1; ++dx) {
            for (let dy = -1; dy <= 1; ++dy) {
                for (let dz = -1; dz <= 1; ++dz) {
                    for (let j = head[hash(cx + dx, cy + dy, cz + dz)]; j !== -1; j = next[j]) {
                        const ex = centers[j * 3] - x, ey = centers[j * 3 + 1] - y, ez = centers[j * 3 + 2] - z;
                        if (ex * ex + ey * ey + ez * ez <= r2 && near(i, j) && visit(j)) return;
                    }
                }
            }
        }
    };

    let walked = 0;
    for (let i = 0; i < n && walked < m; ++i) {
        if (!walk[i]) continue;
        walked++;
        if (walkFrom) {
            // the members of `to` near this one of `from`
            around(i, (j) => {
                marked[j] = 1;
                return false;
            });
        } else {
            // whether this member of `to` is near any of `from`
            around(i, () => {
                marked[i] = 1;
                return true;
            });
        }
    }
    return marked;
};

/**
 * Grows the selection coming in by the gaussians within a distance of it,
 * or shrinks it by those of it within that distance of the rest, a number
 * of times over. On a 4D model two gaussians are neighbours only when
 * their lifetimes meet, widened by a number of frames to reach across
 * frames; each is where it is at its own temporal centre.
 */
class GrowSelectOp extends SelectionNodeOp {
    name = 'growSelection';
    readonly kind = 'grow';

    direction: GrowDirection;

    constructor(splat: Splat, direction: GrowDirection = 'grow', params: Record<string, number> = {}) {
        super(splat, { radius: 0.05, steps: 1, frames: 0, ...params });
        this.direction = direction;
    }

    /** a node whose distance suits the object: twice its typical spacing */
    static forObject(splat: Splat) {
        return new GrowSelectOp(splat, 'grow', { radius: +(typicalSpacing(splat) * 2).toPrecision(2) });
    }

    setDirection(direction: GrowDirection) {
        this.direction = direction;
        this.invalidate();
    }

    protected hits(splat: Splat) {
        const n = splat.splatData.numSplats;
        const state = splat.splatData.getProp('state') as Uint8Array;
        const centers = worldCenters(splat);

        let near = (_i: number, _j: number) => true;
        if (splat.motion) {
            const tc = new Float32Array(n);
            const reach = new Float32Array(n);
            for (let i = 0; i < n; ++i) {
                const l = lifetime(splat, i);
                tc[i] = l.tc;
                reach[i] = Math.min(l.reach, 1e6);
            }
            const widen = Math.max(0, this.value('frames')) / modelFrames(splat);
            near = (i, j) => Math.abs(tc[i] - tc[j]) <= reach[i] + reach[j] + widen;
        }

        const selected = new Uint8Array(n);
        const rest = new Uint8Array(n);
        for (let i = 0; i < n; ++i) {
            if (!reachable(state, i)) continue;
            if (state[i] & State.selected) selected[i] = 1;
            else rest[i] = 1;
        }

        const radius = this.value('radius');
        const steps = Math.max(1, Math.min(20, Math.round(this.value('steps'))));
        for (let s = 0; s < steps; ++s) {
            if (this.direction === 'grow') {
                const added = markNear(centers, selected, rest, radius, near);
                let any = 0;
                for (let i = 0; i < n; ++i) {
                    if (added[i]) {
                        selected[i] = 1;
                        rest[i] = 0;
                        any++;
                    }
                }
                if (!any) break;
            } else {
                const dropped = markNear(centers, rest, selected, radius, near);
                let any = 0;
                for (let i = 0; i < n; ++i) {
                    if (dropped[i]) {
                        selected[i] = 0;
                        rest[i] = 1;
                        any++;
                    }
                }
                if (!any) break;
            }
        }
        return selected;
    }

    describe() {
        const steps = Math.round(this.params.steps);
        return `${this.direction} ${+this.params.radius.toPrecision(3)}${steps > 1 ? ` ×${steps}` : ''}`;
    }

    protected extra() {
        return { direction: this.direction };
    }

    restoreExtra(stored: Record<string, any>) {
        this.direction = stored.direction === 'shrink' ? 'shrink' : 'grow';
    }
}

// ---------------------------------------------------------------------------
// invert / combine selections

type CombineOperation = 'union' | 'intersect' | 'difference' | 'invert';

type SelectionSource = SelectOp | SelectionNodeOp;

/**
 * Combines the selections of other select nodes of the object: union,
 * intersection, difference (a without b) and inversion (all but a). Its
 * two inputs, a and b, take the wire of a select node - a gesture's or a
 * rule's - or are picked from the named select nodes above it in the pane.
 * An input left empty is the selection coming in, so with only b wired a
 * union adds b to what is selected, and an inversion with nothing wired
 * inverts what is selected. What a wired node selected is what it left
 * selected when it ran; an input whose node is undone, bypassed, after
 * this one or on another object counts as empty.
 */
class CombineSelectOp extends SelectionNodeOp {
    name = 'combineSelections';
    readonly kind = 'combine';

    operation: CombineOperation;
    a: SelectionSource | null = null;
    b: SelectionSource | null = null;

    constructor(splat: Splat, operation: CombineOperation = 'union') {
        super(splat, {});
        this.operation = operation;
    }

    get ports(): PortSpec[] {
        return [
            { name: 'a', label: 'a', accepts: ['selection'], source: this.a },
            { name: 'b', label: 'b', accepts: ['selection'], source: this.b }
        ];
    }

    setOperation(operation: CombineOperation) {
        this.operation = operation;
        this.invalidate();
    }

    connect(port: string, source: SelectionSource | null) {
        if (port === 'a') this.a = source;
        if (port === 'b') this.b = source;
        this.invalidate();
    }

    /** whether a wired node's selection can be read: applied, ahead of this one, same object */
    usable(source: SelectionSource | null) {
        if (!source || source === (this as unknown) || source.splat !== this.splat || !source.result) return false;
        const at = SelectionNodeOp.position;
        if (!at) return true;
        const s = at(source);
        const me = at(this);
        return s.applied && (me.index < 0 || s.index < me.index);
    }

    protected hits(splat: Splat) {
        const n = splat.splatData.numSplats;
        const state = splat.splatData.getProp('state') as Uint8Array;
        const incoming = new Uint8Array(n);
        for (let i = 0; i < n; ++i) incoming[i] = (state[i] & State.selected) ? 1 : 0;

        const read = (source: SelectionSource | null) => {
            if (!source) return incoming;
            const out = new Uint8Array(n);
            if (!this.usable(source)) {
                this.warning = 'node.selcombine.unusable';
                return out;
            }
            source.result.forEach((i) => {
                if (i < n) out[i] = 1;
            });
            return out;
        };
        const A = read(this.a);
        const B = read(this.b);

        const out = new Uint8Array(n);
        for (let i = 0; i < n; ++i) {
            switch (this.operation) {
                case 'union': out[i] = A[i] | B[i]; break;
                case 'intersect': out[i] = A[i] & B[i]; break;
                case 'difference': out[i] = A[i] & (B[i] ^ 1); break;
                case 'invert': out[i] = A[i] ^ 1; break;
            }
        }
        return out;
    }

    /** what an input is called: its node's name, or what it selects by */
    static nameOf(source: SelectionSource | null) {
        if (!source) return 'in';
        if (source instanceof SelectionNodeOp) return source.label || source.describe();
        return 'select';
    }

    describe() {
        const a = CombineSelectOp.nameOf(this.a);
        const b = CombineSelectOp.nameOf(this.b);
        switch (this.operation) {
            case 'union': return `${a} ∪ ${b}`;
            case 'intersect': return `${a} ∩ ${b}`;
            case 'difference': return `${a} − ${b}`;
            case 'invert': return `¬ ${a}`;
        }
    }

    protected extra() {
        return { operation: this.operation };
    }

    restoreExtra(stored: Record<string, any>) {
        this.operation = ['union', 'intersect', 'difference', 'invert'].includes(stored.operation) ? stored.operation : 'union';
    }

    /** wire the inputs again on load, from the nodes restored before it */
    rewire(lookup: (at: unknown) => unknown, stored: Record<string, any>) {
        const take = (v: unknown) => (isSelectionSource(v) ? v : null);
        this.a = take(lookup(stored.aAt));
        this.b = take(lookup(stored.bAt));
    }

    destroy() {
        super.destroy();
        this.a = null;
        this.b = null;
    }
}

// ---------------------------------------------------------------------------
// the nodes, by kind

// the kinds built, in menu order
const SELECTION_NODE_KINDS: SelectionNodeKind[] = ['motion', 'colour', 'region', 'attribute', 'grow', 'combine'];

/** the op name each kind goes by, for the graph's labels */
const SELECTION_NODE_NAMES: Record<SelectionNodeKind, string> = {
    motion: 'selectByMotion',
    colour: 'selectByColour',
    region: 'selectByRegion',
    attribute: 'selectByAttribute',
    grow: 'growSelection',
    combine: 'combineSelections'
};

/** A new node of a kind, with its defaults; null for a kind not built yet. */
const makeSelectionNode = (kind: string, splat: Splat): SelectionNodeOp | null => {
    switch (kind) {
        case 'motion': return new MotionSelectOp(splat);
        case 'colour': return new ColourSelectOp(splat);
        case 'region': return RegionSelectOp.around(splat);
        case 'attribute': return AttributeSelectOp.fromView(splat);
        case 'grow': return GrowSelectOp.forObject(splat);
        case 'combine': return new CombineSelectOp(splat);
        default: return null;
    }
};

/** a holdout node, which these menus offer too, or one of the rule nodes */
const makeMaskingNode = (kind: string, splat: Splat): StateOp | null => {
    return kind === 'holdout' ? new HoldoutOp(splat) : makeSelectionNode(kind, splat);
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
    ColourSelectOp,
    type ColourSpace,
    RegionSelectOp,
    type RegionShape,
    AttributeSelectOp,
    type Attribute,
    GrowSelectOp,
    type GrowDirection,
    CombineSelectOp,
    type CombineOperation,
    SELECTION_NODE_KINDS,
    SELECTION_NODE_NAMES,
    isSelectionSource,
    makeSelectionNode,
    makeMaskingNode,
    selectionNodeFrom,
    worldCenters,
    modelFrames,
    lifetime,
    reachable,
    sigmoid,
    SH_C0,
    FADE_CUT
};
