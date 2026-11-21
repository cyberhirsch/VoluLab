/**
 * How a project keeps the combining nodes.
 *
 * A merge or switch node is stored as the node: its kind, its inputs by
 * their places in the project's list of objects, and its settings. Its
 * object is not written - it is made again from the inputs when the
 * project opens, as it would be after any edit to them. In the object
 * list it keeps its place (the nodes after it refer to it by that), as an
 * entry with its name, placement and grade and no file; it opens as an
 * empty object, which the node fills once the history has settled.
 *
 */

import { CombineOp, MergeOp, SwitchOp } from './combine-ops';
import type { EditOp } from './edit-ops';
import { Events } from './events';
import { mergedRotation } from './merge-build';
import { Scene } from './scene';
import { Splat } from './splat';
import { emptyData } from './split';

type Place = (op: EditOp | undefined) => { at?: number, pos?: number[] };

/**
 * The combining nodes of the history up to `cursor`, as a project stores
 * them, and the objects whose data the project does not write.
 */
const storeCombine = (ops: EditOp[], cursor: number, splats: Splat[], placeOf: Place) => {
    const outputs = new Set<number>();
    const combine: any[] = [];

    ops.slice(0, cursor).forEach((op) => {
        if (op instanceof CombineOp) {
            const output = splats.indexOf(op.output);
            const inputs = op.inputs.map(s => splats.indexOf(s));
            // a node whose object or inputs are not in the project cannot be made again
            if (inputs.some(i => i < 0)) return;
            if (output >= 0) outputs.add(output);
            combine.push({
                kind: op instanceof SwitchOp ? 'switch' : 'merge',
                output,
                inputs,
                settings: JSON.parse(JSON.stringify((op as MergeOp | SwitchOp).settings)),
                bypassed: !!op.bypassed,
                ...placeOf(op)
            });
        }
    });

    return { outputs, document: { combine } };
};

/** The objects of a project that a merge or switch node makes: they have no file. */
const combineOutputs = (document: any) => {
    const out = new Set<number>();
    (Array.isArray(document?.combine) ? document.combine : []).forEach((c: any) => {
        if (Number.isInteger(c?.output) && c.output >= 0) out.add(c.output);
    });
    return out;
};

/** What such an object opens as: nothing, until its node makes it. */
const placeholderSplat = (scene: Scene, name: string) => {
    const asset = scene.assetLoader.createGSplatAsset(emptyData(), name || 'merge');
    return new Splat(asset, mergedRotation());
};

type Later = (stored: any, add: () => EditOp | null) => void;

/** Put the combining nodes back, in their places in the history. */
const restoreCombine = (document: any, loaded: Splat[], later: Later, events: Events) => {
    (Array.isArray(document?.combine) ? document.combine : []).forEach((stored: any) => {
        const inputs = (stored.inputs ?? []).map((i: number) => loaded[i]);
        const output = loaded[stored.output];
        if (!output || !inputs.length || inputs.some((s: Splat) => !s)) return;
        later(stored, () => events.invoke('combine.restoreNode', stored.kind, inputs, output, stored.settings, !!stored.bypassed));
    });
};

export { storeCombine, combineOutputs, placeholderSplat, restoreCombine };
