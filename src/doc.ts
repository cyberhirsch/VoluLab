import { ZipFileSystem, ZipReadFileSystem } from '@playcanvas/splat-transform';
import { Vec3 } from 'playcanvas';

import { restoreInspectNode, storeInspectNodes } from './doc-inspect';
import { storeLookNodes } from './doc-looks';
import { combineOutputs, placeholderSplat, restoreCombine, storeCombine } from './doc-combine';
import { restoreStateNode, storeStateNodes } from './doc-nodes';
import { DebugViewOp, EditOp, LightOp, PrimitiveOp, RelightOp, TransformNodeOp } from './edit-ops';
import { ElementType } from './element';
import { Events } from './events';
import { Grade } from './grade-palette';
import { IndexRanges } from './index-ranges';
import { BrowserFileSystem, BlobReadSource } from './io';
import { packKeys } from './keyframes';
import { recentFiles } from './recent-files';
import { Scene } from './scene';
import { SceneCamera } from './scene-camera';
import { SceneLight } from './scene-light';
import { ScenePrimitive } from './scene-primitive';
import { Splat } from './splat';
import { writeSplatFile } from './splat-serialize';
import { State } from './splat-state';
import { readGsv } from './tgh/gsv';
import { TghFrameSource } from './tgh/tgh-frame-source';
import { TghModel } from './tgh/tgh-model';
import { Transform } from './transform';
import { i18n } from './ui/localization';
import { Voxels } from './voxels';

// ts compiler and vscode find this type, but eslint does not
type FilePickerAcceptType = unknown;

/**
 * VoluLab projects are .vlp.
 *
 * The inherited .ssproj format described a scene this app no longer has:
 * no camera objects, no node settings, no workspace. Rather than keep
 * widening a format under someone else's name, .vlp is our own - and it
 * carries the whole session, settings and workspace included, so opening
 * a project puts you back exactly where you left off.
 *
 * Saving always writes .vlp. Opening still accepts .ssproj, because the
 * container is the same zip and an old project's splats, camera and view
 * still load - the parts that did not exist then simply come back at
 * their defaults.
 *
 * A 4D model is stored as the file it was read from (splat_<i>.npz or
 * .gsv in the place of splat_<i>.ply), and comes back as a 4D model: the
 * same gaussians in the same rows, playing. That file rather than one
 * written here, because it is the only form that is exact for every model
 * - one read from a compact GSV holds no 4D rotations, so the lossless
 * GSV writer refuses it, and the compact writer would quantise it again
 * and put its rows in another order - and because saving then encodes
 * nothing: no clustering on the GPU, and no second copy of the model in
 * memory. What it costs is the size of that file in every project.
 *
 * The nodes that select, hide and delete gaussians are stored as nodes
 * (doc-nodes.ts), so an object's file holds every gaussian it came with,
 * the deleted ones too, each in its row. Every stored node carries its
 * place in the history (`at`) and, where it was dragged somewhere in the
 * graph, that place (`pos`); opened, the nodes go back in in that order.
 */
const VLP_EXTENSION = '.vlp';

const VoluLabFileType: FilePickerAcceptType[] = [{
    description: 'VoluLab project',
    accept: {
        'application/x-volulab': [VLP_EXTENSION]
    }
}, {
    description: 'SuperSplat document (legacy)',
    accept: {
        'application/x-supersplat': ['.ssproj']
    }
}];

type FileSelectorCallback = (fileList: File) => void;

// helper class to show a file selector dialog.
// used when showOpenFilePicker is not available.
class FileSelector {
    show: (callbackFunc: FileSelectorCallback) => void;

    constructor() {
        const fileSelector = document.createElement('input');
        fileSelector.setAttribute('id', 'document-file-selector');
        fileSelector.setAttribute('type', 'file');
        fileSelector.setAttribute('accept', '.vlp,.ssproj');
        fileSelector.setAttribute('multiple', 'false');

        document.body.append(fileSelector);

        let callbackFunc: FileSelectorCallback = null;

        fileSelector.addEventListener('change', () => {
            callbackFunc(fileSelector.files[0]);
        });

        fileSelector.addEventListener('cancel', () => {
            callbackFunc(null);
        });

        this.show = (func: FileSelectorCallback) => {
            callbackFunc = func;
            fileSelector.click();
        };
    }
}

