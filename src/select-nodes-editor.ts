import { EditOp, MultiOp } from './edit-ops';
import { Events } from './events';
import { CombineSelectOp, SelectionNodeOp, isSelectionSource } from './select-nodes';

/**
 * What the rule-based select nodes need from the editor: where an op stands
 * in the history and whether it is applied, so a combine node reads only a
 * select node ahead of it that is applied; and the wires into a combine
 * node's inputs.
 */
const registerSelectionNodes = (events: Events) => {
    const history = () => events.invoke('edit.history') as { ops: EditOp[], cursor: number } | null;
    const indexOf = (op: EditOp) => history()?.ops.findIndex(o => o === op || (o instanceof MultiOp && o.ops.includes(op))) ?? -1;

    SelectionNodeOp.position = (op: EditOp) => {
        const h = history();
        const index = indexOf(op);
        return { index, applied: !!h && index >= 0 && index < h.cursor && !h.ops[index].bypassed };
    };

    // a wire into a combine node's input: replayed from the node, with it
    events.on('graph.connect', (op: EditOp, port: string, source: object) => {
        if (op instanceof CombineSelectOp && (port === 'a' || port === 'b') && isSelectionSource(source)) {
            const at = indexOf(op);
            if (at >= 0) events.invoke('edit.refresh', at, () => op.connect(port, source));
        }
    });
    events.on('graph.disconnect', (op: EditOp, port: string) => {
        if (op instanceof CombineSelectOp && (port === 'a' || port === 'b')) {
            const at = indexOf(op);
            if (at >= 0) events.invoke('edit.refresh', at, () => op.connect(port, null));
        }
    });
};

export { registerSelectionNodes };
