import { Color, Mat4, Quat, Vec3 } from 'playcanvas';

import { AnimTrack } from './anim-track';
import { BoxShape } from './box-shape';
import { IndexRanges } from './index-ranges';
import { Pivot } from './pivot';
import { Scene } from './scene';
import { SelectQuery, resolveHits } from './select-query';
import { SphereShape } from './sphere-shape';
import { Splat } from './splat';
import { State } from './splat-state';
import { Transform } from './transform';

interface EditOp {
    name: string;
    do(): void | Promise<void>;
    undo(): void | Promise<void>;
    destroy?(): void;
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

// op → bit operation and op → predicate, kept as parallel lookups keyed by the
// same union so adding a mode forces both to be updated together.
const selectBitOps: Record<SelectMode, BitOp> = {
    add: BitOp.SET,
    remove: BitOp.CLEAR,
    set: BitOp.TOGGLE,
    intersect: BitOp.CLEAR
};

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

/**
 * A selection, stored as the query that produced it.
 *
 * The query is public and replaceable: `setQuery` swaps the parameters and
 * drops the resolved set, so re-applying the op runs the new query. That is
 * what makes a selection node in the graph something you can turn a dial on
 * rather than only look at.
 */
class SelectOp extends StateOp {
    name = 'selectOp';

    mode: SelectMode;
    query: SelectQuery;

    constructor(splat: Splat, mode: SelectMode, query: SelectQuery) {
        super(splat, null, State.selected, selectBitOps[mode]);
        this.mode = mode;
        this.query = query;
        // reads this.query rather than the constructor argument, so replacing
        // the query changes what the next resolve asks
        this.resolver = async (s: Splat) => combineWithState(s, this.mode, await resolveHits(s, this.query));
    }

    setQuery(query: SelectQuery) {
        this.query = query;
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
        const { tintClr, temperature, saturation, brightness, blackPoint, whitePoint, transparency } = this.newState;
        if (tintClr) splat.tintClr = tintClr;
        if (temperature !== null) splat.temperature = temperature;
        if (saturation !== null) splat.saturation = saturation;
        if (brightness !== null) splat.brightness = brightness;
        if (blackPoint !== null) splat.blackPoint = blackPoint;
        if (whitePoint !== null) splat.whitePoint = whitePoint;
        if (transparency !== null) splat.transparency = transparency;
    }

    undo() {
        const { splat } = this;
        const { tintClr, temperature, saturation, brightness, blackPoint, whitePoint, transparency } = this.oldState;
        if (tintClr) splat.tintClr = tintClr;
        if (temperature !== null) splat.temperature = temperature;
        if (saturation !== null) splat.saturation = saturation;
        if (brightness !== null) splat.brightness = brightness;
        if (blackPoint !== null) splat.blackPoint = blackPoint;
        if (whitePoint !== null) splat.whitePoint = whitePoint;
        if (transparency !== null) splat.transparency = transparency;
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

export {
    EditOp,
    SelectMode,
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
    AnimTrackEditOp,
    MultiOp,
    AddSplatOp,
    SplatRenameOp
};
