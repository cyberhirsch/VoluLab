import { MemoryFileSystem } from '@playcanvas/splat-transform';
import { Color, Mat4, path, Quat, Texture, Vec3, Vec4 } from 'playcanvas';

import { registerCameraEffects } from './camera-effects';
import { CameraAnimTrack } from './camera-poses';
import { registerCameraViewEvents } from './camera-view';
import { EditHistory } from './edit-history';
import { EditOp, SelectMesh, SelectAllOp, SelectNoneOp, SelectInvertOp, SelectOp, SelectMode, HideSelectionOp, UnhideAllOp, DeleteSelectionOp, CameraOp, CleanupOp, CropOp, DatasetOp, DecimateOp, OutputOp, ResetOp, MultiOp, AddSplatOp, AddVoxelsOp, MergeOp, VoxeliseOp, TrainOp, TrainSettings, ScopedColorOp, SetLocalFrameOp, SetShBandsOp, SetSplatColorAdjustmentOp, defaultCameraSettings, LightOp, LightKind, defaultLightSettings, RelightOp, PrimitiveOp } from './edit-ops';
import { Element, ElementType } from './element';
import { Events } from './events';
import { IndexRanges } from './index-ranges';
import type { GridPlane } from './infinite-grid';
import { MappedReadFileSystem } from './io';
import { registerLightViewEvents } from './light-view';
import { registerPrimitiveViewEvents } from './primitive-view';
import { defaultRelightSettings, normalizeRelightSettings, RelightSettings, registerRelighting } from './relight/relighter';
import { emittersFromSelection, splatWithSelection } from './relight/volume-light';
import { Scene } from './scene';
import { SceneCamera } from './scene-camera';
import { SceneLight } from './scene-light';
import { PrimitiveKind, ScenePrimitive } from './scene-primitive';
import { RangeQuery, SelectQuery, ShapeQuery } from './select-query';
import { Splat } from './splat';
import { writeSplatFile } from './splat-serialize';
import { State } from './splat-state';
import { registerTraining } from './training/train-run';
import { VoxelGrid, Voxels, voxelise } from './voxels';

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
            numSplats,
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

    /**
     * A colour node.
     *
     * With a selection it is scoped to those gaussians and stacks on whatever
     * an earlier colour node put there; with nothing selected it grades the
     * object, which is the older behaviour and still the right one for "make
     * this whole thing warmer".
     */
    events.on('graph.addColourNode', (target?: Splat) => {
        addTarget(target).forEach((splat) => {
            if (splat.numSelected > 0) {
                appendAndOpen(new ScopedColorOp(splat, {
                    tintClr: splat.tintClr.clone(),
                    temperature: 0,
                    saturation: 1,
                    exposure: 0,
                    brightness: 0,
                    blackPoint: 0,
                    whitePoint: 1,
                    transparency: 1
                }));
                return;
            }

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

    /**
     * A primitive as a select node's mesh input.
     *
     * The node selects with a copy of the shape taken when the primitive
     * settles (see SelectMesh), so it is the copy that is replaced here, and
     * the node replayed with it: wired, cut, a new mode, or the primitive
     * settling somewhere new.
     */
    const shapeOf = (primitive: ScenePrimitive): ShapeQuery | null => {
        return primitive.scene ? { kind: primitive.kind, transform: primitive.transform() } : null;
    };

    const sameShape = (a: ShapeQuery | null, b: ShapeQuery | null) => {
        if (!a || !b) return a === b;
        return a.kind === b.kind && a.transform.equals(b.transform);
    };

    const setMesh = (op: SelectOp, mesh: SelectMesh | null) => {
        const index = history().ops.indexOf(op);
        if (index < 0) return;
        events.invoke('edit.refresh', index, () => {
            op.mesh = mesh;
        });
    };

    events.on('select.meshMode', (op: SelectOp, mode: SelectMode) => {
        if (op?.mesh && op.mesh.mode !== mode) setMesh(op, { ...op.mesh, mode });
    });

    /**
     * Whenever history settles, each applied select node whose primitive is
     * no longer where its copy says is replayed with a new copy - one replay
     * from the earliest of them, however many there are. The check runs in
     * the command queue, behind whatever is in flight, so it sees the scene
     * at rest; and not while a primitive is being dragged or typed into,
     * which settles with an edit of its own.
     */
    let shapeCheck = false;
    const checkShapes = () => {
        if (shapeCheck) return;
        shapeCheck = true;
        events.invoke('queue', () => {
            shapeCheck = false;
            const primitives = events.invoke('primitive.list') as ScenePrimitive[];
            if (primitives.some(p => p.live)) return;

            const { ops, cursor } = history();
            const stale: { op: SelectOp, used: ShapeQuery | null }[] = [];
            let first = -1;
            for (let i = 0; i < cursor; ++i) {
                const op = ops[i];
                if (op.bypassed || !(op instanceof SelectOp) || !op.mesh) continue;
                const used = shapeOf(op.mesh.source);
                if (!sameShape(used, op.mesh.used)) {
                    stale.push({ op, used });
                    if (first < 0) first = i;
                }
            }
            // queued behind this task, not awaited: waiting on it from here
            // would wait on itself
            if (stale.length) {
                events.invoke('edit.refresh', first, () => {
                    stale.forEach(({ op, used }) => {
                        if (op.mesh) op.mesh.used = used;
                    });
                });
            }
        });
    };
    events.on('edit.changed', checkShapes);
    events.on('primitive.changed', checkShapes);

    /**
     * From the sphere and box tools: their primitive into the select node
     * being worked on, combined by mode. With no node being worked on - or
     * one that takes another shape in, which this one would push out - a new
     * node is made with just this input.
     */
    events.on('select.byPrimitive', (mode: SelectMode, primitive: ScenePrimitive) => {
        selectedSplats().forEach((splat) => {
            const target = nodeToEdit(splat, op => op instanceof SelectOp);
            const existing = target !== null ? history().ops[target] as SelectOp : null;
            if (existing && (!existing.mesh || existing.mesh.source === primitive)) {
                setMesh(existing, { source: primitive, mode, used: shapeOf(primitive) });
                return;
            }
            const op = new SelectOp(splat, []);
            op.mesh = { source: primitive, mode, used: shapeOf(primitive) };
            appendAndOpen(op);
        });
    });

    /** The primitive the select node being worked on takes in, if it is of this kind. */
    events.function('select.editingMesh', (kind: PrimitiveKind) => {
        const splat = selectedSplats()[0];
        const target = splat ? nodeToEdit(splat, op => op instanceof SelectOp) : null;
        const source = target !== null ? (history().ops[target] as SelectOp).mesh?.source : null;
        return source?.kind === kind ? source : null;
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

    /**
     * Merge two objects into one.
     *
     * The merged data is produced the way duplicate produces its copy - write
     * both out and read the result back - and only then does the op exist, so
     * applying it is just adding an object that is already built.
     */
    events.function('graph.merge', async (a: Splat, b: Splat) => {
        if (!a || !b || a === b) return;

        const memFs = new MemoryFileSystem();
        await writeSplatFile([a, b], { maxSHBands: 3 }, 'ply', 'output.ply', {}, memFs);
        const data = memFs.results.get('output.ply');
        if (!data) return;

        const blob = new Blob([data as BlobPart], { type: 'application/octet-stream' });
        const filename = `${removeExtension(a.filename)}-merged.ply`;
        const fileSystem = new MappedReadFileSystem();
        fileSystem.addFile(filename, blob);
        const merged = await scene.assetLoader.load(filename, fileSystem);
        if (!merged) return;

        const index = history().cursor;
        events.fire('edit.add', new MergeOp(scene, [a, b], merged));
        openInGraph(index);
    });

    /**
     * Import a parsed voxel model. Unlike splats, whose import nodes the
     * graph synthesises from the scene, voxels enter the graph through
     * history - so the import is an op like any other producer.
     */
    events.function('vox.import', (grid: VoxelGrid, name: string) => {
        const voxels = new Voxels(grid, removeExtension(name));
        const index = history().cursor;
        events.fire('edit.add', new AddVoxelsOp(scene, voxels, name));
        openInGraph(index);
        return voxels;
    });

    /**
     * Add a pending train node: the node exists before any gaussians do.
     * It arrives unwired - the dataset comes from an import node the user
     * connects by hand. The run controller (train-run.ts) fills in the
     * output when a run produces one; here is only the record entering
     * history.
     */
    events.function('training.addNode', (config: Record<string, unknown> = {}) => {
        const settings: TrainSettings = { datasetName: 'no dataset', config, iterations: 0, finalSplats: 0 };
        const op = new TrainOp(scene, null, settings);
        const index = history().cursor;
        events.fire('edit.add', op);
        openInGraph(index);
        events.fire('workspace.reveal', 'node');
        return op;
    });

    /**
     * A camera node: exposure, depth of field and the lens. It owns no
     * object, so it stands on its own in the graph, and the last applied
     * one is the one the renderer obeys.
     */
    events.function('camera.addNode', () => {
        const settings = defaultCameraSettings();

        // a new camera starts where you are looking, which is nearly always
        // the shot you were about to frame
        const pose = events.invoke('camera.getPose');
        const cameras = (events.invoke('camera.list') as unknown[]).length;
        const camera = new SceneCamera(`camera ${cameras + 1}`, settings);
        if (pose) {
            camera.position.set(pose.position.x, pose.position.y, pose.position.z);
            camera.target.set(pose.target.x, pose.target.y, pose.target.z);
            camera.fov = pose.fov;
        }

        // focus distance defaults to what the camera is actually looking at
        settings.focusDistance = Math.max(0.01, camera.position.distance(camera.target));

        // its own animation track, which speaks only while the viewport is
        // actually looking through this camera
        camera.track = new CameraAnimTrack(
            events,
            () => events.invoke('camera.viewMode') === 'camera' && events.invoke('camera.active') === camera
        );

        const op = new CameraOp(scene, camera, settings);
        const index = history().cursor;
        events.fire('edit.add', op);
        openInGraph(index);
        events.fire('workspace.reveal', 'node');
        return op;
    });

    /**
     * Relight nodes: one per object, on the object's own lane. The index of
     * an object's node, applied or bypassed, or -1 - an undone one ahead of
     * the cursor is on its way out and does not count.
     */
    const relightIndex = (splat: Splat) => {
        const { ops, cursor } = history();
        for (let i = 0; i < cursor; ++i) {
            const op = ops[i];
            if (op instanceof RelightOp && op.splat === splat) return i;
        }
        return -1;
    };

    events.function('relight.nodeIndex', (splat: Splat) => relightIndex(splat));

    // Adds are queued, so a relight node just added is not in the history
    // yet; lights added one after another would each find none and add
    // their own. These are the objects with one on its way in.
    const incoming = new WeakSet<Splat>();
    events.on('edit.apply', (op: EditOp) => {
        if (op instanceof RelightOp) incoming.delete(op.splat);
    });
    const hasRelight = (splat: Splat) => relightIndex(splat) >= 0 || !!splat.relight || incoming.has(splat);
    const addRelight = (op: RelightOp) => {
        incoming.add(op.splat);
        events.fire('edit.add', op);
    };

    // a relight node for an object, with these settings; null when the object
    // has one already
    events.function('relight.addNode', (splat: Splat, settings?: Partial<RelightSettings>) => {
        if (!splat || hasRelight(splat)) return null;
        const op = new RelightOp(splat, normalizeRelightSettings(settings ?? {}));
        addRelight(op);
        return op;
    });

    // from the graph: add one, or open the one the object has
    events.on('graph.addRelightNode', (target?: Splat) => {
        addTarget(target).forEach((splat) => {
            const index = relightIndex(splat);
            if (index >= 0) {
                openInGraph(index);
            } else if (!hasRelight(splat)) {
                incoming.add(splat);
                appendAndOpen(new RelightOp(splat, defaultRelightSettings()));
            }
        });
    });

    /**
     * Adding a light relights what it lights: every object without a relight
     * node gets one, with the defaults. Without the node an object is still
     * lit, but the light only adds to its captured light, unshadowed. How
     * many nodes were added, since each moves the new light's index on.
     */
    const relightAll = () => {
        let added = 0;
        for (const splat of scene.getElementsByType(ElementType.splat) as Splat[]) {
            if (!hasRelight(splat)) {
                addRelight(new RelightOp(splat, defaultRelightSettings()));
                added++;
            }
        }
        return added;
    };

    /**
     * A light node: one light, aimed at what you are looking at. It starts
     * above and to one side of the view rather than at the eye, so the first
     * thing it shows is a shadow, not a headlamp's flat light.
     */
    // relight: false when a project being opened brings its own relight nodes
    events.function('light.addNode', (kind: LightKind = 'point', relight = true) => {
        const settings = defaultLightSettings();
        settings.kind = kind;
        // light from everywhere adds up fast; start it gentler than a lamp
        if (kind === 'ambient') settings.intensity = 0.5;

        const count = (events.invoke('light.list') as unknown[]).length;
        const light = new SceneLight(`light ${count + 1}`, settings);

        // the pose arrives as plain numbers, not vectors
        const pose = events.invoke('camera.getPose');
        const target = pose ? new Vec3(pose.target.x, pose.target.y, pose.target.z) : scene.bound.center.clone();
        const eye = pose ? new Vec3(pose.position.x, pose.position.y, pose.position.z) : target.clone().add(new Vec3(0, 0, 1));
        const distance = Math.max(1e-3, eye.distance(target));

        // from the view: right, up, and a little back toward the camera
        const forward = new Vec3().sub2(target, eye).normalize();
        const right = new Vec3().cross(forward, Vec3.UP);
        if (right.length() < 1e-6) right.set(1, 0, 0);
        right.normalize();
        const offset = new Vec3()
        .addScaled(right, 0.6)
        .addScaled(Vec3.UP, 1.0)
        .addScaled(forward, -0.4)
        .normalize()
        .mulScalar(distance);

        light.position.copy(target).add(offset);
        light.target.copy(target);

        // the adds are queued, so the light's index counts the relight nodes
        // that go in ahead of it
        const added = relight ? relightAll() : 0;
        const op = new LightOp(scene, light, settings);
        const index = history().cursor + added;
        events.fire('edit.add', op);
        // the thing you are about to aim, once it is in - and only now, not
        // whenever a replay puts it back
        events.invoke('queue', () => events.fire('light.select', light));
        openInGraph(index);
        events.fire('workspace.reveal', 'node');
        return op;
    });

    /**
     * A primitive node: a box, sphere or cylinder where you are looking,
     * a quarter as big as the view is deep or half as big as the scene,
     * whichever is bigger, so it lands on what you were looking at and at
     * a size you can see.
     */
    // quiet: made for a tool, which keeps the object selected and the node
    // it is working on open
    events.function('primitive.addNode', (kind: PrimitiveKind = 'box', quiet = false) => {
        // named by kind, with the first number no other primitive has
        const names = new Set((events.invoke('primitive.list') as ScenePrimitive[]).map(p => p.name));
        let n = 1;
        while (names.has(`${kind} ${n}`)) n++;
        const primitive = new ScenePrimitive(`${kind} ${n}`, kind);

        // the pose arrives as plain numbers, not vectors
        const pose = events.invoke('camera.getPose');
        const target = pose ? new Vec3(pose.target.x, pose.target.y, pose.target.z) : scene.bound.center.clone();
        const eye = pose ? new Vec3(pose.position.x, pose.position.y, pose.position.z) : target.clone().add(new Vec3(0, 0, 1));
        const size = Math.max(1e-2, eye.distance(target) * 0.25, scene.bound.halfExtents.length() * 0.5);

        primitive.position.copy(target);
        primitive.size.set(size, size, size);
        primitive.madeSize.copy(primitive.size);

        const op = new PrimitiveOp(scene, primitive);
        const index = history().cursor;
        events.fire('edit.add', op);
        if (!quiet) {
            // selected once it is in, like a new import - and only now, not
            // whenever a replay puts it back, which would take the selection
            // from the object being worked on
            events.invoke('queue', () => events.fire('primitive.select', primitive));
            openInGraph(index);
            events.fire('workspace.reveal', 'node');
        }
        return op;
    });

    // the object whose selected gaussians a volume light would come from
    const selectionSource = () => splatWithSelection(
        events.invoke('selection') as Splat,
        scene.getElementsByType(ElementType.splat) as Splat[]
    );

    events.function('light.selectionSource', () => selectionSource());

    /**
     * A volume light from the selected gaussians: whatever glows in the
     * capture - a lamp, a window - made into the light it gives, at the
     * middle of what glows. Its aim point, where its intensity is measured,
     * starts below it, a quarter of the scene away. Null when nothing is
     * selected.
     */
    events.function('light.addFromSelection', () => {
        const splat = selectionSource();
        const source = splat ? emittersFromSelection(splat) : null;
        if (!source) return null;

        const settings = defaultLightSettings();
        settings.kind = 'volume';
        settings.emitters = source.emitters;
        settings.emitterSource = splat.name;

        const count = (events.invoke('light.list') as unknown[]).length;
        const light = new SceneLight(`light ${count + 1}`, settings);
        const extent = scene.bound.halfExtents;
        const drop = Math.max(4 * source.spread, 0.5 * Math.max(extent.x, extent.y, extent.z), 1e-3);
        light.position.copy(source.centre);
        light.target.copy(source.centre).add(new Vec3(0, -drop, 0));

        const added = relightAll();
        const op = new LightOp(scene, light, settings);
        const index = history().cursor + added;
        events.fire('edit.add', op);
        openInGraph(index);
        events.fire('workspace.reveal', 'node');
        return op;
    });

    /**
     * A volume light made over from whatever is selected now. The light moves
     * to the new emitters' middle and its aim point comes with it. False when
     * nothing is selected.
     */
    events.function('light.useSelection', (light: SceneLight) => {
        const splat = selectionSource();
        const source = splat ? emittersFromSelection(splat) : null;
        if (!source || !light) return false;
        light.settings.emitters = source.emitters;
        light.settings.emitterSource = splat.name;
        const shift = new Vec3().sub2(source.centre, light.position);
        light.setPose({ position: source.centre, target: light.target.clone().add(shift) });
        light.changed();
        return true;
    });

    /**
     * A dataset entering the graph as an import node of its own. Nothing
     * is wired automatically - the user drags its output into a train
     * node's input.
     */
    events.function('dataset.addNode', (source: unknown = null, sourceName = 'dataset') => {
        const op = new DatasetOp(source, sourceName);
        const index = history().cursor;
        events.fire('edit.add', op);
        openInGraph(index);
        events.fire('workspace.reveal', 'node');
        return op;
    });

    /**
     * A hand-drawn wire into one of a node's named inputs, and one taken
     * out again. What a wire means is the node's own business, so each kind
     * of node is routed to what its input takes: a train node's dataset.
     */
    events.on('graph.connect', (op: EditOp, port: string, source: object) => {
        if (op instanceof TrainOp && port === 'dataset' && source instanceof DatasetOp) {
            op.datasetOp = source;
            op.inputs = [source.output];
            op.settings.datasetName = source.sourceName;
            events.fire('edit.changed');
        }
        // a select node's mesh: what is inside the primitive, set by default
        if (op instanceof SelectOp && port === 'mesh' && source instanceof ScenePrimitive) {
            setMesh(op, { source, mode: op.mesh?.mode ?? 'set', used: shapeOf(source) });
        }
    });

    events.on('graph.disconnect', (op: EditOp, port: string) => {
        if (op instanceof TrainOp && port === 'dataset' && op.datasetOp) {
            op.datasetOp = undefined;
            op.inputs = [];
            events.fire('edit.changed');
        }
        if (op instanceof SelectOp && port === 'mesh' && op.mesh) {
            setMesh(op, null);
        }
    });

    registerTraining(events, scene);
    registerCameraEffects(events, scene);
    registerCameraViewEvents(events, scene);
    registerLightViewEvents(events, scene);
    registerPrimitiveViewEvents(events, scene);
    registerRelighting(events, scene);

    /**
     * Resample an object onto a grid.
     *
     * Scoped to the selection when there is one, so a voxel node can take a
     * region rather than the whole object - the same rule colour follows.
     */
    const decodedColors = (data: any) => {
        const n = data.numSplats;
        const src = ['f_dc_0', 'f_dc_1', 'f_dc_2'].map(k => data.getProp(k) as Float32Array);
        const opacity = data.getProp('opacity') as Float32Array;
        const out = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
        const alpha = new Float32Array(n);
        for (let i = 0; i < n; ++i) {
            for (let c = 0; c < 3; ++c) out[c][i] = decodeColorChannel(src[c]?.[i] ?? 0);
            alpha[i] = opacity ? 1 / (1 + Math.exp(-opacity[i])) : 1;
        }
        return { r: out[0], g: out[1], b: out[2], a: alpha };
    };

    events.function('graph.voxelise', (target?: Splat, resolution = 32) => {
        const splats = target ? [target] : selectedSplats();
        splats.forEach((splat) => {
            const data = splat.splatData;
            const state = data.getProp('state') as Uint8Array;
            const anySelected = splat.numSelected > 0;

            const grid = voxelise(
                {
                    x: data.getProp('x') as Float32Array,
                    y: data.getProp('y') as Float32Array,
                    z: data.getProp('z') as Float32Array
                },
                // a voxel holds a colour, not the coefficients a gaussian
                // stores it as, so the conversion happens here rather than
                // being carried into the grid and undone at export
                decodedColors(data),
                (i) => {
                    if ((state[i] & State.deleted) !== 0) return false;
                    return !anySelected || (state[i] & State.selected) !== 0;
                },
                data.numSplats,
                resolution
            );

            const voxels = new Voxels(grid, `${removeExtension(splat.name ?? 'object')}-voxels`);
            const index = history().cursor;
            events.fire('edit.add', new VoxeliseOp(scene, splat, voxels));
            openInGraph(index);
        });
    });

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

    // P and C are the two views, not a toggle: pressing the key for the
    // view you are already in should keep you there rather than flip you
    // out of it
    events.on('camera.viewPerspective', () => {
        events.fire('camera.setViewMode', 'perspective');
    });

    events.on('camera.viewCamera', () => {
        events.fire('camera.setViewMode', 'camera');
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
