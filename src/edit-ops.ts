import { Color, Mat4, Quat, Vec3 } from 'playcanvas';

import { AnimTrack } from './anim-track';
import { BoxShape } from './box-shape';
import { GradeParams, gradeMatrix } from './color-grade';
import { composeGrades, toGrade } from './grade-palette';
import { IndexRanges } from './index-ranges';
import { Pivot } from './pivot';
import { Scene } from './scene';
import { SelectQuery, resolveHits } from './select-query';
import { SphereShape } from './sphere-shape';
import { Splat } from './splat';
import { State } from './splat-state';
import { Transform } from './transform';
import { Voxels } from './voxels';

interface EditOp {
    name: string;
    do(): void | Promise<void>;
    undo(): void | Promise<void>;
    destroy?(): void;
    /**
     * Skip this op when the history is replayed, without removing it.
     *
     * The history walks past a bypassed op rather than applying it, so the
     * cursor still counts it and everything downstream re-resolves as though
     * the edit had not been made. Toggling it winds the history back first -
     * see EditHistory.setBypassed - because an op that is already applied has
     * to be reversed while it can still reverse itself.
     */
    bypassed?: boolean;
}

const enum BitOp {
    SET,
    CLEAR,
    TOGGLE
}

/**
 * Sets, clears or toggles a state bit over a set of splats.
 *
 * The set is resolved lazily. These ops describe themselves relative to the
 * state they run against - "delete what is selected", "select what this sphere
 * catches" - so resolving at construction froze an answer to a question that
 * had not been asked yet. Deferring it to `do()` is what lets an edit earlier
 * in the history change and everything after it still mean what it says.
 *
 * The resolved ranges are kept afterwards, because `undo` has to reverse
 * exactly what `do` applied, not what the same question would answer now.
 * `invalidate()` drops them so the next `do()` asks again.
 */
class StateOp {
    /** set by each subclass; declared here so the base satisfies EditOp */
    name: string;
    splat: Splat;
    mask: number;
    op: BitOp;
    updateFlags: number;

    // protected so a subclass whose resolver needs to read its own fields can
    // install it after super() has run
    protected resolver: (splat: Splat) => IndexRanges | Promise<IndexRanges>;
    private ranges: IndexRanges = null;

    constructor(
        splat: Splat,
        resolver: (splat: Splat) => IndexRanges | Promise<IndexRanges>,
        mask: number,
        op: BitOp,
        updateFlags = State.selected
    ) {
        this.splat = splat;
        this.resolver = resolver;
        this.mask = mask;
        this.op = op;
        this.updateFlags = updateFlags;
    }

    /**
     * How many splats this op last applied to, or -1 if it has not run.
     *
     * Read from what was resolved rather than recomputed, so it says what the
     * op actually did rather than what it would do now.
     */
    get affected(): number {
        if (!this.ranges) return -1;
        let n = 0;
        this.ranges.forEach(() => n++);
        return n;
    }

    /** Resolve now and keep the answer - for callers that must know the set up front. */
    resolveNow(): IndexRanges {
        if (!this.ranges) {
            const resolved = this.resolver(this.splat);
            if (resolved instanceof Promise) {
                throw new Error('resolveNow called on an op that resolves asynchronously');
            }
            this.ranges = resolved;
        }
        return this.ranges;
    }

    /** Forget the resolved set so the next do() recomputes it. */
    invalidate() {
        this.ranges = null;
    }

    private apply(op: BitOp) {
        const { state } = this.splat;
        const { mask, ranges } = this;

        switch (op) {
            case BitOp.SET:
                state.setBits(ranges, mask);
                break;
            case BitOp.CLEAR:
                state.clearBits(ranges, mask);
                break;
            case BitOp.TOGGLE:
                state.toggleBits(ranges, mask);
                break;
        }
    }

    async do() {
        if (!this.ranges) {
            this.ranges = await this.resolver(this.splat);
        }
        this.apply(this.op);
        await this.splat.updateState(this.updateFlags);
    }

    async undo() {
        // nothing resolved means nothing was applied, so there is nothing to
        // reverse. Without this an invalidated op would hand a null set to the
        // bit operations rather than simply doing nothing.
        if (!this.ranges) return;

        const undoOp = this.op === BitOp.TOGGLE ? BitOp.TOGGLE :
            this.op === BitOp.SET ? BitOp.CLEAR : BitOp.SET;
        this.apply(undoOp);
        await this.splat.updateState(this.updateFlags);
    }

    destroy() {
        this.splat = null;
        this.ranges = null;
        this.resolver = null;
    }
}

// Each of these is a predicate over the state as it stands when the op runs.
// Wrapping it in a closure rather than evaluating it here is the whole point:
// the question is asked at do() time, so it answers about the state the op
// actually lands on.
const overState = (pred: (state: Uint8Array, i: number) => boolean) => {
    return (splat: Splat) => {
        const state = splat.splatData.getProp('state') as Uint8Array;
        return IndexRanges.fromPredicate(splat.splatData.numSplats, i => pred(state, i));
    };
};

class SelectAllOp extends StateOp {
    name = 'selectAll';

    constructor(splat: Splat) {
        super(splat, overState((state, i) => state[i] === 0), State.selected, BitOp.SET);
    }
}

class SelectNoneOp extends StateOp {
    name = 'selectNone';

