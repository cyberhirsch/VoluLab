import { EditOp, MultiOp } from './edit-ops';
import { LOOK_NODES } from './look/nodes';
import { Splat } from './splat';

/**
 * Which cleanup and look nodes (src/look/) a project stores as nodes.
 *
 * A kind marked `stored` is kept with its settings and made again on open
 * (look/register.ts, look.restoreNode): the nodes that change a 4D model's
 * motion and nothing of its data - a 4D model is stored as the file it came
 * from, so the node is all there is of them - and fog, which is no data at
 * all.
 *
 * The others are kept as what they did:
 *  - flicker removal deletes, and is stored with the select and delete
 *    nodes (doc-nodes.ts).
 *  - opacity, colour match and exposure over time put gaussians on grade
 *    palette slots, kept the way a scoped colour node's are: baked into a
 *    PLY's colours, beside a 4D model's file as its grades. What they did
 *    comes back, the node does not - applied again, it would grade twice.
 *  - a still / moving split's other part is an object of the project, as a
 *    split node's is, stored as one.
 */
const storeLookNodes = (
    ops: EditOp[],
    cursor: number,
    splats: Splat[],
    placeOf: (op: EditOp) => { at?: number, pos?: number[] }
) => {
    const kinds = new Set(LOOK_NODES.filter(n => n.stored).map(n => n.kind));
    const stored: Record<string, any>[] = [];
    ops.slice(0, cursor).forEach((outer) => {
        const parts = outer instanceof MultiOp ? outer.ops : [outer];
        parts.forEach((op) => {
            if (!kinds.has(op.name)) return;
            const node = op as EditOp & { splat: Splat, settings: Record<string, any> };
            const splat = splats.indexOf(node.splat);
            if (splat < 0) return;
            stored.push({
                type: node.name,
                splat,
                settings: node.settings,
                ...(outer.bypassed ? { bypassed: true } : {}),
                ...placeOf(outer)
            });
        });
    });
    return stored;
};

export { storeLookNodes };
