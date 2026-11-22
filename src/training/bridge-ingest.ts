import { BridgeImage, bridgeReady, estimatePoses } from './bridge-client';
import { PoseRun, StageFn, browserPosesReady, estimatePosesInBrowser } from './browser-poses';
import { packDataset } from './dataset';
import { camerasFromSparse, meanReprojectionError } from './pose-read';
import { ingestImages } from './video-ingest';
import { PoseOp, PoseOptions } from '../edit-ops';
import { Events } from '../events';
import { i18n } from '../ui/localization';

/** Can poses be estimated right now: in the browser, or by the bridge? */
const posesReady = async (): Promise<boolean> => await browserPosesReady() || await bridgeReady();

/**
 * Estimate poses in the browser when it can, else through the bridge.
 * The browser run needs equal-sized images (one shared camera); when it
 * fails and the bridge is running, the bridge gets a go. Either way the
 * model files come back with what the run came to: the images placed and
 * not, and the mean reprojection error of the points.
 */
const estimateAny = async (images: BridgeImage[], matcher: 'sequential' | 'exhaustive', stage: StageFn, signal: AbortSignal, options: PoseOptions, onLog: (line: string) => void): Promise<PoseRun> => {
    if (await browserPosesReady()) {
        try {
            return await estimatePosesInBrowser(images, matcher, stage, signal, options, onLog);
        } catch (error) {
            if (signal.aborted || !await bridgeReady()) throw error;
        }
    }
    const files = await estimatePoses(images, matcher, stage, signal, options);
    // the bridge renames images it stores; images.txt names them so
    const placed = new Set(camerasFromSparse(files).map(c => c.name));
    const unregistered = images.map(i => i.name).filter(name => !placed.has(name));
    return {
        files,
        report: { registered: images.length - unregistered.length, total: images.length, meanError: meanReprojectionError(files), unregistered }
    };
};

/** seconds as m:ss */
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

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
const running = new WeakMap<PoseOp, AbortController>();

// one pose job at a time across nodes - dropping several videos queues
// them instead of extracting and posing all of them at once
let queue: Promise<unknown> = Promise.resolve();

/** Stop the node's pose job, if it has one; its result will not land. */
const cancelPoseJob = (op: PoseOp) => {
    running.get(op)?.abort();
    running.delete(op);
};

/** Is a pose job queued or running for the node? */
const poseJobRunning = (op: PoseOp) => running.has(op);

/**
 * Posing failed and no bridge is running: offer the COLMAP script kit,
 * the manual route. The popup's button is the user gesture the folder
 * picker needs.
 */
const offerKit = async (op: PoseOp, images: BridgeImage[], events: Events) => {
    const result = await events.invoke('showPopup', {
        type: 'okcancel',
        header: i18n.t('training.dataset'),
        message: `${op.status}\n\n${i18n.t('bridge.offer-kit')}`
    });
    if (result?.action !== 'ok') return;
    if (await ingestImages(images.map(i => new File([i.data], i.name)), events)) {
        // the poses come back through the import node: its folder, picked
        // again once COLMAP has run, is read by this node
        op.status = undefined;
        op.awaitingPoses = true;
        events.fire('dataset.statusChanged', op);
        events.fire('edit.changed');
    }
};

/**
 * Drive a pose job into a pose node: the COLMAP stages stream onto the
 * node's status line, and the posed dataset lands as the node's output
 * when the run succeeds, with the cameras it found. The node exists the
 * whole time, so the graph shows the work where its result will live.
 *
 * `source` is the images, or a function producing them (video frames),
 * which is called only when the job's turn comes. A newer job on the
 * same node cancels this one, as does the node leaving history; a
 * cancelled job changes nothing on the node.
 */
const bridgePoseIntoOp = (op: PoseOp, source: BridgeImage[] | (() => Promise<BridgeImage[]>), matcher: 'sequential' | 'exhaustive', events: Events): Promise<boolean> => {
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

    // the mapper is one global solve with no progress of its own: its
    // status says the phase its log names and how long it has run
    let mapping: { since: number, phase: string, placed: number, detail: string } | null = null;
    let ticker: ReturnType<typeof setInterval> | null = null;
    const stopTicker = () => {
        if (ticker) clearInterval(ticker);
        ticker = null;
    };
    const mappingText = () => {
        const m = mapping;
        const parts = [m.phase || i18n.t('bridge.phase-start'), clock((performance.now() - m.since) / 1000)];
        if (m.placed) parts.push(i18n.t('bridge.placed', { count: m.placed }));
        if (m.detail) parts.push(m.detail);
        return `${i18n.t('bridge.stage-mapping')} — ${parts.join(' · ')}`;
    };

    const stage: StageFn = (key, detail = '') => {
        if (!current()) {
            stopTicker();
            return;
        }
        if (removed()) {
            stopTicker();
            ctrl.abort();
            return;
        }
        if (key === 'mapping') {
            mapping ??= { since: performance.now(), phase: '', placed: 0, detail: '' };
            mapping.detail = typeof detail === 'string' ? detail : '';
            ticker ??= setInterval(() => stage('mapping', mapping?.detail), 1000);
            op.status = mappingText();
        } else {
            stopTicker();
            mapping = null;
            op.status = typeof detail === 'object' ?
                i18n.t(`bridge.stage-${key}-n`, detail) :
                `${i18n.t(`bridge.stage-${key}`)}${detail ? ` ${detail}` : ''}`;
        }
        events.fire('dataset.statusChanged', op);
    };

    /** the mapper's log: its newest line, and the phase it names */
    const onLog = (line: string) => {
        if (!current()) return;
        const text = line.trim();
        if (!text) return;
        op.log = text;
        if (mapping) {
            const phase = /^Running (.+)/i.exec(text);
            if (phase) mapping.phase = phase[1].replace(/\.+$/, '');
            if (/^Registered frame/i.test(text)) mapping.placed++;
            op.status = mappingText();
        }
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

            const madeWith = op.settingsKey;
            op.log = undefined;
            const { files: sparse, report } = await estimateAny(images, matcher, stage, signal, { ...op.options }, onLog);
            stopTicker();
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

            op.sparse = sparse.map(f => ({ path: f.path, data: f.data }));
            op.images = images;
            op.setPosed({ kind: 'bytes', bytes: zip, name: 'dataset.zip' }, camerasFromSparse(op.sparse), images.length);
            op.report = report;
            op.madeWith = madeWith;
            op.status = undefined;
            events.fire('pose.changed', op);
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
            stopTicker();
            if (running.get(op) === ctrl) running.delete(op);
            // the node's face enables its buttons by whether a job runs
            events.fire('pose.changed', op);
        }
    };

    stage('queued');
    const turn = queue.then(run);
    queue = turn.catch(() => {});
    return turn;
};

export { bridgePoseIntoOp, cancelPoseJob, flattenNames, poseJobRunning, posesReady };
