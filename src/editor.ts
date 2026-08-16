import { MemoryFileSystem } from '@playcanvas/splat-transform';
import { Color, Mat4, path, Quat, Texture, Vec3, Vec4 } from 'playcanvas';

import { EditHistory } from './edit-history';
import { EditOp, SelectAllOp, SelectNoneOp, SelectInvertOp, SelectOp, SelectMode, HideSelectionOp, UnhideAllOp, DeleteSelectionOp, CleanupOp, CropOp, DecimateOp, OutputOp, ResetOp, MultiOp, AddSplatOp, SetLocalFrameOp, SetShBandsOp, SetSplatColorAdjustmentOp } from './edit-ops';
import { Element, ElementType } from './element';
import { Events } from './events';
import { IndexRanges } from './index-ranges';
import type { GridPlane } from './infinite-grid';
import { MappedReadFileSystem } from './io';
import { Scene } from './scene';
import { RangeQuery, SelectQuery } from './select-query';
import { Splat } from './splat';
import { writeSplatFile } from './splat-serialize';
import { State } from './splat-state';

const removeExtension = (filename: string) => {
    return filename.substring(0, filename.length - path.getExtension(filename).length);
};

// register for editor and scene events
const registerEditorEvents = (events: Events, editHistory: EditHistory, scene: Scene) => {
    const vec = new Vec3();
    const vec2 = new Vec3();
    const vec4 = new Vec4();
    const mat = new Mat4();
    const SH_C0 = 0.28209479177387814;

    const decodeColorChannel = (value: number) => {
        return Math.min(1, Math.max(0, 0.5 + value * SH_C0));
    };

    // get the list of selected splats (currently limited to just a single one)
    const selectedSplats = () => {
        const selected = events.invoke('selection') as Splat;
        return selected?.visible ? [selected] : [];
    };

    let lastExportCursor = 0;

    // add unsaved changes warning message.
    window.addEventListener('beforeunload', (e) => {
        if (!events.invoke('scene.dirty')) {
            // if the undo cursor matches last export, then we have no unsaved changes
            return undefined;
        }

        const msg = 'You have unsaved changes. Are you sure you want to leave?';
        e.returnValue = msg;
        return msg;
    });

    events.function('targetSize', () => {
        return scene.targetSize;
    });

    events.on('scene.clear', () => {
        scene.clear();
        editHistory.clear();
        lastExportCursor = 0;
    });

    // When a splat is removed from the scene, remove all edit operations that reference it
    events.on('scene.elementRemoved', (element: Element) => {
        if (element.type === ElementType.splat) {
            editHistory.removeForSplat(element as Splat);
        }
    });

    events.function('scene.dirty', () => {
        return editHistory.cursor !== lastExportCursor;
    });

    events.on('doc.saved', () => {
        lastExportCursor = editHistory.cursor;
    });

    // force render on some events

    [
        'camera.mode', 'camera.overlay', 'camera.splatSize', 'view.outlineSelection',
        'view.centersUseGaussianColor', 'view.bands', 'camera.bound', 'camera.boundDimensions', 'camera.showPoses',
        'camera.showInfo', 'selection.changed', 'tool.coordSpace'
    ].forEach((eventName) => {
        events.on(eventName, () => {
            scene.forceRender = true;
        });
    });

    // grid.visible

    const setGridVisible = (visible: boolean) => {
        if (visible !== scene.grid.visible) {
            scene.grid.visible = visible;
            events.fire('grid.visible', visible);
        }
    };

    events.function('grid.visible', () => {
        return scene.grid.visible;
    });

    events.on('grid.setVisible', (visible: boolean) => {
        setGridVisible(visible);
    });

    events.on('grid.toggleVisible', () => {
        setGridVisible(!scene.grid.visible);
    });

    setGridVisible(scene.config.show.grid);

    // grid.plane

    const setGridPlane = (plane: GridPlane) => {
        if (plane !== scene.grid.plane) {
            scene.grid.plane = plane;
            events.fire('grid.plane', plane);
        }
    };

    events.function('grid.plane', () => {
        return scene.grid.plane;
    });

    events.on('grid.setPlane', (plane: GridPlane) => {
        setGridPlane(plane);
    });

    // camera.fovDolly

    let fovDolly = false;

    const setFovDolly = (value: boolean) => {
        if (value !== fovDolly) {
            fovDolly = value;
            events.fire('camera.fovDolly', fovDolly);
        }
    };

    events.function('camera.fovDolly', () => {
        return fovDolly;
    });

    events.on('camera.setFovDolly', (value: boolean) => {
        setFovDolly(value);
    });

    // camera.fov

    const setCameraFov = (fov: number) => {
        const { camera } = scene;
        if (fov !== camera.fov) {
            const oldFovFactor = camera.fovFactor;
            camera.fov = fov;

            // by default a fov change acts like a lens zoom: scale distance so
            // the camera's world-space offset from the focal point (distance *
            // sceneRadius / fovFactor) is unchanged. with auto-dolly enabled
            // the camera moves instead, preserving the subject's framing.
            if (!fovDolly) {
                const { controls } = scene.config;
                const k = camera.fovFactor / oldFovFactor;
                const t = camera.distanceTween;
                for (const s of [t.value, t.source, t.target]) {
                    s.distance = Math.max(controls.minZoom, Math.min(controls.maxZoom, s.distance * k));
                }
            }

            events.fire('camera.fov', camera.fov);
        }
    };

    events.function('camera.fov', () => {
        return scene.camera.fov;
    });

    events.on('camera.setFov', (fov: number) => {
        setCameraFov(fov);
    });

    // camera.tonemapping

    events.function('camera.tonemapping', () => {
        return scene.camera.tonemapping;
    });

    events.on('camera.setTonemapping', (value: string) => {
        scene.camera.tonemapping = value;
    });

    // camera.bound

    let bound = scene.config.show.bound;

    const setBoundVisible = (visible: boolean) => {
        if (visible !== bound) {
            bound = visible;
            events.fire('camera.bound', bound);
        }
    };

    events.function('camera.bound', () => {
        return bound;
    });

    events.on('camera.setBound', (value: boolean) => {
        setBoundVisible(value);
    });

    events.on('camera.toggleBound', () => {
        setBoundVisible(!events.invoke('camera.bound'));
    });

    // camera.boundDimensions

    let boundDimensions = scene.config.show.boundDimensions;

    const setBoundDimensionsVisible = (visible: boolean) => {
        if (visible !== boundDimensions) {
            boundDimensions = visible;
            events.fire('camera.boundDimensions', boundDimensions);
        }
    };

    events.function('camera.boundDimensions', () => {
        return boundDimensions;
    });

    events.on('camera.setBoundDimensions', (value: boolean) => {
        setBoundDimensionsVisible(value);
    });

    events.on('camera.toggleBoundDimensions', () => {
        setBoundDimensionsVisible(!events.invoke('camera.boundDimensions'));
    });

    // camera.showPoses

    let showPoses = scene.config.show.cameraPoses;

    const setShowPoses = (visible: boolean) => {
        if (visible !== showPoses) {
            showPoses = visible;
            events.fire('camera.showPoses', showPoses);
        }
    };

    events.function('camera.showPoses', () => {
        return showPoses;
    });

    events.on('camera.setShowPoses', (value: boolean) => {
        setShowPoses(value);
    });

    events.on('camera.toggleShowPoses', () => {
        setShowPoses(!events.invoke('camera.showPoses'));
    });

    // camera.showInfo

    let showInfo = scene.config.show.cameraInfo;

    const setShowInfo = (visible: boolean) => {
        if (visible !== showInfo) {
            showInfo = visible;
            events.fire('camera.showInfo', showInfo);
        }
    };

    events.function('camera.showInfo', () => {
        return showInfo;
    });

    events.on('camera.setShowInfo', (value: boolean) => {
        setShowInfo(value);
    });

    events.on('camera.toggleShowInfo', () => {
        setShowInfo(!events.invoke('camera.showInfo'));
    });

    // camera.focus

    events.on('camera.focus', () => {
        // the active tool's focus target (e.g. orient points) takes precedence
        const toolFocus: { position: Vec3, radius: number } | null = events.invoke('tool.focus');
        if (toolFocus) {
            scene.camera.focus({
                focalPoint: toolFocus.position,
                radius: toolFocus.radius,
                speed: 1
            });
            return;
        }

        const splat = selectedSplats()[0];
        if (splat) {
            // use current bounds (caller should have awaited the operation that changed data)
            const bound = splat.numSelected > 0 ?
                splat.selectionBound :
                splat.localBound;
            vec.copy(bound.center);

            const worldTransform = splat.worldTransform;
            worldTransform.transformPoint(vec, vec);
            worldTransform.getScale(vec2);

            scene.camera.focus({
                focalPoint: vec,
                radius: bound.halfExtents.length() * vec2.x,
                speed: 1
            });
        }
    });

    // pivot.reset

    // reset the selection's local frame back to the model's own frame, or,
    // with toCenter, to the bound center (the selection bound while gaussians
    // are selected). resets orientation in both cases
    events.on('pivot.reset', (toCenter: boolean) => {
        const splat = selectedSplats()[0];
        if (!splat) {
            return;
        }

        const bound = splat.numSelected > 0 ? splat.selectionBound : splat.localBound;
        const newOrigin = toCenter ? bound.center.clone() : new Vec3();
        const newFrame = new Quat();

        if (splat.localFrameOrigin.equals(newOrigin) && splat.localFrame.equals(newFrame)) {
            return;
        }

        events.fire('edit.add', new SetLocalFrameOp({
            splat,
            oldOrigin: splat.localFrameOrigin.clone(),
            oldFrame: splat.localFrame.clone(),
            newOrigin,
            newFrame
        }));
    });

    events.on('camera.reset', () => {
        const { initialAzim, initialElev, initialZoom } = scene.config.controls;
        const x = Math.sin(initialAzim * Math.PI / 180) * Math.cos(initialElev * Math.PI / 180);
        const y = -Math.sin(initialElev * Math.PI / 180);
        const z = Math.cos(initialAzim * Math.PI / 180) * Math.cos(initialElev * Math.PI / 180);
        const zoom = initialZoom;

        scene.camera.setPose(new Vec3(x * zoom, y * zoom, z * zoom), new Vec3(0, 0, 0));
    });

    // handle camera align events
    events.on('camera.align', (axis: string) => {
        switch (axis) {
            case 'px': scene.camera.setAzimElev(90, 0); break;
            case 'py': scene.camera.setAzimElev(0, -90); break;
            case 'pz': scene.camera.setAzimElev(0, 0); break;
            case 'nx': scene.camera.setAzimElev(270, 0); break;
            case 'ny': scene.camera.setAzimElev(0, 90); break;
            case 'nz': scene.camera.setAzimElev(180, 0); break;
        }

        // switch to ortho mode
        scene.camera.ortho = true;
    });

    // returns true if the selected splat has selected gaussians
    events.function('selection.splats', () => {
        const splat = events.invoke('selection') as Splat;
        return splat?.numSelected > 0;
    });

    events.on('select.all', () => {
        selectedSplats().forEach((splat) => {
            events.fire('edit.add', new SelectAllOp(splat));
        });
    });

    events.on('select.none', () => {
        selectedSplats().forEach((splat) => {
            events.fire('edit.add', new SelectNoneOp(splat));
        });
    });

    events.on('select.invert', () => {
        selectedSplats().forEach((splat) => {
            events.fire('edit.add', new SelectInvertOp(splat));
        });
    });

    // The view a screen-space gesture was made on. A lasso or a rectangle is
    // meaningless without it, so the query carries a copy rather than looking
    // the camera up again when it re-runs.
    const capturedView = () => {
        const cam = scene.camera.camera;
        return new Mat4().mul2(cam.projectionMatrix, cam.viewMatrix);
    };

    // A hit set with no parameters behind it. Used where the intent genuinely
    // is "these gaussians" - see the note in select-query.ts.
    const freeze = (source: string, sel: Uint8Array | Uint32Array, numSplats: number): SelectQuery => {
        return {
            kind: 'frozen',
            source,
            hits: sel instanceof Uint32Array ?
                IndexRanges.fromSorted(sel) :
                IndexRanges.fromPredicate(numSplats, i => sel[i] === 255)
        };
    };

    /** The node the graph currently has open, if any. */
    let openNode: number | null = null;

    events.on('graph.selected', (selected: { index: number | null }) => {
        openNode = selected?.index ?? null;
    });

    const history = () => (events.invoke('edit.history') ?? { ops: [], cursor: 0 }) as
        { ops: EditOp[], cursor: number };

    /**
     * The node an edit should go into, or null to start a new one.
     *
     * Two ways an edit lands on an existing node. The node is open in the
     * graph, which is an explicit "edit this one". Or it is the last thing that
     * happened, which is the ordinary case of carrying on with what you were
     * doing - nudging a slider, redrawing a selection - and is what stops every
     * twitch from leaving another node behind.
     *
     * Anything further back is left alone: reaching over a later edit to change
     * an earlier one is a real intention, and it needs to be stated by opening
     * that node rather than inferred from a gesture.
     */
    const nodeToEdit = (splat: Splat, matches: (op: EditOp) => boolean) => {
        const { ops, cursor } = history();

        if (openNode !== null && ops[openNode] && matches(ops[openNode]) &&
            (ops[openNode] as any).splat === splat) {
            return openNode;
        }

        const last = cursor - 1;
        if (last >= 0 && ops[last] && matches(ops[last]) && (ops[last] as any).splat === splat &&
            cursor === ops.length) {
            return last;
        }

        return null;
    };

    /** Put the graph's cursor on a node, so the next edit continues it. */
    const openInGraph = (index: number) => events.fire('graph.selectIndex', index);

    /**
     * A selection gesture goes into the select node being worked on.
     *
     * Every mode folds in, because refining a selection - draw, extend, trim -
     * is one act of selecting. The node keeps the steps and states the result,
     * so the graph gains a node when you ask for one, not whenever the
     * selection moves.
     */
    const addSelect = (splat: Splat, mode: SelectMode, query: SelectQuery) => {
        const target = nodeToEdit(splat, op => op instanceof SelectOp);

        if (target !== null) {
            const existing = history().ops[target] as SelectOp;
            events.invoke('edit.reselect', target,
                mode === 'set' ? [{ mode, query }] : [...existing.steps, { mode, query }]);
            return;
        }

        events.fire('edit.add', new SelectOp(splat, [{ mode, query }]));
    };

    /**
     * A colour change, folded into the colour node being worked on.
     *
     * The panel applies its change live and hands over an op describing it.
     * Merging keeps the target's oldState - where the whole session started -
     * and takes the new values, so one node covers the session and undo steps
     * over all of it at once.
     */
    events.function('edit.addColour', (op: SetSplatColorAdjustmentOp) => {
        const target = nodeToEdit(op.splat, o => o.name === 'setSplatColor');
        if (target === null) {
            events.fire('edit.add', op);
            return;
        }

        const existing = history().ops[target] as SetSplatColorAdjustmentOp;
        existing.newState = op.newState;
        // the panel already applied it, so a replay is only needed when the
        // node being edited is not the last thing applied
        if (target === history().cursor - 1) {
            events.fire('edit.changed');
        } else {
            events.invoke('edit.refresh', target);
        }
    });

    // Adding is always a new node, never a reuse - it is the way to say "a
    // second one of these", which is what stops the reuse above from being a
    // limit of one node per kind.
    const appendAndOpen = (op: EditOp) => {
        // An add drops whatever was ahead of the cursor and pushes, so the new
        // op's index is the cursor as it stands now. Worked out before firing,
        // because the add is queued and has not happened yet.
        const index = history().cursor;
        events.fire('edit.add', op);
        openInGraph(index);
    };

    // The object a node is being added to. Dragging out of a node's port names
    // it explicitly; the menu on empty canvas has only the current selection
    // to go on.
    const addTarget = (splat?: Splat) => {
        if (!splat) return selectedSplats();
        // the new node belongs to this object, so make it the current one -
        // the node pane and the viewport tools both follow the selection
        events.fire('selection', splat);
        return [splat];
    };

    // A crop starts around what it is cropping, so the volume is something to
    // shrink rather than something to hunt for.
    events.on('graph.addCropNode', (target?: Splat) => {
        addTarget(target).forEach((splat) => {
            const bound = splat.worldBound;
            // a little wider than the object: sitting exactly on the bound puts
            // every surface gaussian on the boundary, and adding a crop node
            // should not delete anything until it is actually tightened
            const size = Math.max(bound.halfExtents.x, bound.halfExtents.y, bound.halfExtents.z) * 2.1;
            const m = new Mat4();
            m.setTRS(bound.center, Quat.IDENTITY, new Vec3(size, size, size));
            appendAndOpen(new CropOp(splat, 'box', m, true));
        });
    });

    events.on('graph.addCleanupNode', (target?: Splat) => {
        addTarget(target).forEach(splat => appendAndOpen(new CleanupOp(splat)));
    });

    events.on('graph.addDecimateNode', (target?: Splat) => {
        addTarget(target).forEach(splat => appendAndOpen(new DecimateOp(splat, 0.5)));
    });

    events.on('graph.addShBandsNode', (target?: Splat) => {
        addTarget(target).forEach(splat => appendAndOpen(new SetShBandsOp(splat, splat.shBandLimit)));
    });

    events.on('graph.addOutputNode', (target?: Splat) => {
        addTarget(target).forEach((splat) => {
            appendAndOpen(new OutputOp(splat, {
                fileType: 'ply',
                filename: `${removeExtension(splat.name ?? 'output')}.ply`,
                maxSHBands: 3,
                selectedOnly: false
            }));
        });
    });

    /**
     * Write an output node's file.
     *
     * The history is wound to the node's position first, because that is what
     * the node means: an output before a delete writes the object with those
     * splats still in it. The cursor goes back where it was afterwards, so
     * exporting is not itself an edit.
     */
    events.function('output.write', async (index: number) => {
        const op = history().ops[index];
        if (!(op instanceof OutputOp)) return;

        const resume = history().cursor;
        await editHistory.goto(index + 1);

        const { fileType, filename, maxSHBands, selectedOnly } = op.settings;
        const splatIdx = (events.invoke('scene.allSplats') as Splat[]).indexOf(op.splat);

        try {
            await events.invoke('scene.write', fileType, {
                filename,
                splatIdx: splatIdx < 0 ? 'all' : splatIdx,
                serializeSettings: { maxSHBands, selected: selectedOnly }
            });
        } finally {
            await editHistory.goto(resume);
        }
    });

    // an empty select node, waiting for a viewport gesture to fill it
    events.on('graph.addSelectNode', (target?: Splat) => {
        addTarget(target).forEach(splat => appendAndOpen(new SelectOp(splat, [])));
    });

    // a colour node with no adjustment yet - the panel writes into it
    events.on('graph.addColourNode', (target?: Splat) => {
        addTarget(target).forEach((splat) => {
            const current = {
                tintClr: splat.tintClr.clone(),
                temperature: splat.temperature,
                saturation: splat.saturation,
                exposure: splat.exposure,
                brightness: splat.brightness,
                blackPoint: splat.blackPoint,
                whitePoint: splat.whitePoint,
                transparency: splat.transparency
            };
            appendAndOpen(new SetSplatColorAdjustmentOp({
                splat,
                oldState: { ...current },
                newState: { ...current }
            }));
        });
    });

    events.on('select.mask', (op: SelectMode, mask: Uint8Array | Uint32Array) => {
        selectedSplats().forEach((splat) => {
            addSelect(splat, op, freeze('mask', mask, splat.splatData.numSplats));
        });
    });

    // a bucket range from the data panel's histogram
    events.on('select.byDataRange', (op: SelectMode, query: RangeQuery) => {
        selectedSplats().forEach(splat => addSelect(splat, op, query));
    });

    // transform maps the unit sphere (diameter 1) to world space
    events.on('select.bySphere', (op: SelectMode, transform: Mat4) => {
        selectedSplats().forEach(splat => addSelect(splat, op, { kind: 'sphere', transform }));
    });

    // transform maps the unit cube (side 1) to world space
    events.on('select.byBox', (op: SelectMode, transform: Mat4) => {
        selectedSplats().forEach(splat => addSelect(splat, op, { kind: 'box', transform }));
    });

    events.function('select.rect', async (op: SelectMode, rect: any) => {
        const mode = events.invoke('camera.mode');

        for (const splat of selectedSplats()) {
            if (mode === 'centers') {
                addSelect(splat, op, {
                    kind: 'rect',
                    rect: { x1: rect.start.x, y1: rect.start.y, x2: rect.end.x, y2: rect.end.y },
                    viewProjection: capturedView()
                });
            } else if (mode === 'rings') {
                scene.camera.pickPrep(splat, op);
                const pick = await scene.camera.pickRect(
                    rect.start.x,
                    rect.start.y,
                    rect.end.x - rect.start.x,
                    rect.end.y - rect.start.y
                );

                const sortedIds = new Uint32Array(new Set(pick)).sort();
                // ring-mode picks come off the gpu picker, which would need a
                // re-render to reproduce, so the hit set is what gets stored
                addSelect(splat, op, freeze('rectangle', sortedIds, splat.splatData.numSplats));
            }
        }
    });

    let maskTexture: Texture = null;

    /**
     * A painted mask.
     *
     * `poly` is the outline where the gesture had one - a lasso or a clicked
     * polygon - and the query keeps it so the selection can be rasterized and
     * run again. A brush stroke or a flood fill has no outline to keep, only
     * pixels, so those resolve once here and freeze.
     */
    events.function('select.byMask', async (op: SelectMode, canvas: HTMLCanvasElement, context: CanvasRenderingContext2D, poly?: { x: number, y: number }[]) => {
        const mode = events.invoke('camera.mode');

        for (const splat of selectedSplats()) {
            if (mode === 'centers') {
                if (poly?.length) {
                    addSelect(splat, op, {
                        kind: 'poly',
                        points: poly.map(p => ({ x: p.x, y: p.y })),
                        width: canvas.width,
                        height: canvas.height,
                        viewProjection: capturedView()
                    });
                    continue;
                }

                // create mask texture
                if (!maskTexture || maskTexture.width !== canvas.width || maskTexture.height !== canvas.height) {
                    if (maskTexture) {
                        maskTexture.destroy();
                    }
                    maskTexture = new Texture(scene.graphicsDevice);
                }
                maskTexture.setSource(canvas);

                // pinned for the queued task: maskTexture is reused across
                // gestures and may be replaced before this runs
                const texture = maskTexture;
                await scene.commandQueue.enqueue(async () => {
                    const data = await scene.dataProcessor.intersect({ mask: texture }, splat);
                    addSelect(splat, op, freeze('paint', data, splat.splatData.numSplats));
                    scene.dataProcessor.releaseMask(data);
                });
            } else if (mode === 'rings') {
                const mask = context.getImageData(0, 0, canvas.width, canvas.height);

                // calculate mask bound so we limit pixel operations
                let mx0 = mask.width - 1;
                let my0 = mask.height - 1;
                let mx1 = 0;
                let my1 = 0;
                for (let y = 0; y < mask.height; ++y) {
                    for (let x = 0; x < mask.width; ++x) {
                        if (mask.data[(y * mask.width + x) * 4 + 3] === 255) {
                            mx0 = Math.min(mx0, x);
                            my0 = Math.min(my0, y);
                            mx1 = Math.max(mx1, x);
                            my1 = Math.max(my1, y);
                        }
                    }
                }

                // Convert mask bounds to normalized coordinates
                const nx0 = mx0 / mask.width;
                const ny0 = my0 / mask.height;
                const nx1 = (mx1 + 1) / mask.width;
                const ny1 = (my1 + 1) / mask.height;
                const nw = nx1 - nx0;
                const nh = ny1 - ny0;

                scene.camera.pickPrep(splat, op);
                const pick = await scene.camera.pickRect(nx0, ny0, nw, nh);

                // Calculate actual pixel dimensions for iteration
                const { width, height } = scene.targetSize;

                // Convert normalized coordinates to render target pixels
                const px = Math.floor(nx0 * width);
                const py = Math.floor(ny0 * height);
                const pw = Math.max(1, Math.ceil((nx0 + nw) * width) - px);
                const ph = Math.max(1, Math.ceil((ny0 + nh) * height) - py);

                const selected = new Set<number>();
                for (let y = 0; y < ph; ++y) {
                    for (let x = 0; x < pw; ++x) {
                        const mx = Math.floor((nx0 + x / width) * mask.width);
                        const my = Math.floor((ny0 + y / height) * mask.height);
                        if (mask.data[(my * mask.width + mx) * 4] === 255) {
                            selected.add(pick[(ph - 1 - y) * pw + x]);
                        }
                    }
                }

                const sortedIds = new Uint32Array(selected).sort();
                addSelect(splat, op, freeze('paint', sortedIds, splat.splatData.numSplats));
            }
        }
    });

    events.function('select.point', async (op: SelectMode, point: { x: number, y: number }) => {
        const { width, height } = scene.targetSize;
        const mode = events.invoke('camera.mode');

        for (const splat of selectedSplats()) {
            if (mode === 'centers') {
                addSelect(splat, op, {
                    kind: 'point',
                    point: { x: point.x, y: point.y },
                    size: events.invoke('camera.splatSize'),
                    viewProjection: capturedView()
                });
            } else if (mode === 'rings') {
                scene.camera.pickPrep(splat, op);

                // Use normalized coordinates with minimal size for single pixel pick
                const pickResult = await scene.camera.pickRect(
                    point.x,
                    point.y,
                    1 / width,
                    1 / height
                );
                addSelect(splat, op, freeze('click', new Uint32Array([pickResult[0]]), splat.splatData.numSplats));
            }
        }
    });

    // Eyedropper selection with SelectOp so undo/redo and selection state updates remain consistent.
    // Threshold acts as a per-channel absolute difference: 0 only matches identical colors while 1 matches everything.
    // TO DO:
    // -  alternative distance metrics such as HSV.
    // -  alternative UI for threshold, two handles for min/max?
    events.function('select.colorMatch', async (op: SelectMode, point: { x: number, y: number }, threshold = 0) => {
        const splats = selectedSplats();
        const targetSize = scene.targetSize;
        if (!splats.length || !targetSize || !point) {
            return;
        }

        const { width, height } = targetSize;
        if (!width || !height) {
            return;
        }

        // Clamp normalized coordinates to valid range
        const nx = Math.max(0, Math.min(1, point.x));
        const ny = Math.max(0, Math.min(1, point.y));
        const colorThreshold = Math.min(1, Math.max(0, Number.isFinite(threshold) ? threshold : 0));

        for (const splat of splats) {
            scene.camera.pickPrep(splat, 'set');
            // Use normalized coordinates with minimal size for single pixel pick
            const pickBuffer = await scene.camera.pickRect(nx, ny, 1 / width, 1 / height);
            const pickId = pickBuffer?.[0];
            if (pickId === undefined || pickId === 0xffffffff) {
                continue;
            }

            const reds = splat.splatData.getProp('f_dc_0') as Float32Array;
            const greens = splat.splatData.getProp('f_dc_1') as Float32Array;
            const blues = splat.splatData.getProp('f_dc_2') as Float32Array;
            // validate pickId and color channels exist
            if (!reds || !greens || !blues || pickId < 0 || pickId >= reds.length) {
                continue;
            }
            // The pick is the only part that needs the camera. Once the
            // reference colour is read the query is pure data, so the threshold
            // stays adjustable long after the click that set it.
            addSelect(splat, op, {
                kind: 'color',
                ref: {
                    r: decodeColorChannel(reds[pickId]),
                    g: decodeColorChannel(greens[pickId]),
                    b: decodeColorChannel(blues[pickId])
                },
                threshold: colorThreshold
            });
        }
    });

    events.on('select.hide', () => {
        selectedSplats().forEach((splat) => {
            events.fire('edit.add', new HideSelectionOp(splat));
        });
    });

    // whether a splat has anything hidden that unhiding would actually reveal.
    // checked before constructing the op rather than by resolving it, so an op
    // that resolves at do() time is not forced to answer early.
    const hasHidden = (splat: Splat) => {
        const state = splat.splatData.getProp('state') as Uint8Array;
        for (let i = 0; i < splat.splatData.numSplats; ++i) {
            if ((state[i] & (State.locked | State.deleted)) === State.locked) return true;
        }
        return false;
    };

    events.on('select.unhide', () => {
        const ops = (scene.getElementsByType(ElementType.splat) as Splat[])
        .filter(hasHidden)
        .map(splat => new UnhideAllOp(splat));

        if (ops.length > 0) {
            events.fire('edit.add', ops.length === 1 ? ops[0] : new MultiOp(ops));
        }
    });

    events.on('select.delete', () => {
        // Don't delete gaussians when a point-placing tool is active (backspace deletes its points instead)
        if (['measure', 'orient'].includes(events.invoke('tool.active'))) {
            return;
        }
        // Don't delete gaussians while a polygon selection is in progress (backspace removes the last point instead)
        if (events.invoke('polygonSelection.removeLastPoint')) {
            return;
        }
        selectedSplats().forEach((splat) => {
            editHistory.add(new DeleteSelectionOp(splat));
        });
    });

    const performSelectionFunc = async (func: 'duplicate' | 'separate') => {
        const splats = selectedSplats();

        const memFs = new MemoryFileSystem();

        await writeSplatFile(splats, {
            maxSHBands: 3,
            selected: true
        }, 'ply', 'output.ply', {}, memFs);

        const data = memFs.results.get('output.ply');

        if (data) {
            const splat = splats[0];

            // wrap PLY in a blob and load it. pass the view rather than the
            // underlying buffer, which is the writer's oversized scratch allocation
            const blob = new Blob([data as BlobPart], { type: 'application/octet-stream' });
            const filename = `${removeExtension(splat.filename)}.ply`;
            const fileSystem = new MappedReadFileSystem();
            fileSystem.addFile(filename, blob);
            const copy = await scene.assetLoader.load(filename, fileSystem);

            if (func === 'separate') {
                editHistory.add(new MultiOp([
                    new DeleteSelectionOp(splat),
                    new AddSplatOp(scene, copy)
                ]));
            } else {
                editHistory.add(new AddSplatOp(scene, copy));
            }
        }
    };

    // duplicate the current selection
    events.on('edit.duplicate', async () => {
        await performSelectionFunc('duplicate');
    });

    events.on('edit.separate', async () => {
        await performSelectionFunc('separate');
    });

    events.on('scene.reset', () => {
        selectedSplats().forEach((splat) => {
            editHistory.add(new ResetOp(splat));
        });
    });

    // camera mode (visual: centers/rings)

    let activeMode = 'centers';

    const setCameraMode = (mode: string) => {
        if (mode !== activeMode) {
            activeMode = mode;
            events.fire('camera.mode', activeMode);
        }
    };

    events.function('camera.mode', () => {
        return activeMode;
    });

    events.on('camera.setMode', (mode: string) => {
        setCameraMode(mode);
    });

    events.on('camera.toggleMode', () => {
        setCameraMode(events.invoke('camera.mode') === 'centers' ? 'rings' : 'centers');
    });

    // camera control mode (orbit/fly)

    let controlMode: 'orbit' | 'fly' = 'orbit';

    const setControlMode = (mode: 'orbit' | 'fly') => {
        if (mode !== controlMode) {
            controlMode = mode;
            scene.camera.controlMode = mode;
            events.fire('camera.controlMode', controlMode);
        }
    };

    events.function('camera.controlMode', () => {
        return controlMode;
    });

    events.on('camera.setControlMode', (mode: 'orbit' | 'fly') => {
        setControlMode(mode);
    });

    events.on('camera.toggleControlMode', () => {
        setControlMode(controlMode === 'orbit' ? 'fly' : 'orbit');
    });

    // camera overlay

    let cameraOverlay = scene.config.camera.overlay;

    const setCameraOverlay = (enabled: boolean) => {
        if (enabled !== cameraOverlay) {
            cameraOverlay = enabled;
            events.fire('camera.overlay', cameraOverlay);
        }
    };

    events.function('camera.overlay', () => {
        return cameraOverlay;
    });

    events.on('camera.setOverlay', (value: boolean) => {
        setCameraOverlay(value);
    });

    events.on('camera.toggleOverlay', () => {
        setCameraOverlay(!events.invoke('camera.overlay'));
    });

    // splat size

    let splatSize = 2;

    const setSplatSize = (value: number) => {
        if (value !== splatSize) {
            splatSize = value;
            events.fire('camera.splatSize', splatSize);
        }
    };

    events.function('camera.splatSize', () => {
        return splatSize;
    });

    events.on('camera.setSplatSize', (value: number) => {
        setSplatSize(value);
    });

    // camera fly speed

    const setFlySpeed = (value: number) => {
        if (value !== scene.camera.flySpeed) {
            scene.camera.flySpeed = value;
            events.fire('camera.flySpeed', value);
        }
    };

    events.function('camera.flySpeed', () => {
        return scene.camera.flySpeed;
    });

    events.on('camera.setFlySpeed', (value: number) => {
        setFlySpeed(value);
    });

    // outline selection

    let outlineSelection = false;

    const setOutlineSelection = (value: boolean) => {
        if (value !== outlineSelection) {
            outlineSelection = value;
            events.fire('view.outlineSelection', outlineSelection);
        }
    };

    events.function('view.outlineSelection', () => {
        return outlineSelection;
    });

    events.on('view.setOutlineSelection', (value: boolean) => {
        setOutlineSelection(value);
    });

    // view spherical harmonic bands

    let viewBands = scene.config.show.shBands;

    const setViewBands = (value: number) => {
        if (value !== viewBands) {
            viewBands = value;
            events.fire('view.bands', viewBands);
        }
    };

    events.function('view.bands', () => {
        return viewBands;
    });

    events.on('view.setBands', (value: number) => {
        setViewBands(value);
    });

    // centers gaussian color toggle
    let centersUseGaussianColor = false;
    events.function('view.centersUseGaussianColor', () => centersUseGaussianColor);
    events.on('view.setCentersUseGaussianColor', (value: boolean) => {
        centersUseGaussianColor = value;
        events.fire('view.centersUseGaussianColor', value);
    });

    events.function('camera.getPose', () => {
        const camera = scene.camera;
        const position = camera.position;
        const focalPoint = camera.focalPoint;
        return {
            position: { x: position.x, y: position.y, z: position.z },
            target: { x: focalPoint.x, y: focalPoint.y, z: focalPoint.z },
            fov: camera.fov
        };
    });

    events.on('camera.setPose', (pose: { position: Vec3, target: Vec3, fov?: number }, speed = 1) => {
        // assign fov before setPose so distance is computed using the new fovFactor
        if (pose.fov !== undefined) {
            // pose-driven fov (timeline playback, fly-to-pose) is not a user
            // preference - suspend capture around the notify and the
            // synchronous ui echo it triggers
            events.fire('preferences.suspend');
            try {
                scene.camera.fov = pose.fov;
                events.fire('camera.fov', pose.fov);
            } finally {
                events.fire('preferences.resume');
            }
        }
        scene.camera.setPose(pose.position, pose.target, speed);
    });

    // hack: fire events to initialize UI
    events.fire('camera.fov', scene.camera.fov);
    events.fire('camera.overlay', cameraOverlay);
    events.fire('view.bands', viewBands);
    events.fire('camera.showInfo', showInfo);

    // doc serialization
    events.function('docSerialize.view', () => {
        const packC = (c: Color) => [c.r, c.g, c.b, c.a];
        return {
            bgColor: packC(events.invoke('bgClr')),
            selectedColor: packC(events.invoke('selectedClr')),
            unselectedColor: packC(events.invoke('unselectedClr')),
            lockedColor: packC(events.invoke('lockedClr')),
            shBands: events.invoke('view.bands'),
            centersSize: events.invoke('camera.splatSize'),
            outlineSelection: events.invoke('view.outlineSelection'),
            showGrid: events.invoke('grid.visible'),
            gridPlane: events.invoke('grid.plane'),
            showBound: events.invoke('camera.bound'),
            showBoundDimensions: events.invoke('camera.boundDimensions'),
            showCameraPoses: events.invoke('camera.showPoses'),
            showCameraInfo: events.invoke('camera.showInfo'),
            flySpeed: events.invoke('camera.flySpeed'),
            fovDolly: events.invoke('camera.fovDolly')
        };
    });

    events.function('docDeserialize.view', (docView: any) => {
        events.fire('setBgClr', new Color(docView.bgColor));
        events.fire('setSelectedClr', new Color(docView.selectedColor));
        events.fire('setUnselectedClr', new Color(docView.unselectedColor));
        events.fire('setLockedClr', new Color(docView.lockedColor));
        events.fire('view.setBands', docView.shBands);
        events.fire('camera.setSplatSize', docView.centersSize);
        events.fire('view.setOutlineSelection', docView.outlineSelection);
        events.fire('grid.setVisible', docView.showGrid);
        events.fire('grid.setPlane', docView.gridPlane ?? 'xz');
        events.fire('camera.setBound', docView.showBound);
        events.fire('camera.setBoundDimensions', docView.showBoundDimensions ?? false);
        events.fire('camera.setShowPoses', docView.showCameraPoses ?? false);
        events.fire('camera.setShowInfo', docView.showCameraInfo ?? false);
        events.fire('camera.setFlySpeed', docView.flySpeed);
        events.fire('camera.setFovDolly', docView.fovDolly ?? false);
    });
};

export { registerEditorEvents };
