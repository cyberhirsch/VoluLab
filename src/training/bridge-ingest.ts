import { BridgeImage, bridgeReady, estimatePoses } from './bridge-client';
import { browserPosesReady, estimatePosesInBrowser } from './browser-poses';
import { packDataset } from './dataset';
import { ingestImages } from './video-ingest';
import { DatasetOp } from '../edit-ops';
import { Events } from '../events';
import { i18n } from '../ui/localization';

/** Can poses be estimated right now: in the browser, or by the bridge? */
const posesReady = async (): Promise<boolean> => await browserPosesReady() || await bridgeReady();

/**
 * Estimate poses in the browser when it can, else through the bridge.
 * The browser run needs equal-sized images (one shared camera); when it
 * fails and the bridge is running, the bridge gets a go.
 */
const estimateAny = async (images: BridgeImage[], matcher: 'sequential' | 'exhaustive', stage: (key: string, detail?: string) => void, signal: AbortSignal) => {
    if (await browserPosesReady()) {
        try {
            return await estimatePosesInBrowser(images, matcher, stage, signal);
        } catch (error) {
            if (signal.aborted || !await bridgeReady()) throw error;
        }
    }
    return estimatePoses(images, matcher, stage, signal);
};

/**
 * Images arrive named by their path in the dropped folder; the dataset
 * keeps them flat under images/. The file name alone is used unless two
 * images share it (a/0001.jpg, b/0001.jpg) - then the path, flattened,
 * so neither overwrites the other.
 */
const flattenNames = (images: BridgeImage[]): BridgeImage[] => {
    const base = (name: string) => name.split('/').pop();
    const counts = new Map<string, number>();
    images.forEach(i => counts.set(base(i.name), (counts.get(base(i.name)) ?? 0) + 1));
    return images.map(i => ({
        name: counts.get(base(i.name)) > 1 ? i.name.replace(/\//g, '_') : base(i.name),
        data: i.data
    }));
};

// the pose job each node is running: one per node, the newest wins
const running = new WeakMap<DatasetOp, AbortController>();

// one pose job at a time across nodes - dropping several videos queues
// them instead of extracting and posing all of them at once
let queue: Promise<unknown> = Promise.resolve();

/** Stop the node's pose job, if it has one; its result will not land. */
const cancelPoseJob = (op: DatasetOp) => {
    running.get(op)?.abort();
    running.delete(op);
};

/**
 * Posing failed and no bridge is running: offer the COLMAP script kit,
 * the manual route. The popup's button is the user gesture the folder
 * picker needs.
 */
const offerKit = async (op: DatasetOp, images: BridgeImage[], events: Events) => {
    const result = await events.invoke('showPopup', {
        type: 'okcancel',
        header: i18n.t('training.dataset'),
        message: `${op.status}\n\n${i18n.t('bridge.offer-kit')}`
    });
    if (result?.action !== 'ok') return;
    if (await ingestImages(images.map(i => new File([i.data], i.name)), events)) {
        op.status = undefined;
        op.markAwaiting(i18n.t('training.awaiting-poses'));
        events.fire('dataset.statusChanged', op);
        events.fire('edit.changed');
    }
};

/**
 * Drive a pose job into an import node: the COLMAP stages stream onto
 * the node's status line, and the posed dataset lands as the node's
 * source when the run succeeds. The node exists the whole time, so the
 * graph shows the work where its result will live.
 *
 * `source` is the images, or a function producing them (video frames),
 * which is called only when the job's turn comes. A newer job on the
 * same node cancels this one, as does the node leaving history; a
 * cancelled job changes nothing on the node.
 */
const bridgePoseIntoOp = (op: DatasetOp, source: BridgeImage[] | (() => Promise<BridgeImage[]>), matcher: 'sequential' | 'exhaustive', events: Events): Promise<boolean> => {
    cancelPoseJob(op);
    const ctrl = new AbortController();
    running.set(op, ctrl);
    const { signal } = ctrl;

    const current = () => running.get(op) === ctrl && !signal.aborted;
    // the node goes into history through the edit queue, so it may not be
    // there yet when the job starts: it counts as removed only once it has
    // been seen in history and is gone again
    let seen = false;
    const removed = () => {
        const ops = (events.invoke('edit.history') as { ops: unknown[] } | undefined)?.ops;
        if (!ops) return false;
        if (ops.includes(op)) {
            seen = true;
            return false;
        }
        return seen;
    };

    const stage = (key: string, detail = '') => {
        if (!current()) return;
        if (removed()) {
            ctrl.abort();
            return;
        }
        op.status = `${i18n.t(`bridge.stage-${key}`)}${detail ? ` ${detail}` : ''}`;
        events.fire('dataset.statusChanged', op);
    };

    const run = async (): Promise<boolean> => {
        if (!current() || removed()) return false;
        let images: BridgeImage[] = [];
        try {
            if (typeof source === 'function') {
                stage('frames');
                images = await source();
            } else {
                images = source;
            }
            signal.throwIfAborted();
            images = flattenNames(images);

            const sparse = await estimateAny(images, matcher, stage, signal);
            if (!current() || removed()) return false;

            // the zip is a Blob over the images' own blobs: packing reads
            // each once for its checksum and copies none of them
            stage('packing');
            const files = [
                ...images.map(image => ({ filename: `images/${image.name}`, contents: image.data })),
                ...sparse.map(f => ({ filename: f.path, contents: new Blob([f.data as BlobPart]) }))
            ];
            const { zip } = await packDataset(files, signal);
            if (!current() || removed()) return false;

            op.setSource({ kind: 'bytes', bytes: zip, name: 'dataset.zip' }, op.sourceName);
            op.status = undefined;
            events.fire('dataset.statusChanged', op);
            events.fire('edit.changed');
            return true;
        } catch (error) {
            if (!current()) return false;
            op.status = `${i18n.t('bridge.failed')} — ${String((error as any)?.message ?? error).slice(0, 120)}`;
            events.fire('dataset.statusChanged', op);
            if (images.length > 1 && !await bridgeReady()) {
                // not awaited: the next queued job need not wait on the popup
                offerKit(op, images, events).catch(() => {});
            }
            return false;
        } finally {
            if (running.get(op) === ctrl) running.delete(op);
        }
    };

    stage('queued');
    const turn = queue.then(run);
    queue = turn.catch(() => {});
    return turn;
};

export { bridgePoseIntoOp, cancelPoseJob, posesReady };
