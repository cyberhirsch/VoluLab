/**
 * The editor's side of the combining nodes: making merge and switch nodes
 * and keeping their objects up to date.
 *
 * A merged object is made of its inputs as their lanes leave them - which
 * is what the graph draws: the wire into a merge comes from the end of the
 * input's lane. An edit to an input, before the merge in the history or
 * after it, so leaves the merged object stale, and once the history has
 * settled it is made again, in place, and the nodes standing on it are
 * applied again to the new data (edit.reapplyAll). Each input's baked part
 * is kept, so a change to one input re-bakes that input alone.
 */

import { CombineOp, MergeOp, SwitchOp, type CombineContext, type MergeSettings, type SwitchSettings } from './combine-ops';
import type { EditOp } from './edit-ops';
import { ElementType } from './element';
import { Events } from './events';
import { mergedRotation, type MergeBuilt } from './merge-build';
import { Scene } from './scene';
import { Splat } from './splat';

const registerCombineEvents = (events: Events, scene: Scene) => {
    const history = () => (events.invoke('edit.history') ?? { ops: [], cursor: 0 }) as { ops: EditOp[], cursor: number };
    const openInGraph = (index: number) => events.fire('graph.selectIndex', index);
    const appendAndOpen = (op: EditOp) => {
        const index = history().cursor;
        events.fire('edit.add', op);
        openInGraph(index);
    };
    const allSplats = () => scene.getElementsByType(ElementType.splat) as Splat[];

    // ---- merge and switch ----

    const context: CombineContext = {
        rate: () => events.invoke('timeline.frameRate') ?? 30,
        timelineFrames: () => events.invoke('timeline.frames') ?? 1,
        frame: () => events.invoke('timeline.frame') ?? 0,
        layer: () => ({ included: true, opacity: 1 }),
        asset: (built: MergeBuilt, name: string) => scene.assetLoader.createGSplatAsset(built.data, name)
    };

    // a frame for the spinner to show before a build holds the thread
    const breathe = () => new Promise<void>((resolve) => {
        setTimeout(resolve, 30);
    });

    const nameOf = (inputs: Splat[], kind: string) => {
        const names = inputs.map(s => s.name ?? 'object');
        return names.length <= 2 ? names.join(` ${kind === 'switch' ? '/' : '+'} `) : `${kind} of ${names.length}`;
    };

    /** Make a merge or switch node's object, and then the node. */
    const makeCombine = async (kind: 'merge' | 'switch', inputs: Splat[], settings?: Partial<MergeSettings & SwitchSettings>, open = true) => {
        const unique = inputs.filter((s, i) => s instanceof Splat && inputs.indexOf(s) === i);
        if (unique.length < (kind === 'merge' ? 2 : 1)) return null;

        events.fire('startSpinner');
        try {
            await breathe();
            const op: CombineOp = kind === 'merge' ?
                new MergeOp(scene, unique, null, context, settings) :
                new SwitchOp(scene, unique, null, context, settings);
            const built = op.build();
            const output = new Splat(context.asset(built, nameOf(unique, kind)), mergedRotation());
            if (built.motion) output.setMotion(built.motion);
            op.output = output;
            if (open) {
                appendAndOpen(op);
            } else {
                events.fire('edit.add', op);
            }
            return op;
        } finally {
            events.fire('stopSpinner');
        }
    };

    // Merge two objects into one. Dropped onto a merge node's object that
    // is still the merge's alone, the object joins that merge instead.
    events.function('graph.merge', (a: Splat, b: Splat) => {
        if (!a || !b || a === b) return null;
        const { ops, cursor } = history();
        const index = ops.findIndex((o, i) => i < cursor && o instanceof MergeOp && o.output === b);
        const untouched = index >= 0 && !ops.slice(index + 1, cursor).some(o => (o as any).splat === b || ((o as any).inputs ?? []).includes(b));
        if (untouched && !(ops[index] as MergeOp).inputs.includes(a)) {
            return events.invoke('graph.mergeInput', index, a);
        }
        return makeCombine('merge', [a, b]);
    });

    // an object as one more input of a merge or switch node
    events.function('graph.mergeInput', (index: number, splat: Splat) => {
        const op = history().ops[index];
        if (!(op instanceof CombineOp) || !splat || op.inputs.includes(splat) || splat === op.output) return null;
        return events.invoke('edit.refresh', index, () => {
            op.inputs.push(splat);
            if (op instanceof MergeOp) op.settings.names.push('');
        });
    });

    // an input taken out of a merge or switch node; it keeps at least one (merge: two)
    events.function('graph.mergeRemoveInput', (index: number, input: number) => {
        const op = history().ops[index];
        if (!(op instanceof CombineOp) || op.inputs.length <= (op instanceof MergeOp ? 2 : 1)) return null;
        return events.invoke('edit.refresh', index, () => {
            const [gone] = op.inputs.splice(input, 1);
            if (op instanceof MergeOp) op.settings.names.splice(input, 1);
            if (op instanceof SwitchOp) {
                op.settings.index = Math.min(op.settings.index, op.inputs.length - 1);
                op.settings.cuts = op.settings.cuts.filter(c => c.input !== input).map(c => ({ ...c, input: c.input > input ? c.input - 1 : c.input }));
            }
            // it was hidden by the merge; undo of the merge brings it back,
            // and so does leaving it
            if (gone) gone.visible = true;
        });
    });

    // what the add menu's entries take: the selected object first, then
    // every other object that is shown
    const shownWith = (target?: Splat) => {
        const first = target ?? events.invoke('selection') as Splat;
        const shown = allSplats().filter(s => s.visible);
        return first ? [first, ...shown.filter(s => s !== first)] : shown;
    };

    events.on('graph.addMergeNode', (target?: Splat) => {
        makeCombine('merge', shownWith(target));
    });

    events.on('graph.addSwitchNode', (target?: Splat) => {
        makeCombine('switch', shownWith(target));
    });

    // a merge or switch node from a project: its inputs, by object, and its settings
    events.function('combine.addNode', (kind: 'merge' | 'switch', inputs: Splat[], settings?: Partial<MergeSettings & SwitchSettings>, bypassed = false) => {
        return makeCombine(kind, inputs, settings, false).then((op) => {
            if (op) op.bypassed = bypassed;
            return op;
        });
    });

    // A merge or switch node from a project, with the object it makes there
    // already (empty: it is made again once the history has settled).
    events.function('combine.restoreNode', (kind: 'merge' | 'switch', inputs: Splat[], output: Splat, settings?: Partial<MergeSettings & SwitchSettings>, bypassed = false) => {
        if (!output || !inputs.length) return null;
        const op: CombineOp = kind === 'switch' ?
            new SwitchOp(scene, inputs, output, context, settings) :
            new MergeOp(scene, inputs, output, context, settings);
        op.bypassed = bypassed;
        // the merge hid them; it hides them again when it applies
        inputs.forEach((s) => {
            s.visible = true;
        });
        // a node switched off has no object in the scene
        if (bypassed) scene.remove(output);
        events.fire('edit.add', op);
        return op;
    });

    // ---- keeping merged objects up to date ----

    let checking = false;
    let again = false;
    const check = () => {
        if (checking) {
            again = true;
            return;
        }
        checking = true;
        events.invoke('queue', async () => {
            try {
                const { ops, cursor } = history();
                for (let i = 0; i < cursor; ++i) {
                    const op = ops[i];
                    if (!(op instanceof CombineOp) || op.bypassed || !op.applied || !op.stale) continue;
                    events.fire('startSpinner');
                    try {
                        await breathe();
                        await op.rebuild();
                    } finally {
                        events.fire('stopSpinner');
                    }
                    // the nodes on the output, again on its new data; queued,
                    // so after this
                    events.invoke('edit.reapplyAll', [op.output]);
                    again = true;
                    break;
                }
            } catch (error) {
                console.error(error);
            } finally {
                checking = false;
                if (again) {
                    again = false;
                    setTimeout(check, 0);
                }
            }
        });
    };

    let pending: ReturnType<typeof setTimeout> | null = null;
    events.on('edit.changed', () => {
        const { ops, cursor } = history();
        if (!ops.slice(0, cursor).some(o => o instanceof CombineOp)) return;
        if (pending) clearTimeout(pending);
        pending = setTimeout(() => {
            pending = null;
            check();
        }, 60);
    });

    events.function('combine.check', () => check());
};

export { registerCombineEvents };
