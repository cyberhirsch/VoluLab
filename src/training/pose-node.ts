import {
    PRIMITIVE_LINES,
    Entity,
    Mesh,
    MeshInstance,
    ShaderMaterial
} from 'playcanvas';

import { BridgeImage } from './bridge-client';
import { bridgePoseIntoOp, cancelPoseJob } from './bridge-ingest';
import { isRawCapture, isTrainable, openDataset } from './dataset-source';
import { readDatasetPoses } from './pose-read';
import { extractVideoFrames } from './video-ingest';
import { DatasetOp, EditOp, PoseCamera, PoseOp } from '../edit-ops';
import { Element, ElementType } from '../element';
import { Events } from '../events';
import { Scene } from '../scene';
import { vertexShader, fragmentShader } from '../shaders/debug-shader';
import { i18n } from '../ui/localization';

/**
 * The pose nodes' work: posing what an import node holds, or reading the
 * poses it already has, and drawing the cameras found.
 */

// 4 edges to the image plane, its 4 sides, and a tick on its top edge
const LINES_PER_CAMERA = 10;

/**
 * Every applied pose node's cameras, as line frustums in the viewport.
 * Sized from how far apart the cameras stand, so a room-sized capture and
 * a turntable both read; drawn only while overlays are.
 */
class PoseFrustums extends Element {
    private events: Events;
    private entity: Entity;
    private mesh: Mesh;
    private dirty = true;
    private count = 0;

    constructor(events: Events) {
        super(ElementType.debug);
        this.events = events;
    }

    add() {
        const { scene } = this;
        const material = new ShaderMaterial({
            uniqueName: 'poseFrustumMaterial',
            vertexGLSL: vertexShader,
            fragmentGLSL: fragmentShader
        });
        material.depthWrite = true;
        material.depthTest = true;
        material.update();

        this.mesh = new Mesh(scene.graphicsDevice);
        this.mesh.primitive[0] = { baseVertex: 0, type: PRIMITIVE_LINES, base: 0, count: 0 };
        const instance = new MeshInstance(this.mesh, material, null);
        instance.cull = false;

        this.entity = new Entity('poseFrustums');
        this.entity.addComponent('render', {
            meshInstances: [instance],
            layers: [scene.worldLayer.id]
        });
        scene.app.root.addChild(this.entity);

        const markDirty = () => {
            this.dirty = true;
            scene.forceRender = true;
        };
        this.events.on('pose.changed', markDirty);
        this.events.on('edit.changed', markDirty);
    }

    destroy() {
        this.entity?.destroy();
    }

    onPreRender() {
        if (this.dirty) {
            this.dirty = false;
            this.rebuild();
        }
        this.entity.enabled = this.count > 0 && this.scene.camera.renderOverlays;
    }

    /** the cameras of the pose nodes that are applied and shown */
    private shown(): PoseCamera[] {
        const { ops, cursor } = (this.events.invoke('edit.history') ?? { ops: [], cursor: 0 }) as { ops: EditOp[], cursor: number };
        return ops.slice(0, cursor)
        .filter(op => op instanceof PoseOp && op.showCameras && !op.bypassed)
        .flatMap(op => (op as PoseOp).cameras);
    }

    private rebuild() {
        const cameras = this.shown();
        this.count = cameras.length;
        if (!cameras.length) {
            this.mesh.primitive[0].count = 0;
            return;
        }

        // a frustum a twentieth of the spread of the cameras deep
        const lo = [Infinity, Infinity, Infinity];
        const hi = [-Infinity, -Infinity, -Infinity];
        cameras.forEach(c => c.center.forEach((v, k) => {
            lo[k] = Math.min(lo[k], v);
            hi[k] = Math.max(hi[k], v);
        }));
        const spread = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
        const depth = spread > 0 ? spread / 20 : 0.1;

        const positions: number[] = [];
        const at = (c: PoseCamera, x: number, y: number) => [0, 1, 2].map(k => c.center[k] + depth * (c.forward[k] + x * c.right[k] + y * c.down[k]));
        const line = (a: number[], b: number[]) => positions.push(a[0], a[1], a[2], b[0], b[1], b[2]);
        for (const c of cameras) {
            const hx = c.width / 2 / (c.fx || c.width);
            const hy = c.height / 2 / (c.fy || c.fx || c.width);
            const tl = at(c, -hx, -hy);
            const tr = at(c, hx, -hy);
            const bl = at(c, -hx, hy);
            const br = at(c, hx, hy);
            line(c.center, tl);
            line(c.center, tr);
            line(c.center, bl);
            line(c.center, br);
            line(tl, tr);
            line(tr, br);
            line(br, bl);
            line(bl, tl);
            // a tick above the top edge says which way is up in the photo
            const tip = at(c, 0, -hy * 1.4);
            line(tl, tip);
            line(tr, tip);
        }

        const verts = cameras.length * LINES_PER_CAMERA * 2;
        const colors = new Uint8Array(verts * 4);
        for (let i = 0; i < verts; i++) {
            colors.set([255, 170, 40, 255], i * 4);
        }
        this.mesh.setPositions(positions);
        this.mesh.setColors32(colors);
        this.mesh.update(PRIMITIVE_LINES);
    }
}

