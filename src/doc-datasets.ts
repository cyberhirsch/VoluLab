import type { ZipReadFileSystem } from '@playcanvas/splat-transform';

import { DatasetOp, EditOp, PoseOp, TrainOp, type PoseCamera } from './edit-ops';
import type { Events } from './events';
import type { Scene } from './scene';
import type { Splat } from './splat';
import { flattenNames } from './training/bridge-ingest';
import { packDataset } from './training/dataset';
import { i18n } from './ui/localization';

/**
 * How a project keeps the capture side of the graph: import nodes, pose
 * nodes and train nodes, with the wires between them.
 *
 * An import node's files go into the project as they are - a zip, the
 * photos, a video - so a reopened project can pose and train again. A
 * picked folder cannot be stored (the browser hands out a handle, not the
 * files): its node comes back empty, to be pointed at the folder again.
 *
 * A pose node keeps what it estimated (the COLMAP model, a few hundred
 * kilobytes) and the cameras it found, not the posed dataset: that is
 * the import node's photos plus the model, packed again on load without
 * posing again. The frames of a video are not the import node's files, so
 * those are stored with the pose node.
 *
 * A train node keeps its settings and which object it trained, which is
 * stored with the other objects.
 */

type Place = (op: EditOp | undefined) => { at?: number, pos?: number[] };
type Later = (stored: any, add: () => EditOp | null) => void;
type ProjectFile = { name: string, data: Blob | Uint8Array };

const storeDatasets = (ops: EditOp[], cursor: number, splats: Splat[], placeOf: Place) => {
    const applied = ops.slice(0, cursor);
    const datasets = applied.filter(o => o instanceof DatasetOp) as DatasetOp[];
    const poses = applied.filter(o => o instanceof PoseOp) as PoseOp[];
    const trains = applied.filter(o => o instanceof TrainOp) as TrainOp[];
    const files: ProjectFile[] = [];
    const flags = (op: EditOp) => (op.bypassed ? { bypassed: true } : {});

    const storedDatasets = datasets.map((op, i) => {
        const source = op.source as any;
        let stored: object | null = null;
        if (source?.kind === 'bytes') {
            const file = `dataset_${i}.bin`;
            files.push({ name: file, data: source.bytes });
            stored = { kind: 'bytes', name: source.name, file };
        } else if (source?.kind === 'images') {
            stored = {
                kind: 'images',
                names: source.images.map((image: { name: string, data: Blob }, k: number) => {
                    files.push({ name: `dataset_${i}/${k}`, data: image.data });
                    return image.name;
                })
            };
        } else if (source?.kind === 'video') {
            const file = `dataset_${i}.video`;
            files.push({ name: file, data: source.file });
            stored = { kind: 'video', name: source.file.name, type: source.file.type, file };
        } else if (source?.kind === 'url') {
            stored = { kind: 'url', url: source.url };
        } else if (source?.kind === 'directory') {
            stored = { kind: 'directory', name: source.handle?.name };
        }
        return {
            name: op.sourceName,
            ...(op.counts ? { counts: op.counts } : {}),
            ...(op.awaitingPoses ? { awaitingPoses: true } : {}),
            ...(stored ? { source: stored } : {}),
            ...flags(op),
            ...placeOf(op)
        };
    });

    const storedPoses = poses.map((op, j) => {
        const input = op.datasetOp ? datasets.indexOf(op.datasetOp) : -1;
        const inputKind = (op.datasetOp?.source as any)?.kind;
        const sparse = op.sparse?.map((f, k) => {
            const file = `pose_${j}_${k}.bin`;
            files.push({ name: file, data: f.data });
            return { path: f.path, file };
        });
        // the frames of a video are only here; photos are the import node's
        const frames = op.sparse && op.images && inputKind !== 'images' ? op.images.map((image, k) => {
            files.push({ name: `pose_${j}/${k}`, data: image.data });
            return image.name;
        }) : undefined;
        return {
            dataset: input,
            matcher: op.matcher,
            showCameras: op.showCameras,
            total: op.total,
            cameras: op.cameras,
            ...(sparse ? { sparse } : {}),
            ...(frames ? { frames } : {}),
            // poses read from a posed dataset, handed on as it is
            ...(op.source && !op.sparse ? { read: true } : {}),
            ...(op.awaitingPoses ? { awaitingPoses: true } : {}),
            ...flags(op),
            ...placeOf(op)
        };
    });

    const storedTrains = trains.map((op) => {
        const input = op.datasetOp instanceof PoseOp ? { pose: poses.indexOf(op.datasetOp) } :
            (op.datasetOp instanceof DatasetOp ? { dataset: datasets.indexOf(op.datasetOp) } : {});
        const splat = op.output ? splats.indexOf(op.output) : -1;
        const seed = op.seed ? splats.indexOf(op.seed) : -1;
        return {
            ...input,
            settings: { ...op.settings, config: { ...op.settings.config } },
            ...(splat >= 0 ? { splat } : {}),
            ...(seed >= 0 ? { seed } : {}),
            ...flags(op),
            ...placeOf(op)
        };
    });

    return {
        document: storedDatasets.length || storedPoses.length || storedTrains.length ?
            { datasets: storedDatasets, poses: storedPoses, trains: storedTrains } : {},
        files
    };
};

