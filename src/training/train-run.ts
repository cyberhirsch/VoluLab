import { BrushConfig, BrushEngine, TrainLoad, TrainLogLine, TrainPhase, TrainProgress, TrainSource } from './brush-engine';
import { TrainOp } from '../edit-ops';
import { Events } from '../events';
import { loadGSplatData, MappedReadFileSystem } from '../io';
import { Scene } from '../scene';
import { Splat } from '../splat';

/**
 * Drives a train node's run, and feeds its output into the scene.
 *
 * The node is the interface: it enters history pending, this controller
 * runs the trainer for it, and the node's output splat appears in the
 * viewport at the first snapshot and refines in place after that - the
 * same replaceData path a sequence frame swap uses. There is no separate
 * preview; the viewport is the live view.
 *
 * One run at a time. Starting a run for another node stops the current
 * one; undoing, removing or bypassing a node whose run is active stops it
 * too, which is what makes the node the owner of its run rather than a
 * spectator to it.
 */

/**
 * How often the trainer's state is pulled into the scene. A snapshot is a
 * GPU readback plus a full PLY parse - O(seconds) at a million gaussians -
 * so it is throttled, skipped while one is in flight, and interim
 * snapshots skip morton reordering. The final snapshot always lands, and
 * takes the reorder for render performance.
 */
const SNAPSHOT_INTERVAL_MS = 5000;

/** Lines kept per node - enough to hold a run's account of itself. */
const LOG_LIMIT = 200;

type RunState = {
    phase: TrainPhase;
    progress: TrainProgress | null;
    /** what a load in flight looks like from outside; null once it ends */
    load: TrainLoad | null;
    /** this node's last run, in the order it happened */
    log: TrainLogLine[];
    active: boolean;
};

