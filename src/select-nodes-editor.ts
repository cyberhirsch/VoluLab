import { EditOp, MultiOp } from './edit-ops';
import { Events } from './events';
import { SelectionNodeOp } from './select-nodes';

/**
 * What the rule-based select nodes need from the editor: whether an op is
 * applied now, so a combine node does not read the result of a select node
 * that is undone or bypassed.
 */
const registerSelectionNodes = (events: Events) => {
    SelectionNodeOp.applied = (op: EditOp) => {
        const history = events.invoke('edit.history') as { ops: EditOp[], cursor: number } | null;
        if (!history) return false;
        const at = history.ops.findIndex(o => o === op || (o instanceof MultiOp && o.ops.includes(op)));
        return at >= 0 && at < history.cursor && !history.ops[at].bypassed;
    };
};

export { registerSelectionNodes };
