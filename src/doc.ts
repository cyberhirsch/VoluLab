import { ZipFileSystem, ZipReadFileSystem } from '@playcanvas/splat-transform';
import { Vec3 } from 'playcanvas';

import { EditOp, LightOp, PrimitiveOp, TransformNodeOp } from './edit-ops';
import { ElementType } from './element';
import { Events } from './events';
import { BrowserFileSystem, BlobReadSource } from './io';
import { recentFiles } from './recent-files';
import { Scene } from './scene';
import { SceneCamera } from './scene-camera';
import { SceneLight } from './scene-light';
import { ScenePrimitive } from './scene-primitive';
import { Splat } from './splat';
import { writeSplatFile } from './splat-serialize';
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
            for (let i = 0; i < document.splats.length; ++i) {
                const filename = `splat_${i}.ply`;
                const splatSettings = document.splats[i];

                // load splat directly from the zip filesystem (streams on-demand)
                // skipReorder=true because ssproj PLY files are already in morton order
                const splat = await scene.assetLoader.load(filename, zipFs, false, true);

                await scene.add(splat);

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

            // transform nodes come back on the objects they were on, on top of
            // the placement each object was stored with
            if (Array.isArray(document.transforms)) {
                for (const stored of document.transforms) {
                    const splat = loaded[stored?.splat];
                    if (splat) events.invoke('transform.addNode', splat, stored);
                }
                events.fire('edit.changed');
            }

            // relight nodes come back on the objects they were on. A project
            // from before relight nodes had one lighting for the whole scene,
            // and its lights relit every object - so each gets a node with it.
            if (Array.isArray(document.relights)) {
                for (const stored of document.relights) {
                    const splat = loaded[stored?.splat];
                    if (splat) events.invoke('relight.addNode', splat, stored.settings);
                }
                events.fire('edit.changed');
            } else if (Array.isArray(document.lights) && document.lights.length > 0) {
                for (const splat of loaded) {
                    events.invoke('relight.addNode', splat, document.lighting ?? {});
                }
                events.fire('edit.changed');
            }

            // debug view nodes too: they change no data, so the project holds
            // them as nodes or not at all
            if (Array.isArray(document.debugViews)) {
                for (const stored of document.debugViews) {
                    const splat = loaded[stored?.splat];
                    if (splat) events.invoke('debugView.addNode', splat, stored.channel);
                }
                events.fire('edit.changed');
            }

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
            const splats = events.invoke('scene.allSplats') as Splat[];

            const cameras = (events.invoke('camera.list') ?? []) as SceneCamera[];
            const lights = (events.invoke('light.list') ?? []) as SceneLight[];
            const primitives = (events.invoke('primitive.list') ?? []) as ScenePrimitive[];
            const history = (events.invoke('edit.history')?.ops ?? []) as EditOp[];
            const voxels = scene.getElementsByType(ElementType.voxel) as Voxels[];

            // An object's transform nodes are kept as nodes, so the object is
            // stored where it stands without them and they go back on top.
            // Where no such placement exists the object is stored as it
            // stands and its transform nodes are not kept.
            const pack3 = (v: Vec3) => [v.x, v.y, v.z];
            const { ops: allOps, cursor } = events.invoke('edit.history') as { ops: EditOp[], cursor: number };
            const placements = splats.map((splat) => {
                const nodes = allOps.slice(0, cursor).filter(o => o instanceof TransformNodeOp && o.splat === splat && (o.applied || o.bypassed)) as TransformNodeOp[];
                const { entity } = splat;
                const base = nodes.length ? TransformNodeOp.baseOf(
                    new Transform(entity.getLocalPosition(), entity.getLocalRotation(), entity.getLocalScale()),
                    nodes.filter(n => n.applied)
                ) : null;
                return base ? { base, nodes } : null;
            });

            const document = {
                // .vlp starts its own numbering; an .ssproj is version 0 of a
                // different format and is detected by what it lacks
                format: 'vlp',
                version: 1,
                camera: scene.camera.docSerialize(),
                view: events.invoke('docSerialize.view'),
                poseSets: events.invoke('docSerialize.poseSets'),
                timeline: events.invoke('docSerialize.timeline'),
                splats: splats.map((s, i) => {
                    const base = placements[i]?.base;
                    return !base ? s.docSerialize() : {
                        ...s.docSerialize(),
                        position: pack3(base.position),
                        rotation: [base.rotation.x, base.rotation.y, base.rotation.z, base.rotation.w],
                        scale: pack3(base.scale)
                    };
                }),

                // each object's transform nodes, in the order of its chain
                transforms: placements.flatMap((placed, i) => (placed?.nodes ?? []).map(node => ({
                    splat: i,
                    position: pack3(node.newt.position),
                    rotation: pack3(node.euler),
                    scale: pack3(node.newt.scale),
                    bypassed: !!node.bypassed
                }))),

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
                .map((s, i) => (s.relight ? { splat: i, settings: { ...s.relight } } : null))
                .filter(Boolean),

                // each object's debug view nodes, in the order of its chain
                debugViews: splats.flatMap((s, i) => s.debugViews.map(view => ({ splat: i, channel: view.channel }))),

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

            // Write each splat as PLY
            for (let i = 0; i < splats.length; ++i) {
                await writeSplatFile([splats[i]], serializeSettings, 'ply', `splat_${i}.ply`, {}, zipFs);
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
