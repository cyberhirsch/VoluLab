import { Vec3 } from 'playcanvas';

import { LightSettings } from './edit-ops';
import { Element, ElementType } from './element';
import { validEnvironment } from './relight/environment';

/**
 * A light you can see, select, move and aim.
 *
 * The object half of a light node, the way a SceneCamera is the object half
 * of a camera node: the op in history owns one and puts it in the scene or
 * takes it out. The relighter lights with whatever lights are in the scene
 * and visible, so undo, redo and bypass need no help from it.
 *
 * Pose is position + target, like a camera. A spot aims along it, a sun
 * shines along it, and for a point light the target is the aim point its
 * intensity is measured at - which is what keeps a light's brightness
 * independent of the capture's scale.
 */
class SceneLight extends Element {
    name: string;
    position = new Vec3(0, 1, 0);
    target = new Vec3(0, 0, 0);

    /** a hidden light lights nothing (the outliner's eye toggles this) */
    visible = true;

    /** shared with the op's record, like a camera's settings */
    settings: LightSettings;

    constructor(name: string, settings: LightSettings) {
        super(ElementType.light);
        this.name = name;
        this.settings = settings;
    }

    getPose() {
        return {
            position: this.position.clone(),
            target: this.target.clone()
        };
    }

    setPose(pose: { position: Vec3, target: Vec3 }) {
        this.position.copy(pose.position);
        this.target.copy(pose.target);
        this.scene?.events.fire('light.moved', this);
    }

    /** anything else about the light changed: settings, name, visibility */
    changed() {
        this.scene?.events.fire('light.changed', this);
    }

    /** everything a project needs to bring this light back */
    docSerialize() {
        return {
            name: this.name,
            position: [this.position.x, this.position.y, this.position.z],
            target: [this.target.x, this.target.y, this.target.z],
            visible: this.visible,
            settings: {
                ...this.settings,
                color: [...this.settings.color],
                // the small map, not the image it came from - a few
                // thousand numbers, and all the relighter ever needs
                environment: this.settings.environment ? {
                    ...this.settings.environment,
                    data: [...this.settings.environment.data]
                } : null
            }
        };
    }

    docDeserialize(doc: any) {
        if (!doc) return;
        this.name = doc.name ?? this.name;
        if (Array.isArray(doc.position)) this.position.set(doc.position[0], doc.position[1], doc.position[2]);
        if (Array.isArray(doc.target)) this.target.set(doc.target[0], doc.target[1], doc.target[2]);
        this.visible = doc.visible !== false;
        if (doc.settings) {
            // in place: the op's record and this light share the object
            const { color, environment, ...rest } = doc.settings;
            Object.assign(this.settings, rest);
            if (Array.isArray(color) && color.length === 3) {
                this.settings.color = [color[0], color[1], color[2]];
            }
            this.settings.environment = validEnvironment(environment);
            this.settings.rotation = Number(this.settings.rotation) || 0;
            // projects from before matched lights had none
            this.settings.role = this.settings.role === 'match' ? 'match' : 'add';
        }
        this.changed();
    }
}

export { SceneLight };
