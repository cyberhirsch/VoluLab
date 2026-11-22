/**
 * The editor's side of the cleanup and look nodes: adding them from the
 * graph, wiring their inputs, and making them again from a project.
 */

import { isFieldNode } from './fields';
import { LOOK_NODES } from './nodes';
import { nameSplat, partName, StillMovingSplitOp, type StillPart } from './still-moving-split';
import { EditOp, type SplitBuilt } from '../edit-ops';
import { Events } from '../events';
import { Scene } from '../scene';
import { Splat } from '../splat';

const registerCleanupLook = (events: Events, scene: Scene) => {
    const history = () => (events.invoke('edit.history') ?? { ops: [], cursor: 0 }) as { ops: EditOp[], cursor: number };

    // as the editor's own: the new node's index is the cursor before the add
    const appendAndOpen = (op: EditOp) => {
        const index = history().cursor;
        events.fire('edit.add', op);
        events.fire('graph.selectIndex', index);
    };

    // the object named, made the current one, or the current one
    const targets = (splat?: Splat): Splat[] => {
        if (!splat) {
            const selected = events.invoke('selection') as Splat;
            return selected?.visible ? [selected] : [];
        }
        events.fire('selection', splat);
        return [splat];
    };

    const allSplats = () => (events.invoke('scene.allSplats') ?? []) as Splat[];

    /**
     * A still / moving split of `source`: the part that leaves is built
     * first, as a split node's is (editor.ts, graph.buildSplit), and then
     * the node exists.
     */
    const stillMovingSplit = async (source: Splat, settings: Partial<{ drift: number, fade: boolean, keep: StillPart }> = {}, open = true) => {
        if (!source) return null;
        const build = events.invoke('graph.buildSplit') as (source: Splat, rows: Uint32Array) => Promise<SplitBuilt>;
        if (!build) return null;
        // the settings as the node reads them, defaults filled in
        const probe = new StillMovingSplitOp(scene, source, null, null, build, settings);
        const rows = StillMovingSplitOp.rowsOf(source, probe.drift, probe.fade, probe.keep);
        const built = await build(source, rows);
        const output = new Splat(built.asset, built.rotation);
        if (built.motion) output.setMotion(built.motion);
        nameSplat(output, partName(source, probe.keep === 'still' ? 'moving' : 'still'));
        const op = new StillMovingSplitOp(scene, source, output, rows, build, settings);
        if (open) {
            appendAndOpen(op);
        } else {
            events.fire('edit.add', op);
        }
        return op;
    };
    events.function('look.stillMovingSplit', stillMovingSplit);

    events.on('graph.addLookNode', (kind: string, target?: Splat) => {
        const spec = LOOK_NODES.find(n => n.kind === kind);
        if (!spec) return;
        targets(target).forEach((splat) => {
            if (kind === 'stillMovingSplit') {
                stillMovingSplit(splat);
                return;
            }
            const op = spec.create?.(splat, allSplats().filter(s => s !== splat));
            if (op) appendAndOpen(op);
        });
    });

    /**
     * A node a project stored, on `splat`, appended to the history; null for
     * one not known here. `objects` resolves a stored object index.
     */
    events.function('look.restoreNode', (stored: any, splat: Splat, objects: (i: number) => Splat | null) => {
        if (!stored || !splat) return null;
        const op = LOOK_NODES.find(n => n.kind === stored.type)?.restore?.(splat, stored.settings, objects);
        if (!op) return null;
        if (stored.bypassed) op.bypassed = true;
        events.fire('edit.add', op);
        return op;
    });

    // what is wired into a node's input, replayed around the node
    const rewire = (op: EditOp, port: string, source: object | null) => {
        if (!isFieldNode(op) || !op.accepts?.(port, source)) return;
        const index = history().ops.indexOf(op);
        if (index >= 0) {
            events.invoke('edit.refresh', index, () => op.connect(port, source));
        }
    };
    events.on('graph.connect', (op: EditOp, port: string, source: object) => rewire(op, port, source));
    events.on('graph.disconnect', (op: EditOp, port: string) => rewire(op, port, null));
};

export { registerCleanupLook };
