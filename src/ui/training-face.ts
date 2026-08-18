import { Container } from '@playcanvas/pcui';

import { i18n } from './localization';
import { resolveDropPayload } from '../drop-handler';
import { TrainOp } from '../edit-ops';
import { Events } from '../events';
import { TrainPhase, TrainProgress, TrainSource } from '../training/brush-engine';
import { isImageSet, listDirectory, looksLikeDataset, packDataset } from '../training/dataset';
import { ensureWrite, ingestImages, ingestImagesInPlace, ingestVideo } from '../training/video-ingest';

/**
 * The train node's parameters, mounted in the node pane the way the colour
 * panel is: one long-lived element, bound to whichever train node the
 * graph has selected via a `bindNode` expando on its dom.
 *
 * There is no preview here - the node's output splat lives in the real
 * viewport and refines in place as the run proceeds. This face is the
 * node's controls: dataset, settings, start/pause/stop, numbers.
 */

// the config fields the face edits; everything else in Brush's
// TrainStreamConfig passes through untouched
const FORM_FIELDS = [
    { key: 'total-train-iters', label: 'training.iterations', step: 1000 },
    { key: 'max-splats', label: 'training.max-splats', step: 100000 },
    { key: 'sh-degree', label: 'training.sh-degree', step: 1 },
    { key: 'max-resolution', label: 'training.max-resolution', step: 128 },
    { key: 'eval-split-every', label: 'training.eval-split', step: 1 }
] as const;

class TrainingFace extends Container {
    private events: Events;
    private op: TrainOp | null = null;
    private supported = true;