/**
 * A stored entry as a Blob. Stored (uncompressed) entries are sliced out
 * of the project file itself, so a few hundred megabytes of photos are
 * not copied into memory on load; anything else is read.
 */
const entryBlob = async (file: Blob, zipFs: ZipReadFileSystem, name: string, type = ''): Promise<Blob> => {
    const entry = await zipFs.getEntry(name);
    if (!entry) throw new Error(`${name} is missing from the project`);
    if (entry.method === 0) {
        const header = new DataView(await file.slice(entry.offset, entry.offset + 30).arrayBuffer());
        if (header.getUint32(0, true) === 0x04034b50) {
            const start = entry.offset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
            return new Blob([file.slice(start, start + entry.compressedSize)], { type });
        }
    }
    const source = await zipFs.createSource(name);
    try {
        return new Blob([await source.read().readAll() as BlobPart], { type });
    } finally {
        source.close();
    }
};

/**
 * Put the import, pose and train nodes back in the history at their
 * places (through `later`), and wire them up once all are in. Returns
 * the wiring step, which runs after every node has been added.
 */
const restoreDatasets = async (document: any, file: Blob, zipFs: ZipReadFileSystem, loaded: Splat[], scene: Scene, later: Later, events: Events) => {
    const storedDatasets: any[] = Array.isArray(document.datasets) ? document.datasets : [];
    const storedPoses: any[] = Array.isArray(document.poses) ? document.poses : [];
    const storedTrains: any[] = Array.isArray(document.trains) ? document.trains : [];
    if (!storedDatasets.length && !storedPoses.length && !storedTrains.length) return () => {};

    const datasets: (DatasetOp | null)[] = [];
    for (let i = 0; i < storedDatasets.length; i++) {
        const stored = storedDatasets[i];
        const s = stored?.source;
        let source: unknown = null;
        try {
            if (s?.kind === 'bytes') {
                source = { kind: 'bytes', bytes: await entryBlob(file, zipFs, s.file), name: s.name };
            } else if (s?.kind === 'images') {
                const images = [];
                for (let k = 0; k < s.names.length; k++) {
                    images.push({ name: s.names[k], data: await entryBlob(file, zipFs, `dataset_${i}/${k}`, 'image/jpeg') });
                }
                source = { kind: 'images', images };
            } else if (s?.kind === 'video') {
                source = { kind: 'video', file: new File([await entryBlob(file, zipFs, s.file)], s.name, { type: s.type }) };
            } else if (s?.kind === 'url') {
                source = { kind: 'url', url: s.url };
            }
        } catch (error) {
            console.warn(`project: import node ${i} lost its files: ${error?.message ?? error}`);
        }
        const op = new DatasetOp(source, stored?.name ?? 'dataset');
        op.counts = stored?.counts;
        op.awaitingPoses = !!stored?.awaitingPoses;
        op.bypassed = !!stored?.bypassed;
        // a folder: the browser gives no access to it again without a pick
        if (s?.kind === 'directory') op.status = i18n.t('import.pick-again');
        datasets.push(op);
        later(stored, () => {
            events.fire('edit.add', op);
            return op;
        });
    }

    const poses: PoseOp[] = [];
    const poseFiles: ({ sparse: { path: string, data: Uint8Array }[] | null, frames: { name: string, data: Blob }[] | null })[] = [];
    for (let j = 0; j < storedPoses.length; j++) {
        const stored = storedPoses[j];
        const op = new PoseOp(stored?.matcher === 'sequential' ? 'sequential' : 'exhaustive');
        op.showCameras = stored?.showCameras !== false;
        op.cameras = Array.isArray(stored?.cameras) ? stored.cameras as PoseCamera[] : [];
        op.total = Number(stored?.total) || op.cameras.length;
        op.awaitingPoses = !!stored?.awaitingPoses;
        op.bypassed = !!stored?.bypassed;
        let sparse: { path: string, data: Uint8Array }[] | null = null;
        let frames: { name: string, data: Blob }[] | null = null;
        try {
            if (Array.isArray(stored?.sparse)) {
                sparse = [];
                for (const f of stored.sparse) {
                    sparse.push({ path: f.path, data: new Uint8Array(await (await entryBlob(file, zipFs, f.file)).arrayBuffer()) });
                }
            }
            if (Array.isArray(stored?.frames)) {
                frames = [];
                for (let k = 0; k < stored.frames.length; k++) {
                    frames.push({ name: stored.frames[k], data: await entryBlob(file, zipFs, `pose_${j}/${k}`, 'image/jpeg') });
                }
            }
        } catch (error) {
            console.warn(`project: pose node ${j} lost its files: ${error?.message ?? error}`);
        }
        poses.push(op);
        poseFiles.push({ sparse, frames });
        later(stored, () => {
            events.fire('edit.add', op);
            return op;
        });
    }

    const trains: TrainOp[] = [];
    for (const stored of storedTrains) {
        const output = typeof stored?.splat === 'number' ? loaded[stored.splat] ?? null : null;
        const settings = {
            datasetName: 'dataset',
            iterations: 0,
            finalSplats: 0,
            ...(stored?.settings ?? {}),
            config: { ...(stored?.settings?.config ?? {}) }
        };
        const op = new TrainOp(scene, output, settings);
        if (typeof stored?.seed === 'number') op.seed = loaded[stored.seed];
        op.bypassed = !!stored?.bypassed;
        trains.push(op);
        later(stored, () => {
            events.fire('edit.add', op);
            return op;
        });
    }

    // wired once every node is in, whatever order they went in
    return () => {
        storedPoses.forEach((stored, j) => {
            const op = poses[j];
            const input = datasets[stored?.dataset];
            if (!input) return;
            op.datasetOp = input;
            op.inputs = [input.output];
            const { sparse, frames } = poseFiles[j];
            const inputSource = input.source as any;
            if (sparse) {
                // the posed dataset again: the photos (or the frames) and the model
                const images = frames ?? (inputSource?.kind === 'images' ? flattenNames(inputSource.images) : null);
                if (!images) return;
                op.sparse = sparse;
                op.images = images;
                const cameras = op.cameras;
                packDataset([
                    ...images.map(image => ({ filename: `images/${image.name}`, contents: image.data })),
                    ...sparse.map(f => ({ filename: f.path, contents: new Blob([f.data as BlobPart]) }))
                ]).then(({ zip }) => {
                    if (op.datasetOp !== input || op.sparse !== sparse) return;
                    op.setPosed({ kind: 'bytes', bytes: zip, name: 'dataset.zip' }, cameras, op.total);
                    events.fire('pose.changed', op);
                    events.fire('dataset.statusChanged', op);
                    events.fire('edit.changed');
                }).catch((error) => {
                    op.status = `${i18n.t('bridge.failed')} — ${String(error?.message ?? error).slice(0, 120)}`;
                    events.fire('dataset.statusChanged', op);
                });
            } else if (stored?.read && input.trainSource) {
                op.setPosed(input.trainSource, op.cameras, op.total);
            }
        });
        storedTrains.forEach((stored, k) => {
            const op = trains[k];
            const input = typeof stored?.pose === 'number' ? poses[stored.pose] :
                (typeof stored?.dataset === 'number' ? datasets[stored.dataset] : null);
            if (!input) return;
            op.datasetOp = input;
            op.inputs = [input.output];
        });
        events.fire('pose.changed', null);
    };
};

export { storeDatasets, restoreDatasets, type ProjectFile };
