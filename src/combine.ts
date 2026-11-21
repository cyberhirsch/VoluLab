/**
 * The editor's side of the combining nodes: making merge and switch nodes,
 * keeping their objects up to date, and working out what the layer nodes
 * come to.
 *
 * A merged object is made of its inputs as their lanes leave them - which
 * is what the graph draws: the wire into a merge comes from the end of the
 * input's lane. An edit to an input, before the merge in the history or
 * after it, so leaves the merged object stale, and once the history has
 * settled it is made again, in place, and the nodes standing on it are
 * applied again to the new data (edit.reapplyAll). Each input's baked part
 * is kept, so a change to one input or to a layer re-bakes that input
 * alone.
 */

import { CombineOp, LayerOp, MergeOp, SwitchOp, defaultLayerSettings, type CombineContext, type LayerSettings, type MergeSettings, type SwitchSettings } from './combine-ops';
import type { EditOp } from './edit-ops';
import { ElementType } from './element';
import { Events } from './events';
import { mergedRotation, type MergeBuilt } from './merge-build';
import { Scene } from './scene';
import { Splat } from './splat';

type LayerState = { hidden: boolean, opacity: number, locked: boolean };

const registerCombineEvents = (events: Events, scene: Scene) => {
    const history = () => (events.invoke('edit.history') ?? { ops: [], cursor: 0 }) as { ops: EditOp[], cursor: number };
    const openInGraph = (index: number) => events.fire('graph.selectIndex', index);
    const appendAndOpen = (op: EditOp) => {
        const index = history().cursor;
        events.fire('edit.add', op);
        openInGraph(index);
    };
    const allSplats = () => scene.getElementsByType(ElementType.splat) as Splat[];

    // ---- layers ----

    /**
     * What the layer nodes come to, per object. An object's own layers
     * compose: hidden if any is, the opacities multiplied, locked if any
     * is. Solo on any layer hides every object not in a soloed branch: an
     * object is in one when it is soloed, when what it feeds into is (a
     * merge soloed shows all of its inputs), or when it has a soloed input
     * (a merge with a soloed input shows - with only that input in it).
     */
    const layerStates = () => {
        const { ops, cursor } = history();
        // by whether each is applied, not by the cursor: a layer being redone
        // runs before the cursor moves past it
        const layers = ops.filter(o => o instanceof LayerOp && !o.bypassed && o.applied) as LayerOp[];
        const own = new Map<Splat, LayerState & { solo: boolean }>();
        layers.forEach((layer) => {
            const s = layer.settings;
            const was = own.get(layer.splat) ?? { hidden: false, opacity: 1, locked: false, solo: false };
            own.set(layer.splat, {
                hidden: was.hidden || !s.visible,
                opacity: was.opacity * Math.max(0, Math.min(1, s.opacity)),
                locked: was.locked || s.locked,
                solo: was.solo || s.solo
            });
        });
        const anySolo = [...own.values()].some(l => l.solo);

        // what feeds what, through the nodes that make objects of others
        const inputsOf = new Map<Splat, Splat[]>();
        const consumersOf = new Map<Splat, Splat[]>();
        ops.slice(0, cursor).forEach((op) => {
            const o = op as any;
            if (op.bypassed || !(o.output instanceof Splat) || !Array.isArray(o.inputs)) return;
            (o.inputs as Splat[]).forEach((input) => {
                if (!(input instanceof Splat)) return;
                inputsOf.set(o.output, [...(inputsOf.get(o.output) ?? []), input]);
                consumersOf.set(input, [...(consumersOf.get(input) ?? []), o.output]);
            });
        });
        const within = (s: Splat, seen = new Set<Splat>()): boolean => {
            if (seen.has(s)) return false;
            seen.add(s);
            return !!own.get(s)?.solo || (consumersOf.get(s) ?? []).some(c => within(c, seen));
        };
        const holds = (s: Splat, seen = new Set<Splat>()): boolean => {
            if (seen.has(s)) return false;
            seen.add(s);
            return within(s) || (inputsOf.get(s) ?? []).some(i => holds(i, seen));
        };

        return (s: Splat): LayerState => {
            const mine = own.get(s);
            return {
                hidden: !!mine?.hidden || (anySolo && !holds(s)),
                opacity: mine?.opacity ?? 1,
                locked: !!mine?.locked
            };
        };
    };

    let layersDirty = false;
    const applyLayers = () => {
        const stateOf = layerStates();
        allSplats().forEach((s) => {
            const state = stateOf(s);
            s.layerHidden = state.hidden;
            s.layerOpacity = state.opacity;
            s.layerLocked = state.locked;
        });
        scene.forceRender = true;
        layersDirty = true;
        events.fire('layers.changed');
    };

    // an object added later (a merge's output) takes the layers too
    events.on('scene.elementAdded', (element: any) => {
        if (element?.type === ElementType.splat) applyLayers();
    });

    events.function('layers.stateOf', (s: Splat) => layerStates()(s));

    // the layer nodes there are, in the order of the history, with where they stand
    events.function('layers.list', () => {
        const { ops, cursor } = history();
        return ops.map((op, index) => ({ op, index })).filter(({ op, index }) => op instanceof LayerOp && index < cursor);
    });

    // a change made from the layer list: the node's settings, replayed
    events.function('layers.set', (index: number, change: Partial<LayerSettings>) => {
        const op = history().ops[index];
        if (!(op instanceof LayerOp)) return null;
        return events.invoke('edit.refresh', index, () => Object.assign(op.settings, change));
    });

    const newLayer = (splat: Splat, settings: LayerSettings) => new LayerOp(splat, settings, applyLayers);

    events.on('graph.addLayerNode', (target?: Splat) => {
        const splats = target ? [target] : [events.invoke('selection') as Splat].filter(Boolean);
        splats.forEach((splat) => {
            const count = history().ops.filter(o => o instanceof LayerOp).length;
            appendAndOpen(newLayer(splat, defaultLayerSettings(splat.name ? `${splat.name}` : `layer ${count + 1}`)));
        });
    });

    // a layer node for an object with these settings: a project's come back through here
    events.function('layer.addNode', (splat: Splat, stored?: Partial<LayerSettings> & { bypassed?: boolean }) => {
        if (!splat) return null;
        const settings = { ...defaultLayerSettings(splat.name ?? 'layer'), ...(stored ?? {}) };
        const op = newLayer(splat, {
            name: String(settings.name ?? 'layer'),
            visible: settings.visible !== false,
            solo: !!settings.solo,
            locked: !!settings.locked,
            opacity: Number.isFinite(settings.opacity) ? Math.max(0, Math.min(1, settings.opacity)) : 1
        });
        op.bypassed = !!stored?.bypassed;
        events.fire('edit.add', op);
        return op;
    });

    // ---- merge and switch ----

    const context: CombineContext = {
        rate: () => events.invoke('timeline.frameRate') ?? 30,
        timelineFrames: () => events.invoke('timeline.frames') ?? 1,
        frame: () => events.invoke('timeline.frame') ?? 0,
        layer: (s: Splat) => {
            const state = layerStates()(s);
            return { included: !state.hidden, opacity: state.opacity };
        },
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
        const shown = allSplats().filter(s => s.visible && !s.layerHidden);
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
                layersDirty = false;
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
        // what feeds what may have changed with the history: solo follows it
        if (ops.some(o => o instanceof LayerOp)) applyLayers();
        if (!ops.slice(0, cursor).some(o => o instanceof CombineOp) && !layersDirty) return;
        if (pending) clearTimeout(pending);
        pending = setTimeout(() => {
            pending = null;
            check();
        }, 60);
    });

    events.function('combine.check', () => check());
};

export { registerCombineEvents };
