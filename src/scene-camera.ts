import { Vec3 } from 'playcanvas';

import { AnimTrack } from './anim-track';
import { CameraSettings } from './edit-ops';
import { Element, ElementType } from './element';

/**
 * A camera you can see, select, look through and animate.
 *
 * The camera node used to be settings only. This is the object half of
 * it: a pose in the scene, drawn as a frustum, listed in the outliner,
 * and carrying its own animation track. The op in history owns one of
 * these the way an import op owns its splat.
 *
 * Pose is stored as position + target rather than a rotation, which is
 * what the viewport camera and the animation track already speak - it
 * keeps "look through this camera" a copy rather than a conversion, and
 * it cannot express roll, which this app's cameras never have anyway.
 */
class SceneCamera extends Element {
    name: string;
    position = new Vec3(0, 0, 1);
    target = new Vec3(0, 0, 0);
    fov = 60;

    /**
     * A locked camera keeps its framing: navigating while looking through
     * it drops the view back to perspective instead of dragging the
     * camera along.
     */
    locked = false;

    /** drawn in the viewport (the outliner's eye toggles this) */
    visible = true;

    /** exposure, depth of field and the lens - shared with the op's record */
    settings: CameraSettings;

    /**
     * This camera's animation, shown in the timeline while it is selected.
     * Assigned on creation, where the events object lives.
     */
    track: AnimTrack;

    constructor(name: string, settings: CameraSettings) {
        super(ElementType.camera);
        this.name = name;
        this.settings = settings;
    }

    /** the shape the viewport camera and the animation track both speak */
    getPose() {
        return {
            position: this.position.clone(),
            target: this.target.clone(),
            fov: this.fov
        };
    }

    setPose(pose: { position: Vec3, target: Vec3, fov?: number }) {
        this.position.copy(pose.position);
        this.target.copy(pose.target);
        if (pose.fov !== undefined) {
            this.fov = pose.fov;
        }
        this.scene?.events.fire('camera.sceneCameraMoved', this);
    }

    destroy() {
        super.destroy();
    }
}

export { SceneCamera };