const registerPoseNodes = (events: Events, scene: Scene) => {
    scene.add(new PoseFrustums(events));

    const history = () => (events.invoke('edit.history') ?? { ops: [] }) as { ops: EditOp[] };

    const changed = (op: PoseOp) => {
        events.fire('pose.changed', op);
        events.fire('dataset.statusChanged', op);
        events.fire('edit.changed');
    };

    /**
     * Pose what the wired import node holds, or read the poses it has.
     * Starting again drops what the node had: a newer dataset or matcher
     * makes the old cameras wrong.
     */
    const run = async (op: PoseOp) => {
        cancelPoseJob(op);
        op.clear();
        op.status = undefined;
        op.awaitingPoses = false;
        const input = op.datasetOp;
        const source = input?.source;

        if (!input || !source) {
            // the COLMAP kit route: the import node waits for the posed folder
            op.awaitingPoses = !!input?.awaitingPoses;
            changed(op);
            return;
        }

        if (isRawCapture(source)) {
            changed(op);
            if (source.kind === 'images') {
                // named by path: same-named photos in subfolders stay apart
                bridgePoseIntoOp(op, source.images, op.matcher, events).catch(() => {});
            } else {
                // frames are extracted when the job gets its turn, so several
                // videos do not sit in memory at once
                const file = source.file;
                bridgePoseIntoOp(op, async () => {
                    const frames: BridgeImage[] = [];
                    await extractVideoFrames(file, (frameName, blob) => {
                        frames.push({ name: frameName, data: blob });
                        return Promise.resolve();
                    });
                    return frames;
                }, op.matcher, events).catch(() => {});
            }
            return;
        }

        if (!isTrainable(source)) {
            changed(op);
            return;
        }

        // a dataset that has poses: read them, and hand it on as it is
        op.status = i18n.t('pose.reading');
        changed(op);
        try {
            const reader = await openDataset(source);
            const read = reader ? await readDatasetPoses(reader) : { cameras: [] as PoseCamera[], total: 0, found: false };
            reader?.close();
            if (op.datasetOp?.source !== source) return;
            // a camera can be in the model with its image left out of the dataset
            op.setPosed(source, read.cameras, Math.max(read.total, read.cameras.length));
            op.status = read.found ? undefined : i18n.t('pose.none-found');
        } catch (error) {
            if (op.datasetOp?.source !== source) return;
            // the trainer may still read it; the node just cannot draw it
            op.setPosed(source, [], 0);
            op.status = `${i18n.t('pose.read-failed')} — ${String((error as any)?.message ?? error).slice(0, 120)}`;
        }
        changed(op);
    };

    events.on('pose.run', (op: PoseOp) => {
        if (op instanceof PoseOp) run(op).catch(() => {});
    });

    events.on('pose.cancel', (op: PoseOp) => {
        if (!(op instanceof PoseOp)) return;
        cancelPoseJob(op);
        op.status = i18n.t('pose.cancelled');
        changed(op);
    });

    events.on('pose.setShown', (op: PoseOp, shown: boolean) => {
        if (!(op instanceof PoseOp)) return;
        op.showCameras = shown;
        changed(op);
    });

    // an import node taking a new source: the pose nodes it feeds start again
    events.on('dataset.sourceChanged', (dataset: DatasetOp) => {
        history().ops.forEach((op) => {
            if (op instanceof PoseOp && op.datasetOp === dataset) run(op).catch(() => {});
        });
    });
};

export { registerPoseNodes };
