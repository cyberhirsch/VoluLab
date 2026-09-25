import { Vec3 } from 'playcanvas';

import { LightSettings, VolumeEmitter } from './edit-ops';
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
const finite = (v: unknown, fallback: number) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/** a volume light's emitters from a project, keeping only well-formed ones */
const validEmitters = (emitters: unknown): VolumeEmitter[] => {
    if (!Array.isArray(emitters)) return [];
    return emitters
    .filter(e => e && Array.isArray(e.offset) && e.offset.length === 3 && Array.isArray(e.color) && e.color.length === 3)
    .slice(0, 64)
    .map(e => ({
        offset: [finite(e.offset[0], 0), finite(e.offset[1], 0), finite(e.offset[2], 0)],
        weight: Math.max(0, finite(e.weight, 0)),
        color: [Math.max(0, finite(e.color[0], 1)), Math.max(0, finite(e.color[1], 1)), Math.max(0, finite(e.color[2], 1))],
        radius: Math.max(0, finite(e.radius, 0))
    }));
};

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

    /**
     * The light's own axes: forward toward its aim point, right and up across
     * it - the plane an area light's rectangle or disk lies in, which the
     * relighter and the gizmo must agree on. Aimed straight up or down,
     * right is taken from the world's z axis rather than its up.
     */
    frame() {
        const forward = new Vec3().sub2(this.target, this.position);
        const distance = Math.max(forward.length(), 1e-4);
        forward.mulScalar(1 / distance);
        const reference = Math.abs(forward.y) > 0.999 ? Vec3.BACK : Vec3.UP;
        const right = new Vec3().cross(forward, reference).normalize();
        const up = new Vec3().cross(right, forward);
        return { forward, right, up, distance };
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
                } : null,
                emitters: (this.settings.emitters ?? []).map(e => ({
                    offset: [...e.offset],
                    weight: e.weight,
                    color: [...e.color],
                    radius: e.radius
                }))
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
            const { color, environment, emitters, ...rest } = doc.settings;
            Object.assign(this.settings, rest);
            if (Array.isArray(color) && color.length === 3) {
                this.settings.color = [color[0], color[1], color[2]];
            }
            this.settings.environment = validEnvironment(environment);
            this.settings.rotation = Number(this.settings.rotation) || 0;
            // projects from before matched lights had none
            this.settings.role = this.settings.role === 'match' ? 'match' : 'add';
            // nor, from before area and volume lights, these
            this.settings.size = Math.max(0.01, finite(this.settings.size, 0.5));
            this.settings.height = Math.max(0.01, finite(this.settings.height, 0.5));
            this.settings.emitters = validEmitters(emitters);
            this.settings.emitterSource = String(this.settings.emitterSource ?? '');
        }
        this.changed();
    }
}

export { SceneLight };
