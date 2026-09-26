import { Vec3 } from 'playcanvas';

import { PrimitivePoseOp } from './edit-ops';
import { Events } from './events';
import { Pivot } from './pivot';
import { PrimitivePose, ScenePrimitive } from './scene-primitive';
import { Transform } from './transform';
import { TransformHandler } from './transform-handler';

/**
 * The move/rotate/scale gizmo, pointed at a primitive.
 *
 * The pivot sits at the primitive's middle, turned as it is turned. Its
 * scale is one number where a primitive has a size along each axis, so the
 * pivot carries the size along x, and scaling the pivot scales all three
 * together: a box keeps its proportions, and the panel's scale field reads
 * as the primitive's width.
 */

const transform = new Transform();
const scale = new Vec3();

class PrimitiveTransformHandler implements TransformHandler {
    events: Events;
    primitive: ScenePrimitive = null;
    private startPose: PrimitivePose = null;
    // the size along each axis over the size along x, kept through a drag
    private proportions = new Vec3(1, 1, 1);

    constructor(events: Events) {
        this.events = events;

        events.on('pivot.started', () => {
            if (this.primitive) this.start();
        });

        events.on('pivot.moved', (pivot: Pivot) => {
            if (this.primitive) this.update(pivot.transform);
        });

        events.on('pivot.ended', () => {
            if (this.primitive) this.end();
        });

        // undo, redo and the node's own fields move it without the gizmo,
        // so the pivot has to follow rather than stay where it was
        events.on('primitive.moved', (primitive: ScenePrimitive) => {
            if (primitive === this.primitive && !this.startPose) this.placePivot();
        });
    }

    placePivot() {
        const { position, rotation, size } = this.primitive;
        scale.set(size.x, size.x, size.x);
        transform.set(position, rotation, scale);
        this.events.invoke('pivot').place(transform);
    }

    activate() {
        this.primitive = this.events.invoke('primitive.selected') as ScenePrimitive;
        if (this.primitive) {
            this.placePivot();
        }
    }

    deactivate() {
        this.primitive = null;
    }

    start() {
        this.startPose = this.primitive.getPose();
        const { size } = this.primitive;
        this.proportions.set(1, size.y / size.x, size.z / size.x);
    }

    update(t: Transform) {
        const width = Math.abs(t.scale.x);
        this.primitive.position.copy(t.position);
        this.primitive.rotation.copy(t.rotation);
        this.primitive.size.copy(this.proportions).mulScalar(Math.max(1e-3, width));
        this.primitive.moved();
    }

    end() {
        const now = this.primitive.getPose();
        const was = this.startPose;
        const moved = !was.position.equals(now.position) || !was.rotation.equals(now.rotation) || !was.size.equals(now.size);
        if (moved) {
            // already applied, so the op's do() is suppressed
            this.events.fire('edit.add', new PrimitivePoseOp(this.primitive, was, now), true);
        }
        this.startPose = null;
    }
}

export { PrimitiveTransformHandler };
