import { EditOp, MultiOp, StateOp } from './edit-ops';
import { SelectionNodeOp, selectionNodeFrom } from './select-nodes';
import { Splat } from './splat';

/**
 * How a project keeps the rule-based select nodes (select-nodes.ts): as
 * their settings, beside the set they applied to, like every state node
 * (doc-nodes.ts). A combine node names the nodes wired into it by their
 * place in the history, and finds them again among the nodes restored
 * before it.
 */

const STORED_TYPE = 'selectionNode';

// the state nodes restored so far, per object, by their stored place
const restored = new WeakMap<Splat, Map<number, StateOp>>();

/** Remember a restored node, so a combine node after it can be wired to it. */
const noteRestored = (splat: Splat, at: number, op: StateOp) => {
    if (typeof at !== 'number') return;
    let byAt = restored.get(splat);
    if (!byAt) restored.set(splat, byAt = new Map());
    byAt.set(at, op);
};

/** a restored node of an object, by its stored place in the history */
const restoredAt = (splat: Splat, at: unknown): StateOp | null => {
    return typeof at === 'number' ? restored.get(splat)?.get(at) ?? null : null;
};

/** the place in the history of the op that is or holds `op`, or -1 */
const historyIndex = (history: EditOp[], op: EditOp) => {
    return history.findIndex(o => o === op || (o instanceof MultiOp && o.ops.includes(op)));
};

/** A node's settings for a project, or null for an op that is not one. */
const packSelectionNode = (op: StateOp, history: EditOp[]): Record<string, any> | null => {
    if (!(op instanceof SelectionNodeOp)) return null;
    const settings = op.settings;
    // a wired node is kept by where it stands in the history
    (op as any).ports?.forEach((port: { name: string, source: object | null }) => {
        if (port.source) settings[`${port.name}At`] = historyIndex(history, port.source as EditOp);
    });
    return { type: STORED_TYPE, settings };
};

/** A stored node as an op on `splat`; null for a stored node not of these. */
const restoreSelectionNode = (stored: Record<string, any>, splat: Splat): SelectionNodeOp | null => {
    if (stored.type !== STORED_TYPE) return null;
    const op = selectionNodeFrom(splat, stored.settings);
    if (!op) return null;
    (op as any).rewire?.((at: unknown) => restoredAt(splat, at), stored.settings);
    return op;
};

export { noteRestored, packSelectionNode, restoreSelectionNode };