    private sourceLabel: HTMLElement;
    private statusLine: HTMLElement;
    private statsLine: HTMLElement;
    private noticeLine: HTMLElement;
    private form = new Map<string, HTMLInputElement>();
    private buttons: { [name: string]: HTMLButtonElement } = {};

    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'training-face'
        };

        super(args);

        this.events = events;

        // the node pane holds elements, not instances - the binding has to
        // travel with the dom
        (this.dom as any).bindNode = (op: TrainOp | null) => {
            this.op = op;
            this.readOp();
            this.refresh();
        };

        const section = (title: string) => {
            const el = document.createElement('div');
            el.className = 'tf-section';
            if (title) {
                const head = document.createElement('div');
                head.className = 'tf-heading';
                head.textContent = title;
                el.appendChild(head);
            }
            this.dom.appendChild(el);
            return el;
        };

        const button = (parent: HTMLElement, name: string, label: string, action: () => void) => {
            const el = document.createElement('button');
            el.className = 'tf-button';
            el.type = 'button';
            el.textContent = label;
            el.addEventListener('click', action);
            parent.appendChild(el);
            this.buttons[name] = el;
            return el;
        };

        // dataset
        const dataset = section(i18n.t('training.dataset'));
        const pickRow = document.createElement('div');
        pickRow.className = 'tf-row';
        dataset.appendChild(pickRow);
        button(pickRow, 'pickFolder', i18n.t('training.pick-folder'), () => this.pickFolder());
        button(pickRow, 'pickFiles', i18n.t('training.pick-files'), () => this.pickFiles());
        this.sourceLabel = document.createElement('div');
        this.sourceLabel.className = 'tf-source';
        dataset.appendChild(this.sourceLabel);

        // drops aimed at this node stay here rather than falling through to
        // the scene importer - folders, file lists and single files alike
        this.dom.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
        this.dom.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!e.dataTransfer) return;
            // resolve synchronously - the DataTransfer dies after the first await
            resolveDropPayload(e.dataTransfer).then(async (payload) => {
                if (payload.directory) {
                    await this.attachDirectory(payload.directory);
                } else if (payload.files.length > 0) {
                    await this.acceptFiles(payload.files.map(f => f.file), payload.files.map(f => f.filename));
                }
            }).catch(() => {});
        });

        // config
        const config = section(i18n.t('training.settings'));
        for (const field of FORM_FIELDS) {
            const row = document.createElement('label');
            row.className = 'tf-field';
            const text = document.createElement('span');
            text.textContent = i18n.t(field.label);
            const input = document.createElement('input');
            input.type = 'number';
            input.step = String(field.step);
            input.placeholder = '—';
            input.addEventListener('keydown', e => e.stopPropagation());
            input.addEventListener('change', () => {
                if (!this.op) return;
                if (input.value === '') {
                    delete this.op.settings.config[field.key];
                } else {
                    this.op.settings.config[field.key] = parseFloat(input.value);
                }
                // config has no applied effect until a run consumes it, so
                // this is a record change, not a replay
                this.events.fire('edit.changed');
            });
            row.appendChild(text);
            row.appendChild(input);
            config.appendChild(row);
            this.form.set(field.key, input);
        }

        // controls
        const controls = section('');
        const controlRow = document.createElement('div');
        controlRow.className = 'tf-row';
        controls.appendChild(controlRow);
        button(controlRow, 'start', i18n.t('training.start'), () => {
            if (this.op) this.events.fire('training.start', this.op);
        });
        button(controlRow, 'pause', i18n.t('training.pause'), () => {
            if (!this.op) return;
            const paused = this.events.invoke('training.isPaused', this.op);
            this.events.fire(paused ? 'training.resume' : 'training.pause', this.op);
            this.refresh();
        });
        button(controlRow, 'stop', i18n.t('training.stop'), () => {
            if (this.op) this.events.fire('training.stop', this.op);
        });

        // progress
        const progress = section('');
        this.statusLine = document.createElement('div');
        this.statusLine.className = 'tf-status';
        this.statsLine = document.createElement('div');
        this.statsLine.className = 'tf-stats';
        this.noticeLine = document.createElement('div');
        this.noticeLine.className = 'tf-notice';
        this.noticeLine.hidden = true;
        progress.appendChild(this.statusLine);
        progress.appendChild(this.statsLine);
        progress.appendChild(this.noticeLine);

        events.on('training.changed', (op: TrainOp) => {
            if (op === this.op) {
                this.readOp();
                this.refresh();
            }
        });

        events.on('training.warning', (text: string) => {
            this.noticeLine.textContent = text;
            this.noticeLine.hidden = false;
        });

        this.probeSupport().catch(() => {});
    }

    private async probeSupport() {
        const unsupported = () => {
            this.supported = false;
            this.refresh();
        };
        if (!('gpu' in navigator)) {
            unsupported();
            return;
        }
        try {
            const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
            if (!adapter || !adapter.features.has('subgroups' as GPUFeatureName)) {
                unsupported();
            }
        } catch (e) {
            unsupported();
        }
    }

    private async pickFolder() {
        try {
            // readwrite so a folder of bare photos can take its COLMAP kit
            const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
            await this.attachDirectory(handle);
        } catch (e) {
            // cancelled
        }
    }

    private pickFiles() {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = '.zip,.ply,.jpg,.jpeg,.png,.csv,.json,.txt,.bin,.mp4,.mov,.webm,.mkv,video/*';
        input.onchange = () => {
            const files = Array.from(input.files ?? []);
            if (files.length > 0) this.acceptFiles(files).catch(() => {});
        };
        input.click();
    }

    /**
     * Folder mode: a dataset folder attaches whole (Brush reads it in
     * place), a folder of bare photos gets the COLMAP kit written beside
     * them, anything else is not a dataset.
     */
    private async attachDirectory(handle: FileSystemDirectoryHandle) {
        const entries = await listDirectory(handle);
        const names = entries.map(e => e.path);

        if (looksLikeDataset(names)) {
            this.setDataset({ kind: 'directory', handle }, handle.name);
            return;
        }

        if (names.length > 1 && isImageSet(names)) {
            if (await ensureWrite(handle)) {
                await ingestImagesInPlace(handle, entries, this.events);
                this.markAwaitingPoses();
            } else {
                // the browser refused to write into the dropped folder:
                // fall back to copying the photos out beside a fresh kit
                const files = await Promise.all(entries.map(e => e.handle.getFile()));
                if (await ingestImages(files, this.events)) {
                    this.markAwaitingPoses();
                }
            }
            return;
        }

        this.notice(i18n.t('import.folder-unrecognized'));
    }

    /** File and file-list mode: route whatever was picked or dropped. */
    private async acceptFiles(files: File[], names?: string[]) {
        const filenames = names ?? files.map(f => f.name);
        const lower = filenames.map(f => f.toLowerCase());

        if (files.length === 1) {
            const file = files[0];
            const name = lower[0];
            if (file.type.startsWith('video/') || ['.mp4', '.mov', '.webm', '.mkv'].some(ext => name.endsWith(ext))) {
                if (await ingestVideo(file, this.events)) this.markAwaitingPoses();
            } else if (name.endsWith('.zip') || name.endsWith('.ply')) {
                const bytes = new Uint8Array(await file.arrayBuffer());
                this.setDataset({ kind: 'bytes', bytes, name: file.name }, file.name);
            } else if (isImageSet([name])) {
                this.notice(i18n.t('import.single-image'));
            } else {
                this.notice(i18n.t('import.dataset-needs-images'));
            }
            return;
        }

        if (looksLikeDataset(filenames)) {
            // several files forming one dataset: pack them into a zip
            this.events.fire('startSpinner');
            try {
                const { bytes, name } = await packDataset(files.map((f, i) => ({ filename: filenames[i], contents: f })));
                this.setDataset({ kind: 'bytes', bytes, name: `${name}.zip` }, name);
            } finally {
                this.events.fire('stopSpinner');
            }
            return;
        }

        if (isImageSet(lower)) {
            // bare photos: copy them out with the COLMAP kit
            if (await ingestImages(files, this.events)) {
                this.markAwaitingPoses();
            }
            return;
        }

        this.notice(i18n.t('import.folder-unrecognized'));
    }

    /** The dataset is out being posed; the node waits for its return. */
    private markAwaitingPoses() {
        if (this.op) {
            this.op.awaitingPoses = true;
            this.op.settings.datasetName = i18n.t('training.awaiting-poses');
            this.events.fire('edit.changed');
        }
        this.refresh();
    }

    private notice(text: string) {
        this.noticeLine.textContent = text;
        this.noticeLine.hidden = false;
    }

    private setDataset(dataset: TrainSource, name: string) {
        if (!this.op) return;
        this.op.dataset = dataset;
        this.op.settings.datasetName = name;
        this.events.fire('edit.changed');
        this.refresh();
    }

    /** settings -> controls */
    private readOp() {
        if (!this.op) return;
        for (const [key, input] of this.form) {
            const value = this.op.settings.config[key];
            input.value = value === undefined ? '' : String(value);
        }
    }

    private refresh() {
        const op = this.op;
        if (!op) return;

        this.sourceLabel.textContent = op.dataset ?
            op.settings.datasetName :
            i18n.t(op.awaitingPoses ? 'training.awaiting-poses' :
                op.settings.finalSplats > 0 ? 'training.reattach-dataset' : 'training.no-dataset');

        const state = this.events.invoke('training.state', op) as { phase: TrainPhase, progress: TrainProgress | null, active: boolean };
        const paused = this.events.invoke('training.isPaused', op);

        if (!this.supported) {
            this.noticeLine.textContent = i18n.t('training.webgpu-required');
            this.noticeLine.hidden = false;
        }

        this.statusLine.textContent = i18n.t(`training.phase-${state.active || state.phase === 'done' ? state.phase : 'idle'}`);

        const p = state.progress;
        if (p) {
            const parts = [
                `${p.iter.toLocaleString()} it`,
                `${p.numSplats.toLocaleString()} splats`,
                p.stepsPerSec ? `${p.stepsPerSec.toFixed(1)} it/s` : null,
                p.trainViews ? `${p.trainViews}/${p.evalViews} views` : null,
                p.psnr !== undefined ? `${p.psnr.toFixed(2)} dB` : null
            ].filter(s => s !== null);
            this.statsLine.textContent = parts.join(' · ');
        } else if (op.settings.finalSplats > 0) {
            const s = op.settings;
            const parts = [
                `${s.iterations.toLocaleString()} it`,
                `${s.finalSplats.toLocaleString()} splats`,
                s.psnr !== undefined ? `${s.psnr.toFixed(2)} dB` : null
            ].filter(x => x !== null);
            this.statsLine.textContent = parts.join(' · ');
        } else {
            this.statsLine.textContent = '';
        }

        const running = state.active;
        this.buttons.start.textContent = i18n.t(op.settings.finalSplats > 0 ? 'training.retrain' : 'training.start');
        this.buttons.start.disabled = !this.supported || !op.dataset || running;
        this.buttons.pause.textContent = i18n.t(paused ? 'training.resume' : 'training.pause');
        this.buttons.pause.disabled = !this.supported || !running;
        this.buttons.stop.disabled = !this.supported || !running;
    }
}

export { TrainingFace };