const registerTraining = (events: Events, scene: Scene) => {
    const engine = new BrushEngine();

    let runOp: TrainOp | null = null;
    let phase: TrainPhase = 'idle';
    let progress: TrainProgress | null = null;
    let load: TrainLoad | null = null;
    let lastConfig: BrushConfig | null = null;
    let snapshotBusy = false;
    let snapshotDirty = false;
    let lastSnapshotAt = 0;

    // the log belongs to the node, not to the engine: it outlives the run
    // that wrote it, so an error is still readable after the run has ended
    const logs = new WeakMap<TrainOp, TrainLogLine[]>();

    const changed = () => {
        events.fire('training.changed', runOp);
    };

    const note = (op: TrainOp, line: TrainLogLine) => {
        const lines = logs.get(op) ?? [];
        lines.push(line);
        if (lines.length > LOG_LIMIT) lines.shift();
        logs.set(op, lines);
    };

    // the run belongs to its node: if the node stops being applied history
    // (undo, removal, bypass), the run stops with it
    const opStillApplied = (op: TrainOp) => {
        const { ops, cursor } = events.invoke('edit.history') as { ops: any[], cursor: number };
        const index = ops.indexOf(op);
        return index !== -1 && index < cursor && !op.bypassed;
    };

    const snapshot = async (op: TrainOp, final: boolean) => {
        if (snapshotBusy) return;
        snapshotBusy = true;
        try {
            const bytes = await engine.exportPly();
            if (runOp !== op || !opStillApplied(op)) return;

            const name = `${op.settings.datasetName.replace(/\.(zip|ply|mp4|mov|webm|mkv)$/i, '') || 'trained'}.ply`;
            const fileSystem = new MappedReadFileSystem();
            fileSystem.addFile(name, new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
            // interim snapshots skip the morton reorder for speed; the final
            // one keeps it, since that object stays in the scene
            const { gsplatData, transform } = await loadGSplatData(name, fileSystem, !final);
            if (runOp !== op || !opStillApplied(op)) return;

            const asset = scene.assetLoader.createGSplatAsset(gsplatData, name);
            if (!op.output) {
                op.output = new Splat(asset, transform.rotation);
                await scene.add(op.output);
                // the graph moves the node from the scene lane onto its own
                events.fire('edit.changed');
            } else {
                await op.output.replaceData(asset);
            }
            lastSnapshotAt = performance.now();
            snapshotDirty = false;
        } catch (error) {
            const text = String(error?.message ?? error);
            note(op, { at: performance.now(), level: 'warn', text: `snapshot: ${text}` });
            events.fire('training.warning', text);
        } finally {
            snapshotBusy = false;
        }
    };

    const maybeSnapshot = (op: TrainOp) => {
        if (!snapshotDirty || snapshotBusy) return;
        if (performance.now() - lastSnapshotAt < SNAPSHOT_INTERVAL_MS) return;
        snapshot(op, false).catch(() => {});
    };

    engine.onPhase = (p) => {
        phase = p;
        changed();
    };
    engine.onProgress = (p) => {
        progress = { ...p };
        if (runOp) maybeSnapshot(runOp);
        changed();
    };
    engine.onSplatsUpdated = () => {
        snapshotDirty = true;
    };
    engine.onWarning = (text) => {
        events.fire('training.warning', text);
    };
    engine.onLog = (line) => {
        if (runOp) note(runOp, line);
        changed();
    };
    engine.onLoad = (l) => {
        load = l;
        changed();
    };

    events.on('edit.changed', () => {
        if (runOp && engine.active && !opStillApplied(runOp)) {
            engine.stop();
            phase = 'idle';
            const stopped = runOp;
            runOp = null;
            events.fire('training.changed', stopped);
        }
    });

    events.on('training.start', async (op: TrainOp) => {
        if (!op?.dataset) return;
        // a run already coming up owns the engine until it has its Training;
        // a second one started inside that window frees the first one's
        if (engine.starting) {
            note(op, { at: performance.now(), level: 'warn', text: 'a run is already starting' });
            changed();
            return;
        }
        if (runOp && runOp !== op) {
            engine.stop();
        }
        runOp = op;
        progress = null;
        load = null;
        logs.set(op, []);
        snapshotDirty = false;
        lastSnapshotAt = 0;

        // the record keeps the name of what actually fed this run
        if (op.datasetOp) op.settings.datasetName = op.datasetOp.sourceName;

        // does anything downstream stand on this node's output? then a
        // retrain has replaced data under applied history and it must re-run
        const hadOutput = !!op.output;

        try {
            await engine.start(op.dataset as TrainSource, (defaults) => {
                const config = { ...defaults, ...op.settings.config };
                lastConfig = config;
                // show the effective values back on the node
                op.settings.config = config;
                events.fire('training.changed', op);
                return Promise.resolve(config);
            });

            if (runOp !== op) return;

            if (phase === 'done') {
                await snapshot(op, true);
                op.settings.iterations = progress?.iter ?? op.settings.iterations;
                op.settings.finalSplats = progress?.numSplats ?? op.settings.finalSplats;
                if (progress?.psnr !== undefined) op.settings.psnr = progress.psnr;
                if (lastConfig) op.settings.config = lastConfig;

                // the run is over; the Training object's buffers are no
                // longer needed, and history re-resolves anything that stood
                // on the previous output
                engine.stop();
                events.fire('edit.changed');
                if (hadOutput) {
                    await events.invoke('edit.reapplyAll');
                }
            }
        } catch (error) {
            const text = String(error?.message ?? error);
            note(op, { at: performance.now(), level: 'error', text });
            events.fire('training.warning', text);
            phase = 'error';
        } finally {
            // a finished or failed run stays the node's run until another
            // begins: its phase, its numbers and its log are the account of
            // what happened, and they are worth more than a blank node
            if (runOp === op && !engine.active && phase !== 'done' && phase !== 'error') {
                runOp = null;
            }
            changed();
        }
    });

    events.on('training.pause', (op: TrainOp) => {
        if (runOp === op) {
            engine.pause();
            changed();
        }
    });

    events.on('training.resume', (op: TrainOp) => {
        if (runOp === op) {
            engine.resume();
            changed();
        }
    });

    events.on('training.stop', (op: TrainOp) => {
        if (runOp === op) {
            engine.stop();
            phase = 'idle';
            note(op, { at: performance.now(), level: 'info', text: 'stopped' });
            runOp = null;
            events.fire('training.changed', op);
        }
    });

    events.function('training.state', (op: TrainOp): RunState => {
        const active = runOp === op && engine.active;
        return {
            phase: active || runOp === op ? phase : 'idle',
            progress: runOp === op ? progress : null,
            load: runOp === op ? load : null,
            log: logs.get(op) ?? [],
            active
        };
    });

    events.function('training.isPaused', (op: TrainOp) => {
        return runOp === op && engine.isPaused;
    });
};

export { registerTraining, type RunState };