    constructor(splat: Splat) {
        super(splat, overState((state, i) => state[i] === State.selected), State.selected, BitOp.CLEAR);
    }
}

class SelectInvertOp extends StateOp {
    name = 'selectInvert';

    constructor(splat: Splat) {
        super(splat, overState((state, i) => (state[i] & (State.locked | State.deleted)) === 0), State.selected, BitOp.TOGGLE);
    }
}

type SelectMode = 'add' | 'remove' | 'set' | 'intersect';

/**
 * Combine a hit set with the current selection state.
 *
 * `mode` semantics:
 *   add       — select valid splats that are hit and currently unselected
 *   remove    — deselect valid splats that are hit and currently selected
 *   set       — make selection match the hit set (toggle valid splats whose
 *               current selection state differs from it). NOT a replace — the
 *               underlying BitOp is TOGGLE on the rows where selection and hit
 *               disagree, which leaves locked/deleted bits untouched.
 *   intersect — keep only splats currently selected AND hit (clear the selected
 *               bit on selected splats that are not hit).
 */
const combineWithState = (splat: Splat, mode: SelectMode, isHit: (i: number) => boolean) => {
    const splatData = splat.splatData;
    const state = splatData.getProp('state') as Uint8Array;

    // single rule applied uniformly: only valid (clean or selected) splats are
    // considered. consolidates the locked/deleted guard in one place so each
    // producer doesn't have to remember it for the 'set' (toggle) path.
    const valid = (i: number) => state[i] === 0 || state[i] === State.selected;

    const preds: Record<SelectMode, (i: number) => boolean> = {
        add: (i: number) => valid(i) && isHit(i) && state[i] === 0,
        remove: (i: number) => valid(i) && isHit(i) && state[i] === State.selected,
        set: (i: number) => valid(i) && ((state[i] === State.selected) !== isHit(i)),
        intersect: (i: number) => valid(i) && state[i] === State.selected && !isHit(i)
    };

    return IndexRanges.fromPredicate(splatData.numSplats, preds[mode]);
};

/** One gesture inside a selection: what was drawn, and how it combined. */
type SelectStep = { mode: SelectMode; query: SelectQuery };

/**
 * A selection node.
 *
 * It holds a list of steps rather than a single query, because refining a
 * selection - drawing, then shift-drawing to extend, then ctrl-drawing to trim
 * - is one act of selecting, not three edits. Each gesture adds a step to the
 * node being worked on, so the graph gains a node when you decide it should,
 * not every time the selection moves.
 *
 * However many steps it has, the op means one thing: "the selection is this
 * afterwards". The steps are folded into a desired set, starting from whatever
 * was selected before the op, and applied as a difference against it. So the
 * bit operation is always a toggle, and add/remove/intersect live inside the
 * fold rather than in how the result is written.
 */
class SelectOp extends StateOp {
    name = 'selectOp';

    steps: SelectStep[];

    constructor(splat: Splat, steps: SelectStep[]) {
        // TOGGLE, always: the op states the result, not the gesture
        super(splat, null, State.selected, BitOp.TOGGLE);
        this.steps = steps;

        // reads this.steps rather than the constructor argument, so editing the
        // list changes what the next resolve asks
        this.resolver = async (s: Splat) => {
            const numSplats = s.splatData.numSplats;
            const state = s.splatData.getProp('state') as Uint8Array;

            // start from the selection as it stands going in, so a first step
            // of 'add' extends what was there rather than replacing it
            const desired = new Uint8Array(numSplats);
            for (let i = 0; i < numSplats; ++i) {
                desired[i] = (state[i] & State.selected) ? 1 : 0;
            }

            for (const step of this.steps) {
                // one pass per step, ascending, which is what a hit predicate
                // requires - each step gets a fresh one
                const isHit = await resolveHits(s, step.query);
                for (let i = 0; i < numSplats; ++i) {
                    const hit = isHit(i);
                    switch (step.mode) {
                        case 'set': desired[i] = hit ? 1 : 0; break;
                        case 'add': if (hit) desired[i] = 1; break;
                        case 'remove': if (hit) desired[i] = 0; break;
                        case 'intersect': if (!hit) desired[i] = 0; break;
                    }
                }
            }

            return combineWithState(s, 'set', i => desired[i] === 1);
        };
    }

    /** The last gesture, which is what the node is labelled by. */
    get query(): SelectQuery | null {
        return this.steps.length ? this.steps[this.steps.length - 1].query : null;
    }

    get mode(): SelectMode {
        return this.steps.length ? this.steps[this.steps.length - 1].mode : 'set';
    }

    /**
     * Fold a gesture in.
     *
     * A 'set' says what the selection is outright, so everything before it in
     * this node no longer contributes and is dropped - refining a fresh
     * selection leaves one step, not a pile of them.
     */
    addStep(step: SelectStep) {
        this.steps = step.mode === 'set' ? [step] : [...this.steps, step];
        this.invalidate();
    }

    setSteps(steps: SelectStep[]) {
        this.steps = steps;
        this.invalidate();
    }
}

class HideSelectionOp extends StateOp {
    name = 'hideSelection';

    constructor(splat: Splat) {
        super(splat, overState((state, i) => state[i] === State.selected), State.locked, BitOp.SET, State.locked);
    }
}

class UnhideAllOp extends StateOp {
    name = 'unhideAll';