const registerDocEvents = (scene: Scene, events: Events) => {
    // construct the file selector
    const fileSelector = window.showOpenFilePicker ? null : new FileSelector();

    // this file handle is updated as the current document is loaded and saved
    let documentFileHandle: FileSystemFileHandle = null;

    // show the user a reset confirmation popup
    const getResetConfirmation = async () => {
        const result = await events.invoke('showPopup', {
            type: 'yesno',
            header: i18n.t('doc.reset'),
            message: i18n.t(events.invoke('scene.dirty') ? 'doc.unsaved-message' : 'doc.reset-message')
        });

        if (result.action !== 'yes') {
            return false;
        }

        return true;
    };

    // reset the scene
    const resetScene = () => {
        events.fire('scene.clear');
        events.fire('camera.reset');
        events.fire('doc.setName', null);
        documentFileHandle = null;
    };

    // one entry of a project's zip, whole
    const readEntry = async (zipFs: ZipReadFileSystem, name: string) => {
        const source = await zipFs.createSource(name);
        try {
            return await source.read().readAll();
        } finally {
            source.close();
        }
    };

    // A project's 4D model: read from the file it was stored as, set playing
    // as the sequence, and handed back as the object it plays in. The
    // gaussians the project had deleted or hidden are in `motion.state`, a
    // byte per row.
    const loadMotionSplat = async (zipFs: ZipReadFileSystem, motion: any, name: string) => {
        const format = String(motion.file).toLowerCase().endsWith('.gsv') ? 'gsv' : 'npz';
        const blob = new Blob([await readEntry(zipFs, motion.file) as BlobPart]);
        const model = format === 'gsv' ? await readGsv(blob) : await TghModel.fromNpz(blob);
        const frames = Math.max(1, Math.floor(motion.frames ?? model.meta.frames ?? 300));

        const source = new TghFrameSource(model, frames, scene, motion.name ?? name ?? 'model');
        source.origin = { blob, format };
        events.fire('sequence.setSource', source);
        // the timeline may have asked for the first frame already, in which
        // case this waits for it and has nothing left to load
        await events.invoke('plysequence.setFrameAsync', 0);
        const splat = events.invoke('sequence.splat') as Splat | null;
        if (!splat) {
            throw new Error(`'${motion.file}' did not load`);
        }

        if (motion.state) {
            const bytes = await readEntry(zipFs, motion.state);
            if (bytes.length === splat.splatData.numSplats) {
                [State.deleted, State.locked].forEach((bit) => {
                    splat.state.setBits(IndexRanges.fromPredicate(bytes.length, i => (bytes[i] & bit) !== 0), bit);
                });
                await splat.updateState(State.deleted | State.locked);
            }
        }

        // the grades colour nodes scoped to a selection left on it
        const palette = (motion.grades?.palette ?? []) as Grade[];
        if (palette.length) {
            // copied so the typed array starts on an aligned offset
            const rows = new Uint16Array((await readEntry(zipFs, motion.grades.file)).slice().buffer);
            if (rows.length === splat.splatData.numSplats) {
                const first = splat.gradePalette.alloc(palette.length);
                palette.forEach((grade, k) => splat.gradePalette.setGrade(first + k, grade));
                const slots = splat.gradeTexture.lock() as Uint16Array;
                for (let i = 0; i < rows.length; i++) {
                    slots[i] = rows[i] ? first + rows[i] - 1 : 0;
                }
                splat.gradeTexture.unlock();
            }
        }
        return splat;
    };

    // load the document from the given file
    const loadDocument = async (file: File) => {
        events.fire('startSpinner');

        // Create streaming ZIP reader from the file
        const blobSource = new BlobReadSource(file);
        const zipFs = new ZipReadFileSystem(blobSource);

        try {
            // the document's view settings are applied through the same events
            // as user changes - suspend preference capture so they don't
            // overwrite the user's stored preferences. resumed in the finally
            // below so a failed load can't leave capture suspended.
            events.fire('preferences.suspend');

            // reset the scene
            resetScene();

            // read document.json via streaming (only reads what's needed)
            const docSource = await zipFs.createSource('document.json');
            const docData = await docSource.read().readAll();
            docSource.close();
            const document = JSON.parse(new TextDecoder().decode(docData));

            // run through each splat and load it, keeping the order: nodes
            // that hang off an object refer to it by its place in the list
            const loaded: Splat[] = [];
            // the objects merge and switch nodes make, which have no file
            const made = combineOutputs(document);
            for (let i = 0; i < document.splats.length; ++i) {
                const filename = `splat_${i}.ply`;
                const splatSettings = document.splats[i];

                let splat: Splat;
                if (made.has(i)) {
                    // empty until its node makes it again
                    splat = placeholderSplat(scene, splatSettings.name);
                    await scene.add(splat);
                } else if (splatSettings.motion?.file) {
                    // a 4D model: it adds itself to the scene as the sequence
                    splat = await loadMotionSplat(zipFs, splatSettings.motion, splatSettings.name);
                } else {
                    // load splat directly from the zip filesystem (streams on-demand)
                    // skipReorder=true because ssproj PLY files are already in morton order
                    splat = await scene.assetLoader.load(filename, zipFs, false, true);

                    await scene.add(splat);
                }

                splat.docDeserialize(splatSettings);
                loaded.push(splat);
            }

            // FIXME: trigger scene bound calc in a better way
            const tmp = scene.bound;
            if (tmp === null) {
                console.error('this should never fire');
            }

            events.invoke('docDeserialize.timeline', document.timeline);
            events.invoke('docDeserialize.poseSets', document.poseSets, document.camera?.fov);
            events.invoke('docDeserialize.view', document.view);
            scene.camera.docDeserialize(document.camera);

            // camera objects come back as camera nodes, so they land in the
            // graph and in history the same way a fresh one does
            if (Array.isArray(document.cameras)) {
                for (const stored of document.cameras) {
                    const op = events.invoke('camera.addNode');
                    op?.output?.docDeserialize(stored);
                }
                events.fire('edit.changed');
                events.fire('camera.effects.refresh');
            }

            // primitives come back as primitive nodes, the same way - quietly,
            // taking neither the selection nor the graph's open node
            const primitiveOps: PrimitiveOp[] = [];
            if (Array.isArray(document.primitives)) {
                for (const stored of document.primitives) {
                    const op = events.invoke('primitive.addNode', stored?.kind, true);
                    op?.output?.docDeserialize(stored);
                    primitiveOps.push(op);
                }
                events.fire('edit.changed');
            }

            // voxel objects come back as voxel import nodes: the grid is
            // stored, not the node that made it
            if (Array.isArray(document.voxels)) {
                for (let i = 0; i < document.voxels.length; ++i) {
                    const stored = document.voxels[i];
                    const source = await zipFs.createSource(`voxels_${i}.bin`);
                    const bytes = await source.read().readAll();
                    source.close();
                    // copied so the typed arrays start on an aligned offset
                    const buffer = bytes.slice().buffer;
                    const count = stored.count;
                    events.invoke('vox.import', {
                        dims: stored.dims,
                        origin: new Vec3(stored.origin[0], stored.origin[1], stored.origin[2]),
                        cellSize: stored.cellSize,
                        cells: new Uint32Array(buffer, 0, count),
                        colors: new Float32Array(buffer, count * 4, stored.colors)
                    }, stored.name ?? 'voxels');
                }
                events.fire('edit.changed');
            }

            // lights come back as light nodes, the same way - without the relight
            // nodes a new light brings, since the project has its own
            const lightOps: LightOp[] = [];
            if (Array.isArray(document.lights)) {
                for (const stored of document.lights) {
                    const op = events.invoke('light.addNode', stored?.settings?.kind, false);
                    op?.output?.docDeserialize(stored);
                    lightOps.push(op);
                }
                events.fire('edit.changed');
            }

            // and what feeds a mesh or gauss light: a primitive or an object,
            // by their places in the lists. A select node is not kept, so a
            // light fed by one comes back with the emitters it last took.
            if (Array.isArray(document.lightSources)) {
                for (const stored of document.lightSources) {
                    const op = lightOps[stored?.light];
                    const source = typeof stored?.primitive === 'number' ? primitiveOps[stored.primitive]?.output :
                        (typeof stored?.splat === 'number' ? loaded[stored.splat] : null);
                    if (op && source) events.fire('light.rewire', op, source);
                }
            }

            // The nodes on the objects' chains - transform, relight, debug
            // view, and the ones that select and delete - go back in in the
            // order they were in: each is stored with its place in the
            // history. A project from before that has none, and its nodes go
            // in kind by kind, as they always did.
            const pending: { at: number, pos?: number[], add: () => EditOp | null }[] = [];
            const later = (stored: any, add: () => EditOp | null) => {
                pending.push({ at: Number.isFinite(stored?.at) ? stored.at : Infinity, pos: stored?.pos, add });
            };

            // transform nodes come back on the objects they were on, on top of
            // the placement each object was stored with
            if (Array.isArray(document.transforms)) {
                for (const stored of document.transforms) {
                    const splat = loaded[stored?.splat];
                    if (splat) {
                        later(stored, () => {
                            const op = events.invoke('transform.addNode', splat, stored);
                            // an align node's reference, by its place in the list
                            if (op && typeof stored.reference === 'number') op.reference = loaded[stored.reference] ?? null;
                            return op;
                        });
                    }
                }
            }

            // the nodes that transform over time (motion-nodes.ts), with
            // what a track node attaches, by its place in the list
            if (Array.isArray(document.motionNodes)) {
                for (const stored of document.motionNodes) {
                    const splat = loaded[stored?.splat];
                    if (splat) later(stored, () => events.invoke('motion.addNode', splat, { ...stored, targetSplat: loaded[stored.target] ?? null }));
                }
            }

            // relight nodes come back on the objects they were on. A project
            // from before relight nodes had one lighting for the whole scene,
            // and its lights relit every object - so each gets a node with it.
            if (Array.isArray(document.relights)) {
                for (const stored of document.relights) {
                    const splat = loaded[stored?.splat];
                    if (splat) later(stored, () => events.invoke('relight.addNode', splat, stored.settings));
                }
            } else if (Array.isArray(document.lights) && document.lights.length > 0) {
                for (const splat of loaded) {
                    later(null, () => events.invoke('relight.addNode', splat, document.lighting ?? {}));
                }
            }

            // debug view nodes too: they change no data, so the project holds
            // them as nodes or not at all
            // What colour nodes after a debug view put on its false colour
            // is stored with the node, and goes back on once the nodes are
            // applied (below).
            const debugGrades: { splat: Splat, stored: any, rows: Uint16Array | null }[] = [];
            if (Array.isArray(document.debugViews)) {
                for (const stored of document.debugViews) {
                    const splat = loaded[stored?.splat];
                    if (!splat) continue;
                    if (stored.bypassed) {
                        // one that was switched off: it shows nothing, and
                        // goes back in switched off
                        later(stored, () => {
                            const op = new DebugViewOp(splat, { channel: stored.channel });
                            op.bypassed = true;
                            events.fire('edit.add', op);
                            return op;
                        });
                        continue;
                    }
                    later(stored, () => events.invoke('debugView.addNode', splat, stored.channel));
                    if (stored.colour) {
                        let rows: Uint16Array | null = null;
                        if (stored.colour.palette?.length) {
                            const source = await zipFs.createSource(`debug_grade_${stored.splat}.bin`);
                            const bytes = await source.read().readAll();
                            source.close();
                            // copied so the typed array starts on an aligned offset
                            rows = new Uint16Array(bytes.slice().buffer);
                        }
                        debugGrades.push({ splat, stored: stored.colour, rows });
                    }
                }
            }

            // the cleanup and look nodes kept as nodes (doc-looks.ts)
            if (Array.isArray(document.looks)) {
                for (const stored of document.looks) {
                    const splat = loaded[stored?.splat];
                    if (splat) later(stored, () => events.invoke('look.restoreNode', stored, splat, (i: number) => loaded[i] ?? null));
                }
            }

            // the nodes that select, hide and delete: each with its settings
            // and the gaussians it applied to, which are in the object's
            // nodes file (see doc-nodes.ts)
            if (Array.isArray(document.nodes)) {
                const wordsOf = new Map<number, Uint32Array>();
                for (const stored of document.nodes) {
                    const splat = loaded[stored?.splat];
                    if (!splat) continue;
                    if (!wordsOf.has(stored.splat)) {
                        const name = document.splats[stored.splat]?.nodes;
                        // copied so the typed array starts on an aligned offset
                        wordsOf.set(stored.splat, name ? new Uint32Array((await readEntry(zipFs, name)).slice().buffer) : new Uint32Array(0));
                    }
                    const words = wordsOf.get(stored.splat);
                    later(stored, () => {
                        const op = restoreStateNode(stored, splat, primitiveOps.map(p => p?.output), words);
                        if (op) {
                            events.fire('edit.add', op);
                        } else {
                            console.warn(`project: a '${stored.type}' node is not known here and was left out`);
                        }
                        return op;
                    });
                }
            }

            // render passes, viewer, cache and stats nodes (doc-inspect.ts)
            if (Array.isArray(document.inspectNodes)) {
                for (const stored of document.inspectNodes) {
                    const splat = loaded[stored?.splat];
                    if (splat) later(stored, () => restoreInspectNode(stored, splat, events));
                }
            }
            // merge, switch and layer nodes (doc-combine.ts)
            restoreCombine(document, loaded, later, events);

            // in, in order (the sort is stable, so nodes without a place
            // keep the order they were listed in), and where they were put
            // in the graph
            pending.sort((a, b) => (a.at === b.at ? 0 : a.at - b.at));
            const place = (key: object | null, pos: any) => {
                if (key && Array.isArray(pos) && pos.length === 2 && pos.every(Number.isFinite)) {
                    events.fire('graph.setPosition', key, { x: pos[0], y: pos[1] });
                }
            };
            pending.forEach(({ pos, add }) => place(add(), pos));
            loaded.forEach((splat, i) => place(splat, document.splats[i]?.pos));
            events.fire('edit.changed');

            // the session around the scene. Preferences are applied inside a
            // suspend window already opened by the caller, so applying them
            // cannot be captured back as user changes.
            if (document.ui) {
                events.fire('docDeserialize.preferences', document.ui.preferences);
                events.fire('docDeserialize.layout', document.ui.layout);
            }

            // The nodes above went in through history so the graph shows them,
            // but they are what the project is, not edits made since opening
            // it: undo stops here, and the document starts clean.
            await events.invoke('edit.markLoaded');
            // (the nodes are applied now: the history's queue has run)
            debugGrades.forEach(({ splat, stored, rows }) => splat.docDeserializeDebugGrade(stored, rows));
            events.fire('doc.saved');

            // refresh the pivot to reflect the loaded transform
            const currentSelection = events.invoke('selection');
            if (currentSelection) {
                const pivot = events.invoke('pivot');
                const transform = new Transform();
                currentSelection.getPivot(transform);
                pivot.place(transform);
            }
        } catch (error) {
            await events.invoke('showPopup', {
                type: 'error',
                header: i18n.t('doc.load-failed'),
                message: `'${error.message ?? error}'`
            });
        } finally {
            // fire events before cleanup so a throwing close can't leave
            // preference capture suspended or the spinner running
            events.fire('preferences.resume');
            events.fire('stopSpinner');

            // Clean up resources
            zipFs.close();
        }
    };

    const saveDocument = async (options: { stream?: FileSystemWritableFileStream, filename?: string }) => {
        events.fire('startSpinner');

        try {
            // a viewer showing an earlier point gives the chain back first:
            // the project is the whole of it
            await events.invoke('viewer.stop');

            const splats = events.invoke('scene.allSplats') as Splat[];

            const cameras = (events.invoke('camera.list') ?? []) as SceneCamera[];
            const lights = (events.invoke('light.list') ?? []) as SceneLight[];
            const primitives = (events.invoke('primitive.list') ?? []) as ScenePrimitive[];
            const history = (events.invoke('edit.history')?.ops ?? []) as EditOp[];
            const voxels = scene.getElementsByType(ElementType.voxel) as Voxels[];
            const { ops: allOps, cursor } = events.invoke('edit.history') as { ops: EditOp[], cursor: number };

            // A 4D model playing on the GPU is stored as the file it was read
            // from. Where that file is not at hand the object is stored as
            // it always was: a still of the frame shown.
            const sequenceSource = events.invoke('sequence.source');
            const sequenceSplat = events.invoke('sequence.splat') as Splat | null;
            const motions = splats.map((s) => {
                const source = s === sequenceSplat && sequenceSource instanceof TghFrameSource ? sequenceSource : null;
                return source?.origin && s.motion && s.splatData.numSplats === source.model.numSplats ? source : null;
            });
            // Where a node stands in the history and in the graph, stored
            // with it so it goes back in the same place.
            const placeOf = (op: EditOp | undefined) => {
                const at = op ? allOps.indexOf(op) : -1;
                if (at < 0) return {};
                const pos = events.invoke('graph.position', op) as { x: number, y: number } | null;
                return { at, ...(pos ? { pos: [pos.x, pos.y] } : {}) };
            };

            // The nodes that select, hide and delete, object by object - or
            // null for an object they do not account for, which is stored
            // the old way: without them, and without what they deleted.
            const stateNodes = splats.map((s, i) => storeStateNodes(allOps, cursor, s, i, primitives));

            // merge, switch and layer nodes; a merged object's data is not written
            const combined = storeCombine(allOps, cursor, splats, placeOf);

            // what a 4D model has deleted or hidden, a byte per row, where
            // no nodes say it: its file holds every gaussian
            const motionStates = splats.map((s, i) => {
                if (!motions[i] || stateNodes[i]) return null;
                const kept = s.state.data.map(v => v & (State.deleted | State.locked));
                return kept.some(v => v !== 0) ? kept : null;
            });

            // The grade each of a 4D model's gaussians is on: what colour
            // nodes scoped to a selection came to. A PLY has them baked into
            // its colours; the model's file is not rewritten, so they are
            // stored beside it, as an entry of `palette` plus one per row
            // (0: none). Not under a debug view node, which has set the
            // model's own grades aside.
            const motionGrades = splats.map((s, i) => {
                if (!motions[i] || s.debugViews.length) return null;
                const slots = s.gradeTexture.lock() as Uint16Array;
                const rows = new Uint16Array(s.state.data.length);
                const palette: Grade[] = [];
                const entryOf = new Map<number, number>();
                for (let row = 0; row < rows.length; row++) {
                    const slot = slots[row];
                    if (!slot) continue;
                    let entry = entryOf.get(slot);
                    if (!entry) {
                        entry = palette.push(s.gradePalette.getGrade(slot));
                        entryOf.set(slot, entry);
                    }
                    rows[row] = entry;
                }
                s.gradeTexture.unlock();
                return palette.length ? { palette, rows } : null;
            });

            // the grades on each object's false colour, where a debug view shows one
            const debugGrades = splats.map((s, i) => {
                const stored = s.docSerializeDebugGrade();
                if (!stored?.rows || !(motions[i] || stateNodes[i])) return stored;
                // the rows are those not deleted; the object's file has them all
                const state = s.state.data;
                const rows = new Uint16Array(state.length);
                for (let row = 0, k = 0; row < state.length; row++) {
                    if ((state[row] & State.deleted) === 0) rows[row] = stored.rows[k++];
                }
                return { ...stored, rows };
            });

            // An object's transform nodes are kept as nodes, so the object is
            // stored where it stands without them and they go back on top.
            // Where no such placement exists the object is stored as it
            // stands and its transform nodes are not kept.
            const pack3 = (v: Vec3) => [v.x, v.y, v.z];
            const placements = splats.map((splat) => {
                const nodes = allOps.slice(0, cursor).filter(o => o instanceof TransformNodeOp && o.splat === splat && (o.applied || o.bypassed)) as TransformNodeOp[];
                const { entity } = splat;
                // a node placing the object per frame (motion-nodes.ts): the
                // object is stored where that node found it, under the
                // transform nodes before it, and the node goes back on top
                const moved = events.invoke('motion.placedFrom', splat, allOps, cursor) as { at: number, base: Transform } | null;
                const final = moved ? moved.base : new Transform(entity.getLocalPosition(), entity.getLocalRotation(), entity.getLocalScale());
                const under = nodes.filter(n => n.applied && (!moved || allOps.indexOf(n) < moved.at));
                const base = under.length ? TransformNodeOp.baseOf(final, under) : (moved || nodes.length ? final : null);
                return base ? { base, nodes } : null;
            });

            const document = {
                // .vlp starts its own numbering; an .ssproj is version 0 of a
                // different format and is detected by what it lacks
                format: 'vlp',
                // 2: a 4D model is stored as its own file, and the nodes
                // that select and delete are stored as nodes
                version: 2,
                camera: scene.camera.docSerialize(),
                view: events.invoke('docSerialize.view'),
                poseSets: events.invoke('docSerialize.poseSets'),
                timeline: events.invoke('docSerialize.timeline'),
                splats: splats.map((s, i) => {
                    const base = placements[i]?.base;
                    const source = motions[i];
                    const at = events.invoke('graph.position', s) as { x: number, y: number } | null;
                    return {
                        ...s.docSerialize(),
                        ...(at ? { pos: [at.x, at.y] } : {}),
                        // the file the sets of its nodes are in
                        ...(stateNodes[i]?.words ? { nodes: `nodes_${i}.bin` } : {}),
                        ...(base ? {
                            position: pack3(base.position),
                            rotation: [base.rotation.x, base.rotation.y, base.rotation.z, base.rotation.w],
                            scale: pack3(base.scale)
                        } : {}),
                        // a 4D model: its file, how many frames it plays
                        // over, and its deleted and hidden gaussians
                        ...(source ? {
                            motion: {
                                file: `splat_${i}.${source.origin.format}`,
                                frames: source.frameCount,
                                name: source.name,
                                ...(motionGrades[i] ? { grades: { file: `splat_${i}.grades`, palette: motionGrades[i].palette } } : {}),
                                ...(motionStates[i] ? { state: `splat_${i}.state` } : {})
                            }
                        } : {})
                    };
                }),

                // each object's transform nodes, in the order of its chain
                transforms: placements.flatMap((placed, i) => (placed?.nodes ?? []).map(node => ({
                    splat: i,
                    position: pack3(node.newt.position),
                    rotation: pack3(node.euler),
                    scale: pack3(node.newt.scale),
                    bypassed: !!node.bypassed,
                    // keyed parameters (keyframes.ts); the values above are
                    // the frame the project was saved on
                    ...(packKeys(node) ? { keys: packKeys(node) } : {}),
                    // an align or ground plane node: what it was worked out from
                    ...((node as any).docSettings ?? {}),
                    ...((node as any).reference instanceof Splat ? { reference: splats.indexOf((node as any).reference) } : {}),
                    ...placeOf(node)
                }))),

                // each object's select, hide and delete nodes
                nodes: stateNodes.flatMap(stored => (stored?.nodes ?? []).map((node) => {
                    const pos = events.invoke('graph.position', allOps[node.at]) as { x: number, y: number } | null;
                    return pos ? { ...node, pos: [pos.x, pos.y] } : node;
                })),

                // merge, switch and layer nodes
                ...combined.document,
                // the nodes that transform over time (motion-nodes.ts):
                // track, stabilise, time warp, motion scale, motion blur
                motionNodes: allOps.slice(0, cursor).flatMap((o) => {
                    const settings = events.invoke('motion.settings', o);
                    const i = settings ? splats.indexOf((o as any).splat) : -1;
                    if (i < 0) return [];
                    const keys = packKeys(o);
                    const target = (o as any).target instanceof Splat ? splats.indexOf((o as any).target) : -1;
                    return [{
                        ...settings,
                        splat: i,
                        bypassed: !!o.bypassed,
                        ...(target >= 0 ? { target } : {}),
                        ...(keys ? { keys } : {}),
                        ...placeOf(o)
                    }];
                }),

                // the camera objects: pose, lens, lock and their animation
                cameras: cameras.map(c => c.docSerialize()),

                // the lights
                lights: lights.map(l => l.docSerialize()),

                // the boxes, spheres and cylinders
                primitives: primitives.map(p => p.docSerialize()),

                // voxel objects; each grid's cells and colours are in voxels_<i>.bin
                voxels: voxels.map(v => ({
                    name: v.name,
                    dims: [...v.grid.dims],
                    origin: [v.grid.origin.x, v.grid.origin.y, v.grid.origin.z],
                    cellSize: v.grid.cellSize,
                    count: v.grid.cells.length,
                    colors: v.grid.colors.length
                })),

                // what feeds each mesh or gauss light, by places in the lists
                lightSources: lights.map((light, i) => {
                    const op = history.find(o => o instanceof LightOp && o.output === light) as LightOp;
                    const source = op?.source?.source;
                    if (source instanceof ScenePrimitive) return { light: i, primitive: primitives.indexOf(source) };
                    if (source instanceof Splat) return { light: i, splat: splats.indexOf(source) };
                    return null;
                }).filter(Boolean),

                // each object's relight node, by the object's place in the list
                relights: splats
                .map((s, i) => (s.relight ? {
                    splat: i,
                    settings: { ...s.relight },
                    ...placeOf(allOps.find(o => o instanceof RelightOp && o.settings === s.relight))
                } : null))
                .filter(Boolean),

                // each object's debug view nodes, in the order of its chain.
                // The last carries what colour nodes after it put on the
                // false colour (its per-gaussian part is in
                // debug_grade_<i>.bin); the object's own grade is with the
                // object, above, and in its file
                debugViews: splats.flatMap((s, i) => s.debugViews.map((view, k) => {
                    const colour = k === s.debugViews.length - 1 ? debugGrades[i] : null;
                    return {
                        splat: i,
                        channel: view.channel,
                        ...(colour ? { colour: { grade: colour.grade, palette: colour.palette } } : {}),
                        ...placeOf(allOps.find(o => o instanceof DebugViewOp && o.view === view))
                    };
                })).concat(allOps.slice(0, cursor).flatMap((o) => {
                    // and the ones switched off, which the object does not hold
                    const i = o instanceof DebugViewOp && o.bypassed ? splats.indexOf(o.splat) : -1;
                    return i < 0 ? [] : [{ splat: i, channel: (o as DebugViewOp).view.channel, bypassed: true, ...placeOf(o) }];
                })),

                // render passes, viewer, cache and stats nodes, with their settings
                inspectNodes: storeInspectNodes(allOps, cursor, splats, placeOf),
                // the cleanup and look nodes that are kept as nodes (doc-looks.ts)
                looks: storeLookNodes(allOps, cursor, splats, placeOf),

                // the session around the scene, so a project reopens in the
                // workspace it was authored in
                ui: {
                    layout: events.invoke('docSerialize.layout'),
                    preferences: events.invoke('docSerialize.preferences')
                }
            };

            const serializeSettings = {
                // even though we support saving selection state, we disable that for now
                // because including a uint8 array in the document PLY results in slow loading
                // path.
                keepStateData: false,
                keepWorldTransform: true,
                keepColorTint: true,
                // the sh-bands limit is stored with each object, so the data keeps every band
                keepSHBands: true
            };

            // Create browser filesystem and zip filesystem
            const browserFs = new BrowserFileSystem(options.filename, options.stream);
            const browserWriter = await browserFs.createWriter(options.filename);
            const zipFs = new ZipFileSystem(browserWriter);

            // Write document.json
            const docWriter = await zipFs.createWriter('document.json');
            await docWriter.write(new TextEncoder().encode(JSON.stringify(document)));
            await docWriter.close();

            // Write each splat as PLY, or a 4D model as its own file
            for (let i = 0; i < splats.length; ++i) {
                const source = motions[i];
                // made again by its merge or switch node
                if (combined.outputs.has(i)) continue;
                if (!source) {
                    // with its nodes stored, every gaussian: the nodes delete
                    await writeSplatFile([splats[i]], { ...serializeSettings, keepDeleted: !!stateNodes[i] }, 'ply', `splat_${i}.ply`, {}, zipFs);
                    continue;
                }

                // piece by piece: the file can be a few hundred megabytes
                const writer = await zipFs.createWriter(`splat_${i}.${source.origin.format}`);
                const reader = source.origin.blob.stream().getReader();
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    await writer.write(value);
                }
                await writer.close();

                if (motionStates[i]) {
                    const stateWriter = await zipFs.createWriter(`splat_${i}.state`);
                    await stateWriter.write(motionStates[i]);
                    await stateWriter.close();
                }

                if (motionGrades[i]) {
                    const { rows } = motionGrades[i];
                    const gradeWriter = await zipFs.createWriter(`splat_${i}.grades`);
                    await gradeWriter.write(new Uint8Array(rows.buffer, rows.byteOffset, rows.byteLength));
                    await gradeWriter.close();
                }
            }

            // the sets each object's nodes applied to
            for (let i = 0; i < splats.length; ++i) {
                const words = stateNodes[i]?.words;
                if (words) {
                    const writer = await zipFs.createWriter(`nodes_${i}.bin`);
                    await writer.write(words);
                    await writer.close();
                }
            }

            // and the grade each gaussian's false colour is on, a row per row of that file
            for (let i = 0; i < splats.length; ++i) {
                const rows = debugGrades[i]?.rows;
                if (rows) {
                    const writer = await zipFs.createWriter(`debug_grade_${i}.bin`);
                    await writer.write(new Uint8Array(rows.buffer, rows.byteOffset, rows.byteLength));
                    await writer.close();
                }
            }

            // Write each voxel grid: its cells, then its colours
            for (let i = 0; i < voxels.length; ++i) {
                const { cells, colors } = voxels[i].grid;
                const writer = await zipFs.createWriter(`voxels_${i}.bin`);
                await writer.write(new Uint8Array(cells.buffer, cells.byteOffset, cells.byteLength));
                await writer.write(new Uint8Array(colors.buffer, colors.byteOffset, colors.byteLength));
                await writer.close();
            }

            // Close zip (also closes underlying browser writer)
            await zipFs.close();
        } catch (error) {
            await events.invoke('showPopup', {
                type: 'error',
                header: i18n.t('doc.save-failed'),
                message: `'${error.message ?? error}'`
            });
        } finally {
            events.fire('stopSpinner');
        }
    };

    // handle user requesting a new document
    events.function('doc.new', async () => {
        if (!await getResetConfirmation()) {
            return false;
        }
        resetScene();
        // new documents start from the user's stored preferences rather than
        // whatever view state the previous document left behind
        events.fire('preferences.apply');
        return true;
    });

    // handle document file being dropped
    // NOTE: on chrome it's possible to get the FileSystemFileHandle from the DataTransferItem
    // (which would result in more seamless user experience), but this is not yet supported in
    // other browsers.
    events.function('doc.load', async (file: File, handle?: FileSystemFileHandle) => {
        if (!events.invoke('scene.empty') && !await getResetConfirmation()) {
            return false;
        }

        await loadDocument(file);

        events.fire('doc.setName', file.name);

        if (handle) {
            documentFileHandle = handle;
            recentFiles.add(handle);
        }
    });

    events.function('doc.open', async () => {
        if (!events.invoke('scene.empty') && !await getResetConfirmation()) {
            return false;
        }

        if (fileSelector) {
            fileSelector.show(async (file?: File) => {
                if (file) {
                    await loadDocument(file);
                }
            });
        } else {
            try {
                const fileHandles = await window.showOpenFilePicker({
                    id: 'VoluLabDocumentOpen',
                    multiple: false,
                    types: VoluLabFileType
                });

                if (fileHandles?.length === 1) {
                    const fileHandle = fileHandles[0];

                    // null file handle incase loadDocument fails
                    await loadDocument(await fileHandle.getFile());

                    // store file handle for subsequent saves
                    documentFileHandle = fileHandle;
                    events.fire('doc.setName', fileHandle.name);
                    recentFiles.add(fileHandle);
                }
            } catch (error) {
                if (error.name !== 'AbortError') {
                    console.error(error);
                }
            }
        }
    });

    events.function('doc.openRecent', async (fileHandle: FileSystemFileHandle) => {
        if (!events.invoke('scene.empty') && !await getResetConfirmation()) {
            return false;
        }

        try {
            if (await fileHandle.queryPermission({ mode: 'read' }) !== 'granted') {
                if (await fileHandle.requestPermission({ mode: 'read' }) !== 'granted') {
                    return false;
                }
            }

            await loadDocument(await fileHandle.getFile());

            // store file handle for subsequent saves
            documentFileHandle = fileHandle;
            events.fire('doc.setName', fileHandle.name);
            recentFiles.add(fileHandle);
        } catch (error) {
            if (error.name !== 'AbortError') {
                console.error(error);
                await events.invoke('showPopup', {
                    type: 'error',
                    header: i18n.t('popup.error-loading'),
                    message: `${error.message ?? error}`
                });
            }
        }
    });

    events.function('doc.save', async () => {
        if (documentFileHandle) {
            try {
                await saveDocument({
                    stream: await documentFileHandle.createWritable()
                });
                events.fire('doc.saved');
            } catch (error) {
                if (error.name !== 'AbortError' && error.name !== 'NotAllowedError') {
                    console.error(error);
                }
            }
        } else {
            await events.invoke('doc.saveAs');
        }
    });

    events.function('doc.saveAs', async () => {
        if (window.showSaveFilePicker) {
            try {
                const handle = await window.showSaveFilePicker({
                    id: 'VoluLabDocumentSave',
                    types: VoluLabFileType,
                    suggestedName: `scene${VLP_EXTENSION}`
                });
                await saveDocument({ stream: await handle.createWritable() });
                documentFileHandle = handle;
                events.fire('doc.setName', handle.name);
                events.fire('doc.saved');
                recentFiles.add(handle);
            } catch (error) {
                if (error.name !== 'AbortError') {
                    console.error(error);
                }
            }
        } else {
            await saveDocument({
                filename: `scene${VLP_EXTENSION}`
            });
            events.fire('doc.saved');
        }
    });

    // doc name

    let docName: string = null;

    const setDocName = (name: string) => {
        if (name !== docName) {
            docName = name;
            events.fire('doc.name', docName);
        }
    };

    events.function('doc.name', () => {
        return docName;
    });

    events.on('doc.setName', (name) => {
        setDocName(name);
    });
};

export { registerDocEvents };
