import { EditOp, MultiOp, StateOp } from './edit-ops';
import { HoldoutOp } from './holdout';
import { ColourSelectOp, SelectionNodeOp, selectionNodeFrom } from './select-nodes';
import { Splat } from './splat';

/**
 * How a project keeps the rule-based select nodes (select-nodes.ts): as
 * their settings, beside the set they applied to, like every state node
 * (doc-nodes.ts). A combine node names the nodes wired into it by their
 * place in the history, and finds them again among the nodes restored
 * before it.
 */

const STORED_TYPE = 'selectionNode';

// the state nodes restored so far, per object, by their stored place: the
// place in the history, and inside a MultiOp the place among its ops, as
// the parts of one MultiOp share the first
const restored = new WeakMap<Splat, Map<string, StateOp>>();

const placeKey = (at: number, part: unknown) => (typeof part === 'number' ? `${at}.${part}` : `${at}`);

/** Remember a restored node, so a combine node after it can be wired to it. */
const noteRestored = (splat: Splat, at: number, part: number | undefined, op: StateOp) => {
    if (typeof at !== 'number') return;
    let byAt = restored.get(splat);
    if (!byAt) restored.set(splat, byAt = new Map());
    byAt.set(placeKey(at, part), op);
};

/** a restored node of an object, by its stored place in the history */
const restoredAt = (splat: Splat, at: unknown, part?: unknown): StateOp | null => {
    return typeof at === 'number' ? restored.get(splat)?.get(placeKey(at, part)) ?? null : null;
};

/** the place in the history of the op that is or holds `op`, or -1 */
const historyIndex = (history: EditOp[], op: EditOp) => {
    return history.findIndex(o => o === op || (o instanceof MultiOp && o.ops.includes(op)));
};

/** inside a MultiOp, the place of `op` among its ops; undefined for an op on its own */
const partIndex = (history: EditOp[], op: EditOp) => {
    const outer = history.find(o => o instanceof MultiOp && o.ops.includes(op)) as MultiOp | undefined;
    return outer ? outer.ops.indexOf(op) : undefined;
};

/** A node's settings for a project, or null for an op that is not one. */
const packSelectionNode = (op: StateOp, history: EditOp[]): Record<string, any> | null => {
    // a holdout's set is all it has, and is stored as every node's is
    if (op instanceof HoldoutOp) return { type: 'holdoutNode', selectedIn: op.selectedIn };
    if (!(op instanceof SelectionNodeOp)) return null;
    const settings = op.settings;
    // a wired node is kept by where it stands in the history
    (op as any).ports?.forEach((port: { name: string, source: object | null }) => {
        if (!port.source) return;
        settings[`${port.name}At`] = historyIndex(history, port.source as EditOp);
        const part = partIndex(history, port.source as EditOp);
        if (part !== undefined) settings[`${port.name}Part`] = part;
    });
    // what it found when it last ran, which its face shows: a restored
    // node does not run again until something changes
    const ran: Record<string, any> = { caught: op.caught, warning: op.warning };
    if (op instanceof ColourSelectOp) ran.incomingMean = op.incomingMean;
    return { type: STORED_TYPE, settings, ran };
};

/** A stored node as an op on `splat`; null for a stored node not of these. */
const restoreSelectionNode = (stored: Record<string, any>, splat: Splat): StateOp | null => {
    if (stored.type === 'holdoutNode') {
        const holdout = new HoldoutOp(splat);
        holdout.selectedIn = stored.selectedIn ?? -1;
        return holdout;
    }
    if (stored.type !== STORED_TYPE) return null;
    const op = selectionNodeFrom(splat, stored.settings);
    if (!op) return null;
    const ran = stored.ran ?? {};
    if (typeof ran.caught === 'number') op.caught = ran.caught;
    if (typeof ran.warning === 'string') op.warning = ran.warning;
    if (op instanceof ColourSelectOp && Array.isArray(ran.incomingMean) && ran.incomingMean.length === 3 &&
        ran.incomingMean.every((v: unknown) => typeof v === 'number')) {
        op.incomingMean = ran.incomingMean as [number, number, number];
    }
    (op as any).rewire?.((at: unknown, part?: unknown) => restoredAt(splat, at, part), stored.settings);
    return op;
};

export { noteRestored, packSelectionNode, restoreSelectionNode };
