import { Mat4, Quat, Vec3 } from 'playcanvas';

import { LightPoseOp } from './edit-ops';
import { Events } from './events';
import { Pivot } from './pivot';
import { SceneLight } from './scene-light';
import { Transform } from './transform';
import { TransformHandler } from './transform-handler';

/**
 * The move/rotate gizmo, pointed at a light.
 *
 * The same contract as a camera's: the pivot sits at the light, oriented
 * the way it shines. Moving carries the aim point along; rotating turns the
 * light on the spot, keeping its distance to the aim point - which is also
 * what keeps a point or spot light's brightness at the aim point steady.
 * A light has no scale.
 */

const mat = new Mat4();
const quat = new Quat();
const forward = new Vec3();
const transform = new Transform();

class LightTransformHandler implements TransformHandler {
    events: Events;
    light: SceneLight = null;
    private distance = 1;
    private startPose: { position: Vec3, target: Vec3 } = null;

    constructor(events: Events) {
        this.events = events;

        events.on('pivot.started', () => {
            if (this.light) this.start();
        });

        events.on('pivot.moved', (pivot: Pivot) => {
            if (this.light) this.update(pivot.transform);
        });

        events.on('pivot.ended', () => {
            if (this.light) this.end();
        });

        // undo and redo move the light without the gizmo, so the pivot has
        // to follow rather than be left where the drag ended
        events.on('light.moved', (light: SceneLight) => {
            if (light === this.light && !this.startPose) this.placePivot();
        });
    }

    placePivot() {
        const { position, target } = this.light;

        forward.sub2(target, position).normalize();
        const up = Math.abs(forward.y) > 0.999 ? Vec3.BACK : Vec3.UP;

        mat.setLookAt(position, target, up);
        quat.setFromMat4(mat);

        transform.set(position, quat, Vec3.ONE);
        this.events.invoke('pivot').place(transform);
    }

    activate() {
        this.light = this.events.invoke('light.selected') as SceneLight;
        if (this.light) {
            this.placePivot();
        }
    }

    deactivate() {
        this.light = null;
    }

    start() {
        this.distance = Math.max(1e-4, this.light.position.distance(this.light.target));
        this.startPose = this.light.getPose();
    }

    update(t: Transform) {
        forward.copy(Vec3.FORWARD);
        t.rotation.transformVector(forward, forward);

        this.light.position.copy(t.position);
        this.light.target.copy(t.position).addScaled(forward, this.distance);
        this.events.fire('light.moved', this.light);
    }

    end() {
        const moved = !this.startPose.position.equals(this.light.position) ||
            !this.startPose.target.equals(this.light.target);

        if (moved) {
            this.events.fire('edit.add', new LightPoseOp(this.light, this.startPose, this.light.getPose()), true);
        }
        this.startPose = null;
    }
}

export { LightTransformHandler };