    constructor(splat: Splat) {
        super(splat, overState((state, i) => (state[i] & (State.locked | State.deleted)) === State.locked), State.locked, BitOp.CLEAR, State.locked);
    }
}

class DeleteSelectionOp extends StateOp {
    name = 'deleteSelection';

    constructor(splat: Splat) {
        super(splat, overState((state, i) => state[i] === State.selected), State.deleted, BitOp.SET, State.deleted);
    }
}

class ResetOp extends StateOp {
    name = 'reset';

    constructor(splat: Splat) {
        super(splat, overState((state, i) => (state[i] & State.deleted) !== 0), State.deleted, BitOp.CLEAR, State.deleted);
    }
}

// op for modifying a splat transform
class EntityTransformOp {
    name = 'entityTransform';
    splat: Splat;
    oldt: Transform;
    newt: Transform;

    constructor(options: { splat: Splat, oldt: Transform, newt: Transform }) {
        this.splat = options.splat;
        this.oldt = options.oldt;
        this.newt = options.newt;
    }

    do() {
        this.splat.move(this.newt.position, this.newt.rotation, this.newt.scale);
    }

    undo() {
        this.splat.move(this.oldt.position, this.oldt.rotation, this.oldt.scale);
    }

    destroy() {
        this.splat = null;
        this.oldt = null;
        this.newt = null;
    }
}

const mat = new Mat4();

// op for modifying a subset of individual splats
class SplatsTransformOp {
    name = 'splatsTransform';

    splat: Splat;
    transform: Mat4;
    paletteMap: Map<number, number>;

    constructor(options: { splat: Splat, transform: Mat4, paletteMap: Map<number, number> }) {
        this.splat = options.splat;
        this.transform = options.transform;
        this.paletteMap = options.paletteMap;
    }

    async do() {
        const { splat, transform, paletteMap } = this;
        const state = splat.splatData.getProp('state') as Uint8Array;
        const indices = splat.transformTexture.lock() as Uint16Array;

        // update splat transform palette indices
        for (let i = 0; i < state.length; ++i) {
            if (state[i] === State.selected) {
                indices[i] = paletteMap.get(indices[i]);
            }
        }

        splat.transformTexture.unlock();

        splat.transformPalette.alloc(paletteMap.size);

        // update transform palette
        const { transformPalette } = splat;
        this.paletteMap.forEach((newIdx, oldIdx) => {
            transformPalette.getTransform(oldIdx, mat);
            mat.mul2(transform, mat);
            transformPalette.setTransform(newIdx, mat);
        });

        await splat.updatePositions();
    }

    async undo() {
        const { splat, paletteMap } = this;
        const state = splat.splatData.getProp('state') as Uint8Array;
        const indices = splat.transformTexture.lock() as Uint16Array;

        // invert the palette map
        const inverseMap = new Map<number, number>();
        paletteMap.forEach((newIdx, oldIdx) => {
            inverseMap.set(newIdx, oldIdx);
        });

        // restore the original transform indices
        for (let i = 0; i < state.length; ++i) {
            if (state[i] === State.selected) {
                indices[i] = inverseMap.get(indices[i]);
            }
        }

        splat.transformTexture.unlock();

        splat.transformPalette.free(paletteMap.size);

        await splat.updatePositions();
    }

    destroy() {
        this.splat = null;
        this.transform = null;
        this.paletteMap = null;
    }
}

class PlacePivotOp {
    name = 'setPivot';
    pivot: Pivot;
    oldt: Transform;
    newt: Transform;

    constructor(options: { pivot: Pivot, oldt: Transform, newt: Transform }) {
        this.pivot = options.pivot;
        this.oldt = options.oldt;
        this.newt = options.newt;
    }

    do() {
        this.pivot.place(this.newt);
    }

    undo() {
        this.pivot.place(this.oldt);
    }
}

// op for setting a splat's user-defined local frame (the origin and rotation
// the transform gizmos and panel use in local coordinate space)
class SetLocalFrameOp {
    name = 'setLocalFrame';
    splat: Splat;
    oldOrigin: Vec3;
    oldFrame: Quat;
    newOrigin: Vec3;
    newFrame: Quat;

    constructor(options: { splat: Splat, oldOrigin: Vec3, oldFrame: Quat, newOrigin: Vec3, newFrame: Quat }) {
        this.splat = options.splat;
        this.oldOrigin = options.oldOrigin;
        this.oldFrame = options.oldFrame;
        this.newOrigin = options.newOrigin;
        this.newFrame = options.newFrame;
    }

    do() {
        this.splat.setLocalFrame(this.newOrigin, this.newFrame);
    }

    undo() {
        this.splat.setLocalFrame(this.oldOrigin, this.oldFrame);
    }

    destroy() {
        this.splat = null;
        this.oldOrigin = null;
        this.oldFrame = null;
        this.newOrigin = null;
        this.newFrame = null;
    }
}

type ShapeTransformState = {
    position: Vec3;
    rotation?: Quat;
    lens?: Vec3;        // box lengths
    radius?: number;    // sphere radius
};

// moves/rotates/resizes a box/sphere selection volume
class ShapeTransformOp {
    name = 'shapeTransform';
    shape: BoxShape | SphereShape;
    oldState: ShapeTransformState;
    newState: ShapeTransformState;

