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
 * What edits on that object did not keep as nodes - colour and transform
 * nodes scoped to a selection, which an object's file has baked in, and
 * what was deleted where the select and delete nodes are not kept - is
 * kept beside it, row by row (storeMadeRows), and put back once the node
 * has made the object again (the rows come out the same for the same
 * inputs and settings).
 *
 * A layer node and an instance node are stored with their settings on
 * the object they are on.
 */

import { Mat4 } from 'playcanvas';

import { CombineOp, LayerOp, MergeOp, SwitchOp } from './combine-ops';
import type { EditOp } from './edit-ops';
import { Events } from './events';
import type { Grade } from './grade-palette';
import { IndexRanges } from './index-ranges';
import { InstanceOp } from './instance-ops';
import { mergedRotation } from './merge-build';
import { Scene } from './scene';
import { Splat } from './splat';
import { State } from './splat-state';
import { emptyData } from './split';

type Place = (op: EditOp | undefined) => { at?: number, pos?: number[] };

/**
 * The combining nodes of the history up to `cursor`, as a project stores
 * them, and the objects whose data the project does not write.
 */
const storeCombine = (ops: EditOp[], cursor: number, splats: Splat[], placeOf: Place) => {
    const outputs = new Set<number>();
    const combine: any[] = [];
    const layers: any[] = [];
    const instances: any[] = [];

    ops.slice(0, cursor).forEach((op) => {
        if (op instanceof CombineOp) {
            const output = splats.indexOf(op.output);
            const inputs = op.inputs.map(s => splats.indexOf(s));
            // a node whose object or inputs are not in the project cannot be made again
            if (inputs.some(i => i < 0)) return;
            if (output >= 0) outputs.add(output);
            // a node switched off has no object in the scene, so none in
            // the list: it goes back with an empty one of this name
            else if (!op.bypassed) return;
            combine.push({
                kind: op instanceof SwitchOp ? 'switch' : 'merge',
                output,
                ...(output < 0 ? { name: op.output?.name ?? '' } : {}),
                inputs,
                settings: JSON.parse(JSON.stringify((op as MergeOp | SwitchOp).settings)),
                bypassed: !!op.bypassed,
                ...placeOf(op)
            });
        } else if (op instanceof LayerOp) {
            const splat = splats.indexOf(op.splat);
            if (splat < 0) return;
            layers.push({ splat, settings: { ...op.settings }, bypassed: !!op.bypassed, ...placeOf(op) });
        } else if (op instanceof InstanceOp) {
            const splat = splats.indexOf(op.splat);
            if (splat < 0) return;
            instances.push({ splat, settings: JSON.parse(JSON.stringify(op.settings)), bypassed: !!op.bypassed, ...placeOf(op) });
        }
    });

    return { outputs, document: { combine, layers, instances } };
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

/**
 * What a merged object's rows carry that its node does not make: the
 * colour and transform slots of nodes scoped to a selection (a palette,
 * and an entry of it plus one per row, 0: none), and, with `withState`,
 * what is deleted and locked (a byte per row). Null when none of it is
 * there. Not the grades under a debug view, which has set them aside.
 */
const storeMadeRows = (splat: Splat, index: number, withState: boolean) => {
    const n = splat.splatData.numSplats;
    const meta: any = { rows: n };
    const files: { name: string, bytes: Uint8Array }[] = [];
    const bytesOf = (a: Uint16Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

    // the slots in use, as entries of a palette
    const bySlot = (texture: any, entry: (slot: number) => unknown) => {
        const slots = texture.lock() as Uint16Array;
        const rows = new Uint16Array(n);
        const palette: unknown[] = [];
        const entryOf = new Map<number, number>();
        for (let row = 0; row < n; row++) {
            const slot = slots[row];
            if (!slot) continue;
            let e = entryOf.get(slot);
            if (!e) {
                e = palette.push(entry(slot));
                entryOf.set(slot, e);
            }
            rows[row] = e;
        }
        texture.unlock();
        return palette.length ? { palette, rows } : null;
    };

    const grades = splat.debugViews.length ? null : bySlot(splat.gradeTexture, slot => splat.gradePalette.getGrade(slot));
    if (grades) {
        meta.grades = { file: `made_${index}.grades`, palette: grades.palette };
        files.push({ name: meta.grades.file, bytes: bytesOf(grades.rows) });
    }
    const mat = new Mat4();
    const transforms = bySlot(splat.transformTexture, (slot) => {
        splat.transformPalette.getTransform(slot, mat);
        return Array.from(mat.data);
    });
    if (transforms) {
        meta.transforms = { file: `made_${index}.transforms`, palette: transforms.palette };
        files.push({ name: meta.transforms.file, bytes: bytesOf(transforms.rows) });
    }
    if (withState) {
        const kept = splat.state.data.map(v => v & (State.deleted | State.locked));
        if (kept.some(v => v !== 0)) {
            meta.state = `made_${index}.state`;
            files.push({ name: meta.state, bytes: kept });
        }
    }
    return files.length ? { meta, files } : null;
};

type MadeRows = {
    rows: number,
    grades?: { palette: Grade[], rows: Uint16Array },
    transforms?: { palette: number[][], rows: Uint16Array },
    state?: Uint8Array
};

/** Read what storeMadeRows kept, or null. */
const readMadeRows = async (meta: any, read: (name: string) => Promise<Uint8Array>): Promise<MadeRows | null> => {
    if (!Number.isInteger(meta?.rows)) return null;
    // copied so the typed arrays start on an aligned offset
    const rows16 = async (name: string) => new Uint16Array((await read(name)).slice().buffer);
    const made: MadeRows = { rows: meta.rows };
    if (meta.grades?.file && Array.isArray(meta.grades.palette)) made.grades = { palette: meta.grades.palette, rows: await rows16(meta.grades.file) };
    if (meta.transforms?.file && Array.isArray(meta.transforms.palette)) made.transforms = { palette: meta.transforms.palette, rows: await rows16(meta.transforms.file) };
    if (typeof meta.state === 'string') made.state = (await read(meta.state)).slice();
    return made;
};

/** Put what readMadeRows read back on the object its node has made, if it has the rows it had. */
const applyMadeRows = async (splat: Splat, made: MadeRows) => {
    const n = splat.splatData.numSplats;
    if (made.rows !== n) {
        console.warn(`project: '${splat.name}' was made with ${made.rows} gaussians and now has ${n}; its scoped colour, transforms and deletes are left out`);
        return;
    }
    const setSlots = (texture: any, rows: Uint16Array, first: number) => {
        const data = texture.lock() as Uint16Array;
        for (let i = 0; i < n; i++) data[i] = rows[i] ? first + rows[i] - 1 : 0;
        texture.unlock();
    };
    if (made.grades?.palette.length && made.grades.rows.length === n) {
        const first = splat.gradePalette.alloc(made.grades.palette.length);
        made.grades.palette.forEach((grade, k) => splat.gradePalette.setGrade(first + k, grade));
        setSlots(splat.gradeTexture, made.grades.rows, first);
    }
    if (made.transforms?.palette.length && made.transforms.rows.length === n) {
        const first = splat.transformPalette.alloc(made.transforms.palette.length);
        const mat = new Mat4();
        made.transforms.palette.forEach((m, k) => {
            mat.data.set(m);
            splat.transformPalette.setTransform(first + k, mat);
        });
        setSlots(splat.transformTexture, made.transforms.rows, first);
        await splat.updatePositions();
    }
    if (made.state?.length === n) {
        [State.deleted, State.locked].forEach((bit) => {
            splat.state.setBits(IndexRanges.fromPredicate(n, i => (made.state[i] & bit) !== 0), bit);
        });
        await splat.updateState(State.deleted | State.locked);
    }
};

type Later = (stored: any, add: () => EditOp | null) => void;

/** Put the combining nodes back, in their places in the history. */
const restoreCombine = (document: any, loaded: Splat[], later: Later, events: Events, madeRows?: Map<number, MadeRows>) => {
    (Array.isArray(document?.combine) ? document.combine : []).forEach((stored: any) => {
        const inputs = (stored.inputs ?? []).map((i: number) => loaded[i]);
        // (none for a node switched off: it is made then, empty)
        const output = stored.output === -1 && stored.bypassed ? null : loaded[stored.output];
        if (output === undefined || !inputs.length || inputs.some((s: Splat) => !s)) return;
        const rows = madeRows?.get(stored.output);
        later(stored, () => {
            const op = events.invoke('combine.restoreNode', stored.kind, inputs, output, stored.settings, !!stored.bypassed, stored.name) as CombineOp | null;
            // made when it first applies, and its rows given back what they had
            if (op) op.pendingBuild = { after: rows ? s => applyMadeRows(s, rows) : undefined };
            return op;
        });
    });
    (Array.isArray(document?.layers) ? document.layers : []).forEach((stored: any) => {
        const splat = loaded[stored.splat];
        if (!splat) return;
        later(stored, () => events.invoke('layer.addNode', splat, { ...(stored.settings ?? {}), bypassed: !!stored.bypassed }));
    });
    (Array.isArray(document?.instances) ? document.instances : []).forEach((stored: any) => {
        const splat = loaded[stored.splat];
        if (!splat) return;
        later(stored, () => events.invoke('instance.addNode', splat, { ...(stored.settings ?? {}), bypassed: !!stored.bypassed }));
    });
};

export { storeCombine, combineOutputs, placeholderSplat, restoreCombine, storeMadeRows, readMadeRows, type MadeRows };
