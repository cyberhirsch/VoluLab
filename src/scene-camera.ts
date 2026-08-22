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

    /** everything a project needs to bring this camera back */
    docSerialize() {
        return {
            name: this.name,
            position: [this.position.x, this.position.y, this.position.z],
            target: [this.target.x, this.target.y, this.target.z],
            fov: this.fov,
            locked: this.locked,
            visible: this.visible,
            settings: { ...this.settings },
            // a track snapshot holds Vec3 instances, which JSON cannot bring
            // back with their methods - so keys travel as plain numbers
            keys: ((this.track?.snapshot() ?? []) as any[]).map(k => ({
                name: k.name,
                frame: k.frame,
                position: [k.position.x, k.position.y, k.position.z],
                target: [k.target.x, k.target.y, k.target.z],
                fov: k.fov
            }))
        };
    }

    docDeserialize(doc: any) {
        if (!doc) return;
        this.name = doc.name ?? this.name;
        if (Array.isArray(doc.position)) this.position.set(doc.position[0], doc.position[1], doc.position[2]);
        if (Array.isArray(doc.target)) this.target.set(doc.target[0], doc.target[1], doc.target[2]);
        this.fov = doc.fov ?? this.fov;
        this.locked = !!doc.locked;
        this.visible = doc.visible !== false;
        if (doc.settings) {
            // assign in place: the op's record and this camera share the object
            Object.assign(this.settings, doc.settings);
        }
        if (this.track && Array.isArray(doc.keys)) {
            this.track.restore(doc.keys.map((k: any) => ({
                name: k.name,
                frame: k.frame,
                position: new Vec3(k.position[0], k.position[1], k.position[2]),
                target: new Vec3(k.target[0], k.target[1], k.target[2]),
                fov: k.fov
            })));
        }
    }

    destroy() {
        super.destroy();
    }
}

export { SceneCamera };