    constructor(options: { shape: BoxShape | SphereShape, oldState: ShapeTransformState, newState: ShapeTransformState }) {
        this.shape = options.shape;
        this.oldState = options.oldState;
        this.newState = options.newState;
    }

    apply(state: ShapeTransformState) {
        const { shape } = this;
        shape.pivot.setPosition(state.position);
        if (state.rotation) {
            shape.pivot.setRotation(state.rotation);
        }
        if (shape instanceof BoxShape && state.lens) {
            // the length setters refresh the bound with the new transform
            shape.lenX = state.lens.x;
            shape.lenY = state.lens.y;
            shape.lenZ = state.lens.z;
        } else if (shape instanceof SphereShape && state.radius !== undefined) {
            // the radius setter refreshes the bound with the new transform
            shape.radius = state.radius;
        } else {
            shape.moved();
        }

        // refresh the owning tool's ui. shape ops are purged from history when
        // the tool deactivates, so the shape is normally in the scene here; the
        // guard covers the brief window where an already-queued undo/redo runs
        // after a synchronous deactivate.
        shape.scene?.events.fire('shapeSelection.changed', shape);
    }

    do() {
        this.apply(this.newState);
    }

    undo() {
        this.apply(this.oldState);
    }
}

type ColorAdjustment = {
    tintClr?: Color
    temperature?: number,
    saturation?: number,
    exposure?: number,
    brightness?: number,
    blackPoint?: number,
    whitePoint?: number,
    transparency?: number
};

class SetSplatColorAdjustmentOp {
    name = 'setSplatColor';
    splat: Splat;

    newState: ColorAdjustment;
    oldState: ColorAdjustment;

    constructor(options: { splat: Splat, oldState: ColorAdjustment, newState: ColorAdjustment }) {
        const { splat, oldState, newState } = options;
        this.splat = splat;
        this.oldState = oldState;
        this.newState = newState;
    }

    do() {
        const { splat } = this;
        const { tintClr, temperature, saturation, exposure, brightness, blackPoint, whitePoint, transparency } = this.newState;
        if (tintClr) splat.tintClr = tintClr;
        if (temperature !== null) splat.temperature = temperature;
        if (saturation !== null) splat.saturation = saturation;
        if (exposure !== null) splat.exposure = exposure;
        if (brightness !== null) splat.brightness = brightness;
        if (blackPoint !== null) splat.blackPoint = blackPoint;
        if (whitePoint !== null) splat.whitePoint = whitePoint;
        if (transparency !== null) splat.transparency = transparency;
    }

    undo() {
        const { splat } = this;
        const { tintClr, temperature, saturation, exposure, brightness, blackPoint, whitePoint, transparency } = this.oldState;
        if (tintClr) splat.tintClr = tintClr;
        if (temperature !== null) splat.temperature = temperature;
        if (saturation !== null) splat.saturation = saturation;
        if (exposure !== null) splat.exposure = exposure;
        if (brightness !== null) splat.brightness = brightness;
        if (blackPoint !== null) splat.blackPoint = blackPoint;
        if (whitePoint !== null) splat.whitePoint = whitePoint;
        if (transparency !== null) splat.transparency = transparency;
    }
}

/**
 * A colour grade over the selected gaussians rather than the whole object.
 *
 * Works the way SplatsTransformOp does, and for the same reason. The gaussians
 * being graded may already sit on different palette slots - an earlier colour
 * node put some of them there - so rather than one new slot there is one per
 * distinct slot found, each holding that slot's grade composed with this
 * node's. The map from old slot to new is what undo runs backwards.
 *
 * The selection is read when the op applies, not when it was made, so a
 * selection node above this one can change and the grade follows.
 */
class ScopedColorOp {
    name = 'scopedColor';

    splat: Splat;
    grade: GradeParams;

    /** old palette slot -> the slot holding it composed with this grade */
    private paletteMap: Map<number, number> = null;

    constructor(splat: Splat, grade: GradeParams) {
        this.splat = splat;
        this.grade = grade;
    }

    setGrade(grade: GradeParams) {
        this.grade = grade;
    }

    /** How many gaussians the last application covered, or -1. */
    get affected(): number {
        if (!this.paletteMap) return -1;
        const state = this.splat.splatData.getProp('state') as Uint8Array;
        let n = 0;
        for (let i = 0; i < state.length; ++i) {
            if ((state[i] & State.selected) !== 0) n++;
        }
        return n;
    }

    do() {
        const { splat } = this;
        const state = splat.splatData.getProp('state') as Uint8Array;
        const numSplats = splat.splatData.numSplats;
        const indices = splat.gradeTexture.lock() as Uint16Array;
        const palette = splat.gradePalette;

        const mine = toGrade(gradeMatrix(this.grade));
        const map = new Map<number, number>();

        // which slots the selection currently sits on
        for (let i = 0; i < numSplats; ++i) {
            if ((state[i] & State.selected) === 0) continue;
            if (!map.has(indices[i])) map.set(indices[i], -1);
        }

        // one new slot per old one, holding the two grades composed
        [...map.keys()].forEach((old) => {
            const slot = palette.alloc();
            palette.setGrade(slot, composeGrades(palette.getGrade(old), mine));
            map.set(old, slot);
        });

        for (let i = 0; i < numSplats; ++i) {
            if ((state[i] & State.selected) === 0) continue;
            indices[i] = map.get(indices[i]);
        }

        splat.gradeTexture.unlock();
        this.paletteMap = map;
        splat.scene.forceRender = true;
    }

