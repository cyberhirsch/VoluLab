import { Mat4, Vec3 } from 'playcanvas';

import { EditOp, PoseOp, TransformNodeOp, type TransformSubject } from './edit-ops';
import type { Events } from './events';
import { packKeys } from './keyframes';
import type { SceneCamera } from './scene-camera';
import type { SceneLight } from './scene-light';
import type { ScenePrimitive } from './scene-primitive';
import { Transform } from './transform';

/**
 * How a project keeps the transform nodes that stand on something other
 * than an object: a light, a primitive, a camera object, a pose node's
 * cameras. They go into `transforms` beside the objects' own, each naming
 * what it is on by its place in that kind's list - `light`, `primitive`,
 * `camera` or `pose` where an object's names `splat` - so a project from
 * before, which has only `splat`, reads as it did.
 *
 * As with an object, a light, a primitive or a camera is stored where it
 * stands without its nodes, and they go back on top of that. A pose
 * node's cameras are stored as they were found, untouched by the nodes on
 * them (PoseOp.placement is theirs), so its nodes simply go back on.
 * Where no pose without the nodes exists - a scale of nothing, a
 * primitive turned and stretched into a shear - the thing is stored as
 * it stands and its nodes are not kept, as an object's are not.
 */

type Kind = 'light' | 'primitive' | 'camera' | 'pose';
const KINDS: Kind[] = ['light', 'primitive', 'camera', 'pose'];

type Lists = Record<Kind, (TransformSubject | null | undefined)[]>;
type Place = (op: EditOp | undefined) => { at?: number, pos?: number[] };
type Later = (stored: any, add: () => EditOp | null) => void;

const pack3 = (v: Vec3) => [v.x, v.y, v.z];

/** the matrix of these nodes applied in order, or null if it cannot be undone */
const undoneBy = (nodes: TransformNodeOp[]) => {
    if (nodes.some(n => n.newt.scale.x * n.newt.scale.y * n.newt.scale.z === 0)) return null;
    const m = new Mat4();
    nodes.forEach(node => m.mul2(node.matrix, m));
    return m.invert();
};

/** what the thing is stored at in place of where it stands: its pose without the nodes */
const baseOf = (kind: Kind, subject: TransformSubject, under: TransformNodeOp[]): Record<string, number[]> | null => {
    if (kind === 'light' || kind === 'camera') {
        const inverse = undoneBy(under);
        if (!inverse) return null;
        const { position, target } = subject as SceneLight | SceneCamera;
        return {
            position: pack3(inverse.transformPoint(position, new Vec3())),
            target: pack3(inverse.transformPoint(target, new Vec3()))
        };
    }
    if (kind === 'primitive') {
        const p = subject as ScenePrimitive;
        const base = TransformNodeOp.baseOf(new Transform(p.position, p.rotation, p.size), under);
        if (!base) return null;
        const r = base.rotation;
        return { position: pack3(base.position), rotation: [r.x, r.y, r.z, r.w], size: pack3(base.scale).map(Math.abs) };
    }
    return {};
};

const storeSubjectTransforms = (ops: EditOp[], cursor: number, lists: Lists, placeOf: Place) => {
    const applied = ops.slice(0, cursor);
    const transforms: object[] = [];
    const bases = new Map<object, Record<string, number[]>>();

    KINDS.forEach((kind) => {
        lists[kind].forEach((subject, i) => {
            if (!subject) return;
            const nodes = applied.filter(o => o instanceof TransformNodeOp && o.subject === subject && (o.applied || o.bypassed)) as TransformNodeOp[];
            if (!nodes.length) return;
            const under = nodes.filter(n => n.applied);
            const base = under.length ? baseOf(kind, subject, under) : {};
            if (!base) return;
            bases.set(subject, base);
            nodes.forEach((node) => {
                const keys = packKeys(node);
                transforms.push({
                    [kind]: i,
                    position: pack3(node.newt.position),
                    rotation: pack3(node.euler),
                    scale: pack3(node.newt.scale),
                    bypassed: !!node.bypassed,
                    ...(keys ? { keys } : {}),
                    ...placeOf(node)
                });
            });
        });
    });

    return {
        transforms,
        /** what to store a light, primitive or camera at, over what it serialises */
        base: (subject: object) => bases.get(subject) ?? {}
    };
};

const restoreSubjectTransforms = (document: any, lists: Lists, later: Later, events: Events) => {
    if (!Array.isArray(document.transforms)) return;
    for (const stored of document.transforms) {
        const kind = KINDS.find(k => typeof stored?.[k] === 'number');
        const subject = kind ? lists[kind][stored[kind]] : null;
        if (subject) later(stored, () => events.invoke('transform.addNode', subject, stored));
    }
};

/** the pose nodes among the applied edits, in the order a project lists them */
const posesOf = (ops: EditOp[], cursor: number) => ops.slice(0, cursor).filter(o => o instanceof PoseOp) as PoseOp[];

export { posesOf, restoreSubjectTransforms, storeSubjectTransforms };
