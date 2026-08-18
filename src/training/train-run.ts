import { BrushConfig, BrushEngine, TrainPhase, TrainProgress, TrainSource } from './brush-engine';
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

type RunState = {
    phase: TrainPhase;
    progress: TrainProgress | null;
    active: boolean;
};

const registerTraining = (events: Events, scene: Scene) => {
    const engine = new BrushEngine();

    let runOp: TrainOp | null = null;
    let phase: TrainPhase = 'idle';
    let progress: TrainProgress | null = null;
    let lastConfig: BrushConfig | null = null;
    let snapshotBusy = false;
    let snapshotDirty = false;
    let lastSnapshotAt = 0;

    const changed = () => {
        events.fire('training.changed', runOp);
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
            events.fire('training.warning', String(error?.message ?? error));
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
        if (runOp && runOp !== op) {
            engine.stop();
        }
        runOp = op;
        progress = null;
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
            events.fire('training.warning', String(error?.message ?? error));
            phase = 'error';
        } finally {
            if (runOp === op && !engine.active) {
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
            runOp = null;
            events.fire('training.changed', op);
        }
    });

    events.function('training.state', (op: TrainOp): RunState => {
        const active = runOp === op && engine.active;
        return {
            phase: active || runOp === op ? phase : 'idle',
            progress: runOp === op ? progress : null,
            active
        };
    });

    events.function('training.isPaused', (op: TrainOp) => {
        return runOp === op && engine.isPaused;
    });
};

export { registerTraining };