    undo() {
        if (!this.paletteMap) return;

        const { splat } = this;
        const indices = splat.gradeTexture.lock() as Uint16Array;

        // Reverse by slot rather than by selection: what has to be put back is
        // exactly what was moved, and the selection may have changed since.
        const inverse = new Map<number, number>();
        this.paletteMap.forEach((slot, old) => inverse.set(slot, old));

        for (let i = 0; i < indices.length; ++i) {
            const back = inverse.get(indices[i]);
            if (back !== undefined) indices[i] = back;
        }

        splat.gradeTexture.unlock();
        // the slots were the most recent allocations, so this is a plain pop
        splat.gradePalette.free(this.paletteMap.size);
        this.paletteMap = null;
        splat.scene.forceRender = true;
    }

    destroy() {
        this.splat = null;
        this.paletteMap = null;
    }
}

// Snapshot-based undo/redo for animation track edits.
// Captures the full track state before and after a mutation.
class AnimTrackEditOp {
    name: string;
    track: AnimTrack;
    before: unknown;
    after: unknown;

    constructor(name: string, track: AnimTrack, before: unknown, after: unknown) {
        this.name = name;
        this.track = track;
        this.before = before;
        this.after = after;
    }

    do() {
        this.track.restore(this.after);
    }

    undo() {
        this.track.restore(this.before);
    }
}

class MultiOp {
    name = 'multiOp';
    ops: EditOp[];

    constructor(ops: EditOp[]) {
        this.ops = ops;
    }

    async do() {
        for (const op of this.ops) {
            await op.do();
        }
    }

    async undo() {
        for (const op of this.ops) {
            await op.undo();
        }
    }
}

class AddSplatOp {
    name = 'addSplat';
    scene: Scene;
    splat: Splat;

    constructor(scene: Scene, splat: Splat) {
        this.scene = scene;
        this.splat = splat;
    }

    async do() {
        await this.scene.add(this.splat);
    }

    undo() {
        this.scene.remove(this.splat);
    }

    destroy() {
        this.splat.destroy();
    }
}

/**
 * Delete everything outside a volume - or inside it.
 *
 * Composable from a shape select, an invert and a delete, which is three nodes
 * for one idea. As a single node it is also re-runnable: the volume is a
 * parameter, so moving or resizing it re-evaluates rather than leaving the
 * first crop baked in.
 *
 * A crop only ever adds to what is deleted. Splats an earlier node removed stay
 * removed, so widening a crop does not resurrect them - that is the earlier
 * node's business, and bypassing it is how you take it back.
 */
class CropOp extends StateOp {
    name = 'crop';

    shape: 'box' | 'sphere';
    transform: Mat4;
    keepInside: boolean;

    constructor(splat: Splat, shape: 'box' | 'sphere', transform: Mat4, keepInside = true) {
        super(splat, null, State.deleted, BitOp.SET, State.deleted);
        this.shape = shape;
        this.transform = transform;
        this.keepInside = keepInside;

        this.resolver = async (s: Splat) => {
            const isHit = await resolveHits(s, { kind: this.shape, transform: this.transform });
            const state = s.splatData.getProp('state') as Uint8Array;
            return IndexRanges.fromPredicate(s.splatData.numSplats, (i) => {
                const inside = isHit(i);
                const keep = this.keepInside ? inside : !inside;
                return !keep && (state[i] & State.deleted) === 0;
            });
        };
    }

    /** Change the volume and forget what the old one caught. */
    setVolume(shape: 'box' | 'sphere', transform: Mat4, keepInside: boolean) {
        this.shape = shape;
        this.transform = transform;
        this.keepInside = keepInside;
        this.invalidate();
    }

    destroy() {
        super.destroy();
        this.transform = null;
    }
}

/**
 * Cap how many spherical-harmonic bands an object carries.
 *
 * The single biggest lever on file size, and previewable: dropping bands is
 * visible in the viewport straight away rather than only at export. Stored as
 * a limit rather than by truncating the data, so it stays reversible and the
 * bands come back if the node is bypassed.
 */
class SetShBandsOp {
    name = 'setShBands';
    splat: Splat;
    oldBands: number;
    newBands: number;

    constructor(splat: Splat, bands: number) {
        this.splat = splat;
        this.oldBands = splat.shBandLimit;
        this.newBands = bands;
    }

    do() {
        this.splat.shBandLimit = this.newBands;
    }

    undo() {
        this.splat.shBandLimit = this.oldBands;
    }

    destroy() {
        this.splat = null;
    }
}

/**
 * Drop the least important gaussians until only a fraction remain.
 *
 * Importance is opacity times footprint: a large transparent blob and a tiny
 * opaque speck both contribute little, and the product says so. Ranking rather
 * than thresholding, because a threshold that suits one capture suits no other
 * - "keep 40%" transfers between scenes in a way "alpha above 0.03" does not.
 *
 * Like a crop, this only ever adds to what is deleted.
 */
class DecimateOp extends StateOp {
    name = 'decimate';

    /** how much to keep, 0..1 */
    fraction: number;

