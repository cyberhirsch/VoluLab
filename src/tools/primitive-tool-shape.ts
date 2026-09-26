import { Entity } from 'playcanvas';

import { EditOp, PrimitiveOp, PrimitivePoseOp, SelectOp } from '../edit-ops';
import { Events } from '../events';
import { Scene } from '../scene';
import { PrimitiveKind, PrimitivePose, ScenePrimitive } from '../scene-primitive';

/**
 * The shape a sphere or box selection tool works on: a primitive, which the
 * tool's set, add, remove and intersect buttons wire into the select node
 * being worked on, as its mesh input.
 *
 * Picking the tool up takes the primitive that node already takes in, when
 * it is of the tool's kind, so the tool goes on editing what is there.
 * Otherwise it makes a new one where its last one was. Put down without
 * having been wired into anything, a new one is taken out again, so trying
 * the tool leaves nothing behind.
 *
 * The gizmo moves a stand-in entity and the primitive follows it: live
 * while dragging, and as one undo step when the drag ends - the step a
 * select node waits for before it selects again.
 */
class PrimitiveToolShape {
    primitive: ScenePrimitive | null = null;

    /** what the gizmo is attached to, kept on the primitive's pose */
    pivot = new Entity('primitiveToolPivot');

    private events: Events;
    private kind: PrimitiveKind;
    // the node made for this pick-up, while nothing takes it in
    private made: PrimitiveOp | null = null;
    // where the last shape was, for the next one
    private lastPose: PrimitivePose | null = null;
    private dragStart: PrimitivePose | null = null;

    constructor(events: Events, scene: Scene, kind: PrimitiveKind) {
        this.events = events;
        this.kind = kind;
        scene.app.root.addChild(this.pivot);
    }

    private get ops() {
        return (this.events.invoke('edit.history')?.ops ?? []) as EditOp[];
    }

    /** whether a select node takes this primitive in */
    private get wired() {
        return this.ops.some(op => op instanceof SelectOp && op.mesh?.source === this.primitive);
    }

    /** picking the tool up: the shape to work on */
    acquire() {
        const editing = this.events.invoke('select.editingMesh', this.kind) as ScenePrimitive | null;
        if (editing) {
            this.primitive = editing;
            this.made = null;
        } else {
            // quiet: the object stays selected and its select node open
            const op = this.events.invoke('primitive.addNode', this.kind, true) as PrimitiveOp;
            this.primitive = op.output;
            this.made = op;
            if (this.lastPose) this.primitive.setPose(this.lastPose);
        }
        this.syncPivot();
        return this.primitive;
    }

    /** putting the tool down */
    release() {
        const primitive = this.primitive;
        if (primitive) this.lastPose = primitive.getPose();

        if (this.made && !this.wired) {
            // the node and every step that moved it
            const indices = this.ops
            .map((op, i) => ((op === this.made || (op instanceof PrimitivePoseOp && op.primitive === primitive)) ? i : -1))
            .filter(i => i >= 0);
            this.events.invoke('edit.removeAt', indices);
        }

        this.primitive = null;
        this.made = null;
    }

    /** the gizmo's stand-in <- the primitive */
    syncPivot() {
        const primitive = this.primitive;
        if (!primitive) return;
        this.pivot.setPosition(primitive.position);
        this.pivot.setRotation(primitive.rotation);
        this.pivot.setLocalScale(primitive.size);
    }

    startDrag() {
        const primitive = this.primitive;
        if (!primitive) return;
        this.dragStart = primitive.getPose();
        primitive.live = true;
    }

    /** the primitive <- the gizmo's stand-in, while dragging */
    drag() {
        const primitive = this.primitive;
        if (!primitive) return;
        primitive.position.copy(this.pivot.getPosition());
        primitive.rotation.copy(this.pivot.getRotation());
        primitive.size.copy(this.pivot.getLocalScale());
        primitive.moved();
    }

    endDrag() {
        const primitive = this.primitive;
        if (!primitive || !this.dragStart) return;
        primitive.live = false;
        this.commit(this.dragStart);
        this.dragStart = null;
    }

    /** a new pose from the tool's fields, as one undo step */
    setPose(pose: PrimitivePose) {
        const primitive = this.primitive;
        if (!primitive) return;
        const from = primitive.getPose();
        primitive.setPose(pose);
        this.syncPivot();
        this.commit(from);
    }

    get dragging() {
        return !!this.dragStart;
    }

    // one undo step from a pose to where the primitive is now
    private commit(from: PrimitivePose) {
        const primitive = this.primitive;
        const now = primitive.getPose();
        if (from.position.equals(now.position) && from.rotation.equals(now.rotation) && from.size.equals(now.size)) return;
        // already applied, so the op's do() is suppressed
        this.events.fire('edit.add', new PrimitivePoseOp(primitive, from, now), true);
    }
}

export { PrimitiveToolShape };
