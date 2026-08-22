import { Mat4, Quat, Vec3 } from 'playcanvas';

import { CameraPoseOp } from './edit-ops';
import { Events } from './events';
import { Pivot } from './pivot';
import { SceneCamera } from './scene-camera';
import { Transform } from './transform';
import { TransformHandler } from './transform-handler';

/**
 * The move/rotate gizmo, pointed at a camera.
 *
 * Everything transformable in this app goes through the pivot: the gizmo
 * moves the pivot, and a handler decides what that means. For a camera it
 * means its pose - position from the pivot, aim from the pivot's
 * rotation, with the distance to the target preserved so rotating turns
 * the camera rather than dragging its focus around.
 *
 * A camera has no scale; the gizmo's scale is ignored rather than
 * pretended at.
 */

const mat = new Mat4();
const quat = new Quat();
const forward = new Vec3();
const transform = new Transform();

class CameraTransformHandler implements TransformHandler {
    events: Events;
    camera: SceneCamera = null;
    private distance = 1;
    private startPose: { position: Vec3, target: Vec3 } = null;

    constructor(events: Events) {
        this.events = events;

        events.on('pivot.started', () => {
            if (this.camera) this.start();
        });

        events.on('pivot.moved', (pivot: Pivot) => {
            if (this.camera) this.update(pivot.transform);
        });

        events.on('pivot.ended', () => {
            if (this.camera) this.end();
        });
    }

    /** the pivot sits at the camera, oriented the way the camera looks */
    placePivot() {
        const { position, target } = this.camera;

        // straight up or down makes the world up degenerate as a reference
        forward.sub2(target, position).normalize();
        const up = Math.abs(forward.y) > 0.999 ? Vec3.BACK : Vec3.UP;

        mat.setLookAt(position, target, up);
        quat.setFromMat4(mat);

        transform.set(position, quat, Vec3.ONE);
        this.events.invoke('pivot').place(transform);
    }

    activate() {
        this.camera = this.events.invoke('camera.selected') as SceneCamera;
        if (this.camera) {
            this.placePivot();
        }
    }

    deactivate() {
        this.camera = null;
    }

    start() {
        // you cannot reposition the camera you are looking through - the
        // view would be arguing with the gizmo over the same pose - so
        // stepping out of it is implied by starting the drag
        if (this.events.invoke('camera.viewMode') === 'camera' &&
            this.events.invoke('camera.active') === this.camera) {
            this.events.fire('camera.setViewMode', 'perspective');
        }

        this.distance = Math.max(1e-4, this.camera.position.distance(this.camera.target));
        this.startPose = {
            position: this.camera.position.clone(),
            target: this.camera.target.clone()
        };
    }

    update(t: Transform) {
        // the pivot's rotation is where the camera looks; its distance to
        // the target is kept so a rotation turns the camera on the spot
        forward.copy(Vec3.FORWARD);
        t.rotation.transformVector(forward, forward);

        this.camera.position.copy(t.position);
        this.camera.target.copy(t.position).addScaled(forward, this.distance);
        this.events.fire('camera.sceneCameraMoved', this.camera);
    }

    end() {
        const moved = !this.startPose.position.equals(this.camera.position) ||
            !this.startPose.target.equals(this.camera.target);

        if (moved) {
            this.events.fire('edit.add', new CameraPoseOp(this.camera, this.startPose, {
                position: this.camera.position,
                target: this.camera.target
            }), true);
        }
        this.startPose = null;
    }
}

export { CameraTransformHandler };