    constructor(splat: Splat, fraction: number) {
        super(splat, null, State.deleted, BitOp.SET, State.deleted);
        this.fraction = fraction;

        this.resolver = (s: Splat) => {
            const data = s.splatData;
            const n = data.numSplats;
            const state = data.getProp('state') as Uint8Array;
            const opacity = data.getProp('opacity') as Float32Array;
            const sx = data.getProp('scale_0') as Float32Array;
            const sy = data.getProp('scale_1') as Float32Array;
            const sz = data.getProp('scale_2') as Float32Array;

            // candidates are what is still here; anything already deleted is
            // not ours to rank or to resurrect
            const live: number[] = [];
            for (let i = 0; i < n; ++i) {
                if ((state[i] & State.deleted) === 0) live.push(i);
            }

            const keep = Math.max(0, Math.min(live.length, Math.round(live.length * this.fraction)));
            const drop = live.length - keep;
            if (drop <= 0) return IndexRanges.fromPredicate(0, () => false);

            // scales are stored as logs, so the exponentials are the radii and
            // their product stands in for volume
            const importance = (i: number) => {
                const alpha = opacity ? 1 / (1 + Math.exp(-opacity[i])) : 1;
                const vol = (sx && sy && sz) ?
                    Math.exp(sx[i]) * Math.exp(sy[i]) * Math.exp(sz[i]) : 1;
                return alpha * vol;
            };

            // partial ordering would do, but the counts here are small enough
            // that a sort is simpler to be sure of
            const ranked = live.slice().sort((a, b) => importance(a) - importance(b));
            const doomed = new Uint8Array(n);
            for (let k = 0; k < drop; ++k) doomed[ranked[k]] = 1;

            return IndexRanges.fromPredicate(n, i => doomed[i] === 1);
        };
    }

    setFraction(fraction: number) {
        this.fraction = fraction;
        this.invalidate();
    }
}

/**
 * Statistical outlier removal - the floaters a capture leaves behind.
 *
 * For each gaussian, the mean distance to its `neighbours` nearest others; a
 * gaussian is an outlier when that mean sits further than `deviations` standard
 * deviations above the average. Floaters are exactly the points with no close
 * company, so the measure finds them without anyone having to lasso.
 *
 * Neighbours are found through a uniform grid sized so that cells hold a
 * handful of points each. That makes the search local instead of comparing
 * everything with everything, which at these counts is the difference between
 * a moment and never.
 *
 * Like a crop, this only ever adds to what is deleted.
 */
class CleanupOp extends StateOp {
    name = 'cleanup';

    neighbours: number;
    deviations: number;

    constructor(splat: Splat, neighbours = 16, deviations = 1.5) {
        super(splat, null, State.deleted, BitOp.SET, State.deleted);
        this.neighbours = neighbours;
        this.deviations = deviations;

        this.resolver = (s: Splat) => {
            const data = s.splatData;
            const n = data.numSplats;
            const state = data.getProp('state') as Uint8Array;
            const px = data.getProp('x') as Float32Array;
            const py = data.getProp('y') as Float32Array;
            const pz = data.getProp('z') as Float32Array;
            if (!px || !py || !pz) return IndexRanges.fromPredicate(0, () => false);

            const live: number[] = [];
            for (let i = 0; i < n; ++i) {
                if ((state[i] & State.deleted) === 0) live.push(i);
            }
            const k = Math.min(this.neighbours, live.length - 1);
            if (k < 1) return IndexRanges.fromPredicate(0, () => false);

            // bounds, to size the grid
            let x0 = Infinity, y0 = Infinity, z0 = Infinity;
            let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
            for (const i of live) {
                if (px[i] < x0) x0 = px[i];
                if (py[i] < y0) y0 = py[i];
                if (pz[i] < z0) z0 = pz[i];
                if (px[i] > x1) x1 = px[i];
                if (py[i] > y1) y1 = py[i];
                if (pz[i] > z1) z1 = pz[i];
            }

            // aim for a few points per cell, so a 3x3x3 block around a point
            // holds comfortably more than k of them
            const span = Math.max(x1 - x0, y1 - y0, z1 - z0) || 1;
            const target = Math.max(1, Math.cbrt(live.length / 4));
            const cell = span / target;
            const dim = (lo: number, hi: number) => Math.max(1, Math.ceil((hi - lo) / cell) + 1);
            const nx = dim(x0, x1), ny = dim(y0, y1), nz = dim(z0, z1);

            const cellOf = (i: number) => {
                const cx = Math.min(nx - 1, Math.floor((px[i] - x0) / cell));
                const cy = Math.min(ny - 1, Math.floor((py[i] - y0) / cell));
                const cz = Math.min(nz - 1, Math.floor((pz[i] - z0) / cell));
                return (cz * ny + cy) * nx + cx;
            };

            const buckets = new Map<number, number[]>();
            for (const i of live) {
                const c = cellOf(i);
                const b = buckets.get(c);
                if (b) b.push(i); else buckets.set(c, [i]);
            }

            // mean distance to the k nearest, searching outward a ring at a
            // time until the block seen holds enough candidates
            const means = new Float64Array(live.length);
            const dist2: number[] = [];

            for (let idx = 0; idx < live.length; ++idx) {
                const i = live[idx];
                const cx = Math.min(nx - 1, Math.floor((px[i] - x0) / cell));
                const cy = Math.min(ny - 1, Math.floor((py[i] - y0) / cell));
                const cz = Math.min(nz - 1, Math.floor((pz[i] - z0) / cell));

                dist2.length = 0;
                for (let r = 1; r <= 4; ++r) {
                    dist2.length = 0;
                    for (let dz = -r; dz <= r; ++dz) {
                        const z = cz + dz;
                        if (z < 0 || z >= nz) continue;
                        for (let dy = -r; dy <= r; ++dy) {
                            const y = cy + dy;
                            if (y < 0 || y >= ny) continue;
                            for (let dx = -r; dx <= r; ++dx) {
                                const x = cx + dx;
                                if (x < 0 || x >= nx) continue;
                                const b = buckets.get((z * ny + y) * nx + x);
                                if (!b) continue;
                                for (const j of b) {
                                    if (j === i) continue;
                                    const ex = px[j] - px[i];
                                    const ey = py[j] - py[i];
                                    const ez = pz[j] - pz[i];
                                    dist2.push(ex * ex + ey * ey + ez * ez);
                                }
                            }
                        }
                    }
                    if (dist2.length >= k) break;
                }

                if (!dist2.length) {
                    // nothing anywhere near it; the emptiest possible neighbourhood
                    means[idx] = Infinity;
                    continue;
                }

                dist2.sort((a, b) => a - b);
                const take = Math.min(k, dist2.length);
                let sum = 0;
                for (let m = 0; m < take; ++m) sum += Math.sqrt(dist2[m]);
                means[idx] = sum / take;
            }

            // threshold at mean + deviations * sigma, over the finite values
            let sum = 0, count = 0;
            for (const m of means) {
                if (isFinite(m)) {
                    sum += m;
                    count++;
                }
            }
            const avg = count ? sum / count : 0;
            let varSum = 0;
            for (const m of means) {
                if (isFinite(m)) varSum += (m - avg) * (m - avg);
            }
            const sigma = count ? Math.sqrt(varSum / count) : 0;
            const limit = avg + this.deviations * sigma;

            const doomed = new Uint8Array(n);
            for (let idx = 0; idx < live.length; ++idx) {
                if (!isFinite(means[idx]) || means[idx] > limit) doomed[live[idx]] = 1;
            }

            return IndexRanges.fromPredicate(n, i => doomed[i] === 1);
        };
    }

