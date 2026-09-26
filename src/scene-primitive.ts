import { Mat4, Quat, Vec3 } from 'playcanvas';

import { Element, ElementType } from './element';

/**
 * A box, a sphere or a cylinder, placed in the scene for other nodes to use:
 * a select node takes the gaussians inside one, and a light can shine from
 * one's surface.
 *
 * The object half of a primitive node, the way a SceneLight is the object
 * half of a light node: the op in history owns one and puts it in the scene
 * or takes it out.
 *
 * It is the unit shape - a cube of side 1, a sphere of diameter 1, or a
 * cylinder of diameter 1 and height 1 standing along its y axis - under a
 * position, a rotation and a size along each of its own axes. A size of
 * (2, 1, 1) makes a box twice as wide as it is tall, or draws a sphere out
 * into an ellipsoid. The same numbers are what a select node's volume test
 * runs on, so what is drawn is what is caught.
 */
type PrimitiveKind = 'box' | 'sphere' | 'cylinder';

const PRIMITIVE_KINDS: PrimitiveKind[] = ['box', 'sphere', 'cylinder'];

type PrimitivePose = {
    position: Vec3;
    rotation: Quat;
    size: Vec3;
};

const finite = (v: unknown, fallback: number) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

// a size of 0 along an axis would make the shape a sheet with no inside
const MIN_SIZE = 1e-3;

const local = new Vec3();
const inverse = new Mat4();

class ScenePrimitive extends Element {
    name: string;
    kind: PrimitiveKind;
    position = new Vec3();
    rotation = new Quat();
    size = new Vec3(1, 1, 1);
    /** the size it was made at, or opened with - what a size field resets to */
    madeSize = new Vec3(1, 1, 1);

    /** the outliner's eye: a hidden primitive is not drawn */
    visible = true;

    /**
     * Being moved by hand right now - dragged, or a size typed into. What
     * uses the shape waits for it to settle, which it does with an edit.
     */
    live = false;

    constructor(name: string, kind: PrimitiveKind) {
        super(ElementType.primitive);
        this.name = name;
        this.kind = PRIMITIVE_KINDS.includes(kind) ? kind : 'box';
    }

    getPose(): PrimitivePose {
        return {
            position: this.position.clone(),
            rotation: this.rotation.clone(),
            size: this.size.clone()
        };
    }

    setPose(pose: PrimitivePose) {
        this.position.copy(pose.position);
        this.rotation.copy(pose.rotation);
        this.size.set(
            Math.max(MIN_SIZE, pose.size.x),
            Math.max(MIN_SIZE, pose.size.y),
            Math.max(MIN_SIZE, pose.size.z)
        );
        this.moved();
    }

    /** the unit shape to world space */
    transform(out = new Mat4()) {
        return out.setTRS(this.position, this.rotation, this.size);
    }

    /** whether a point in world space is inside */
    contains(point: Vec3) {
        inverse.copy(this.transform()).invert();
        inverse.transformPoint(point, local);
        switch (this.kind) {
            case 'sphere':
                return local.length() < 0.5;
            case 'cylinder':
                return Math.abs(local.y) <= 0.5 && Math.hypot(local.x, local.z) < 0.5;
            default:
                return Math.abs(local.x) <= 0.5 && Math.abs(local.y) <= 0.5 && Math.abs(local.z) <= 0.5;
        }
    }

    /** the pose was changed in place: moved, turned or resized */
    moved() {
        this.scene?.events.fire('primitive.moved', this);
    }

    /** anything else about it changed: its kind, name or visibility */
    changed() {
        this.scene?.events.fire('primitive.changed', this);
    }

    /** everything a project needs to bring this primitive back */
    docSerialize() {
        const { position: p, rotation: r, size: s } = this;
        return {
            name: this.name,
            kind: this.kind,
            position: [p.x, p.y, p.z],
            rotation: [r.x, r.y, r.z, r.w],
            size: [s.x, s.y, s.z],
            visible: this.visible
        };
    }

    docDeserialize(doc: any) {
        if (!doc) return;
        this.name = String(doc.name ?? this.name);
        if (PRIMITIVE_KINDS.includes(doc.kind)) this.kind = doc.kind;
        const pose = this.getPose();
        if (Array.isArray(doc.position) && doc.position.length === 3) {
            pose.position.set(finite(doc.position[0], 0), finite(doc.position[1], 0), finite(doc.position[2], 0));
        }
        if (Array.isArray(doc.rotation) && doc.rotation.length === 4) {
            pose.rotation.set(finite(doc.rotation[0], 0), finite(doc.rotation[1], 0), finite(doc.rotation[2], 0), finite(doc.rotation[3], 1)).normalize();
        }
        if (Array.isArray(doc.size) && doc.size.length === 3) {
            pose.size.set(finite(doc.size[0], 1), finite(doc.size[1], 1), finite(doc.size[2], 1));
        }
        this.visible = doc.visible !== false;
        this.setPose(pose);
        this.madeSize.copy(this.size);
        this.changed();
    }
}

export { ScenePrimitive, PrimitiveKind, PrimitivePose, PRIMITIVE_KINDS };