    setParams(neighbours: number, deviations: number) {
        this.neighbours = neighbours;
        this.deviations = deviations;
        this.invalidate();
    }
}

/** The formats an output node can write. Viewer exports need their own settings. */
type OutputFileType = 'ply' | 'compressedPly' | 'splat' | 'sog' | 'spz';

type OutputSettings = {
    fileType: OutputFileType;
    filename: string;
    maxSHBands: number;
    /** write only the selected gaussians as they stand at this point */
    selectedOnly: boolean;
};

/**
 * A point in the chain that writes a file.
 *
 * Not an edit - `do` and `undo` do nothing, because exporting changes nothing
 * about the scene. What an output node has is a *position*, and that is the
 * whole point of it being in the chain: one placed before a delete writes the
 * object with those splats still in it, and a second one further along writes
 * the version without them. Two deliverables, one graph.
 */
class OutputOp {
    name = 'output';
    splat: Splat;
    settings: OutputSettings;

    constructor(splat: Splat, settings: OutputSettings) {
        this.splat = splat;
        this.settings = settings;
    }

    do() {}

    undo() {}

    destroy() {
        this.splat = null;
    }
}

/**
 * Two objects into one.
 *
 * The first node with more than one input, and the reason the graph is a DAG
 * rather than a set of parallel chains. Worth being precise about what that
 * did and did not change:
 *
 * The history stays a flat array, because a linear order *is* a topological
 * order of a DAG - the array says when things ran, and `inputs` says what fed
 * what. Replay still invalidates everything after a node, which is now
 * conservative rather than exact: it may re-resolve a node that no path
 * reaches. Correct, and cheap enough to be worth the simplicity.
 *
 * The merged object is built before the op exists, because building it means
 * writing both objects out and reading them back, and an op's `do` has to be
 * repeatable. So `do` adds an object that already exists, the way AddSplatOp
 * does, and hides the two that fed it - reversibly, since hiding is a property
 * rather than an edit.
 */
class MergeOp {
    name = 'merge';

    scene: Scene;
    /** what this node consumes - the graph draws an edge from each */
    inputs: Splat[];
    /** what it produces */
    output: Splat;

    private wasVisible: boolean[] = [];

    constructor(scene: Scene, inputs: Splat[], output: Splat) {
        this.scene = scene;
        this.inputs = inputs;
        this.output = output;
    }

    async do() {
        this.wasVisible = this.inputs.map(s => s.visible);
        this.inputs.forEach((s) => {
            s.visible = false;
        });
        await this.scene.add(this.output);
    }

    undo() {
        this.scene.remove(this.output);
        this.inputs.forEach((s, i) => {
            s.visible = this.wasVisible[i] ?? true;
        });
    }

    destroy() {
        this.output?.destroy();
        this.inputs = null;
        this.output = null;
    }
}

/**
 * Turn an object into a grid of voxels.
 *
 * Like merge, this produces a new element rather than changing one - and
 * unlike merge, what it produces is not the same kind of thing that went in.
 * That is the node the graph gained a DAG for: its output type differs from
 * its input's, so it cannot simply be another link in that object's chain.
 *
 * The source is hidden rather than removed, so bypassing the node brings it
 * back and the original data is never lost.
 */
class VoxeliseOp {
    name = 'voxelise';

    scene: Scene;
    inputs: Splat[];
    output: Voxels;

    private wasVisible = true;

    constructor(scene: Scene, source: Splat, output: Voxels) {
        this.scene = scene;
        this.inputs = [source];
        this.output = output;
    }

    async do() {
        this.wasVisible = this.inputs[0].visible;
        this.inputs[0].visible = false;
        await this.scene.add(this.output);
    }

    undo() {
        this.scene.remove(this.output);
        this.inputs[0].visible = this.wasVisible;
    }

    destroy() {
        this.output?.destroy();
        this.inputs = null;
        this.output = null;
    }
}

/**
 * An imported voxel model. Import nodes for splats are synthesised by the
 * graph from the scene, but voxels only enter the graph through history -
 * so an imported .vox arrives as an op, built like every other producer:
 * output first, then an op whose do/undo add and remove it.
 */
class AddVoxelsOp {
    name = 'addVoxels';

    scene: Scene;
    inputs: Splat[] = [];
    output: Voxels;
    sourceName: string;

    constructor(scene: Scene, output: Voxels, sourceName: string) {
        this.scene = scene;
        this.output = output;
        this.sourceName = sourceName;
    }

    get sourceLabel() {
        return this.sourceName;
    }

    async do() {
        await this.scene.add(this.output);
    }

    undo() {
        this.scene.remove(this.output);
    }

    destroy() {
        this.output?.destroy();
        this.output = null;
    }
}

/** The record a train node keeps: what was trained, how, and what came out. */
type TrainSettings = {
    datasetName: string;
    /** the kebab-case Brush config the run actually used */
    config: Record<string, unknown>;
    iterations: number;
    finalSplats: number;
    psnr?: number;
};

/**
 * A training run, recorded in the graph - and unlike every other producing
 * node, it starts life *pending*: the node exists before any gaussians do.
 *
 * The node IS training. It is created with a dataset and settings and no
 * output; the run controller (src/training/train-run.ts) drives the
 * trainer and hands the op its output at the first snapshot, then refines
 * that same object in place through replaceData as the run proceeds. The
 * viewport is the live view.
 *
 * The dataset itself is session state, not history: a directory handle or
 * a dropped file cannot be serialised, so retrain re-attaches it when the
 * session no longer holds it.
 */
class TrainOp {
    name = 'train';

    scene: Scene;
    /** trained from a dataset, not from scene objects */
    inputs: Splat[] = [];
    /** null until the first snapshot of the first run */
    output: Splat | null;
    settings: TrainSettings;
    /** held so retrain can reuse the dataset within this session */
    dataset?: unknown;
    /** photos ingested, poses still being estimated outside the app */
    awaitingPoses?: boolean;
    bypassed?: boolean;

    constructor(scene: Scene, output: Splat | null, settings: TrainSettings) {
        this.scene = scene;
        this.output = output;
        this.settings = settings;
    }

    /** what the graph labels this node with */
    get sourceLabel() {
        return this.settings.datasetName;
    }

    async do() {
        if (this.output) await this.scene.add(this.output);
    }

    undo() {
        if (this.output) this.scene.remove(this.output);
    }

    destroy() {
        this.output?.destroy();
        this.output = null;
        this.dataset = null;
    }
}

class SplatRenameOp {
    name = 'splatRename';
    splat: Splat;
    oldName: string;
    newName: string;

    constructor(splat: Splat, newName: string) {
        this.splat = splat;
        this.oldName = splat.name;
        this.newName = newName;
    }

    do() {
        this.splat.name = this.newName;
    }

    undo() {
        this.splat.name = this.oldName;
    }
}

/**
 * What an entry in the history actually stands for.
 *
 * Some edits are committed as a bundle - a transform carries the pivot
 * placement that went with it - and the bundle is an implementation detail of
 * how they were recorded. Anything presenting an op to a person should name
 * and edit it by whichever member does the work.
 */
const principalOp = (op: EditOp): EditOp => {
    if (!(op instanceof MultiOp)) return op;
    return op.ops.find(o => o instanceof EntityTransformOp) ??
        op.ops.find(o => o instanceof StateOp) ??
        op.ops[0] ?? op;
};

export {
    EditOp,
    SelectMode,
    SelectStep,
    StateOp,
    SelectAllOp,
    SelectNoneOp,
    SelectInvertOp,
    SelectOp,
    HideSelectionOp,
    UnhideAllOp,
    DeleteSelectionOp,
    ResetOp,
    EntityTransformOp,
    SplatsTransformOp,
    PlacePivotOp,
    SetLocalFrameOp,
    ShapeTransformOp,
    ShapeTransformState,
    ColorAdjustment,
    SetSplatColorAdjustmentOp,
    ScopedColorOp,
    AnimTrackEditOp,
    MultiOp,
    MergeOp,
    VoxeliseOp,
    AddVoxelsOp,
    TrainOp,
    type TrainSettings,
    principalOp,
    CropOp,
    DecimateOp,
    CleanupOp,
    SetShBandsOp,
    OutputOp,
    OutputSettings,
    OutputFileType,
    AddSplatOp,
    SplatRenameOp
};
