import { Container } from '@playcanvas/pcui';

import { i18n } from './localization';
import { TrainOp } from '../edit-ops';
import { Events } from '../events';
import {
    BrushConfig,
    BrushEngine,
    TrainPhase,
    TrainProgress,
    TrainSource,
    WebGPUTrainingUnavailableError
} from '../training/brush-engine';
import { PreviewRenderer } from '../training/preview-renderer';
import { ingestVideo } from '../training/video-ingest';

/**
 * The training pane: pick a capture dataset, tune a handful of settings,
 * and train gaussians without leaving the editor. Brush (Rust compiled to
 * WASM) does the optimisation on its own WebGPU device; the pane shows a
 * live point-sprite preview and commits the finished splats to the scene
 * as a train node.
 */

// the config fields the form edits; everything else in Brush's
// TrainStreamConfig passes through untouched
const FORM_FIELDS = [
    { key: 'total-train-iters', label: 'training.iterations', step: 1000 },
    { key: 'max-splats', label: 'training.max-splats', step: 100000 },
    { key: 'sh-degree', label: 'training.sh-degree', step: 1 },
    { key: 'max-resolution', label: 'training.max-resolution', step: 128 },
    { key: 'eval-split-every', label: 'training.eval-split', step: 1 }
] as const;

class TrainingPanel extends Container {
    private events: Events;
    private engine = new BrushEngine();
    private renderer: PreviewRenderer | null = null;

    private source: TrainSource | null = null;
    private sourceName = '';
    private lastConfig: BrushConfig | null = null;
    private progress: TrainProgress | null = null;
    private phase: TrainPhase = 'idle';
    private committed = false;
    private rebindWanted = false;

    private sourceLabel: HTMLElement;
    private statusLine: HTMLElement;
    private statsLine: HTMLElement;
    private noticeLine: HTMLElement;
    private canvas: HTMLCanvasElement;
    private form = new Map<string, HTMLInputElement>();
    private buttons: { [name: string]: HTMLButtonElement } = {};

    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'training-panel',
            class: 'panel'
        };

        super(args);

        this.events = events;

        // keep pane gestures out of the viewport's handlers
        ['pointerdown', 'wheel', 'dblclick', 'contextmenu'].forEach((type) => {
            this.dom.addEventListener(type, (e: Event) => e.stopPropagation());
        });

        const section = (title: string) => {
            const el = document.createElement('div');
            el.className = 'tp-section';
            if (title) {
                const head = document.createElement('div');
                head.className = 'tp-heading';
                head.textContent = title;
                el.appendChild(head);
            }
            this.dom.appendChild(el);
            return el;
        };

        const button = (parent: HTMLElement, name: string, label: string, action: () => void) => {
            const el = document.createElement('button');
            el.className = 'tp-button';
            el.textContent = label;
            el.addEventListener('click', action);
            parent.appendChild(el);
            this.buttons[name] = el;
            return el;
        };

        // dataset
        const dataset = section(i18n.t('training.dataset'));
        const pickRow = document.createElement('div');
        pickRow.className = 'tp-row';
        dataset.appendChild(pickRow);
        button(pickRow, 'pickFolder', i18n.t('training.pick-folder'), () => this.pickFolder());
        button(pickRow, 'pickFile', i18n.t('training.pick-file'), () => this.pickFile());
        this.sourceLabel = document.createElement('div');
        this.sourceLabel.className = 'tp-source';
        this.sourceLabel.textContent = i18n.t('training.no-dataset');
        dataset.appendChild(this.sourceLabel);

        // drops of zips/videos belong to this pane, not to the scene importer
        this.dom.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
        this.dom.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const file = e.dataTransfer?.files?.[0];
            if (file) this.acceptFile(file);
        });

        // config
        const config = section(i18n.t('training.settings'));
        for (const field of FORM_FIELDS) {
            const row = document.createElement('label');
            row.className = 'tp-field';
            const text = document.createElement('span');
            text.textContent = i18n.t(field.label);
            const input = document.createElement('input');
            input.type = 'number';
            input.step = String(field.step);
            input.placeholder = '—';
            row.appendChild(text);
            row.appendChild(input);
            config.appendChild(row);
            this.form.set(field.key, input);
        }

        // controls
        const controls = section('');
        const controlRow = document.createElement('div');
        controlRow.className = 'tp-row';
        controls.appendChild(controlRow);
        button(controlRow, 'start', i18n.t('training.start'), () => this.start());
        button(controlRow, 'pause', i18n.t('training.pause'), () => this.togglePause());
        button(controlRow, 'stop', i18n.t('training.stop'), () => this.stopRun());
        button(controlRow, 'commit', i18n.t('training.add-to-scene'), () => this.commit());

        // progress
        const progress = section('');
        this.statusLine = document.createElement('div');
        this.statusLine.className = 'tp-status';
        this.statsLine = document.createElement('div');
        this.statsLine.className = 'tp-stats';
        this.noticeLine = document.createElement('div');
        this.noticeLine.className = 'tp-notice';
        this.noticeLine.hidden = true;
        progress.appendChild(this.statusLine);
        progress.appendChild(this.statsLine);
        progress.appendChild(this.noticeLine);

        // preview
        this.canvas = document.createElement('canvas');
        this.canvas.className = 'tp-preview';
        this.dom.appendChild(this.canvas);

        // engine -> UI
        this.engine.onPhase = (phase) => {
            this.phase = phase;
            this.refresh();
        };
        this.engine.onProgress = (p) => {
            this.progress = { ...p };
            this.refresh();
        };
        this.engine.onSplatsUpdated = () => {
            this.rebindWanted = true;
        };
        this.engine.onWarning = (text) => {
            this.noticeLine.textContent = text;
            this.noticeLine.hidden = false;
        };

        // a node face's retrain button lands here with the op's record
        events.on('training.retrain', (op: TrainOp) => {
            for (const [key, input] of this.form) {
                const value = op.settings.config[key];
                input.value = value === undefined ? '' : String(value);
            }
            if (op.dataset) {
                this.setSource(op.dataset as TrainSource, op.settings.datasetName);
            } else {
                this.sourceLabel.textContent = i18n.t('training.reattach-dataset');
            }
            this.events.fire('workspace.reveal', 'training');
        });

        events.on('training.open', () => {
            this.events.fire('workspace.reveal', 'training');
        });

        // surface an unsupported browser before any buttons are pressed
        this.probeSupport();
        this.refresh();
        this.renderLoop();
    }

    private async probeSupport() {
        if (!('gpu' in navigator)) {
            this.markUnsupported();
            return;
        }
        try {
            const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
            if (!adapter || !adapter.features.has('subgroups' as GPUFeatureName)) {
                this.markUnsupported();
            }
        } catch (e) {
            this.markUnsupported();
        }
    }

    private markUnsupported() {
        this.noticeLine.textContent = i18n.t('training.webgpu-required');
        this.noticeLine.hidden = false;
        for (const name in this.buttons) {
            this.buttons[name].disabled = true;
        }
    }

    private async pickFolder() {
        try {
            const handle = await window.showDirectoryPicker();
            this.setSource({ kind: 'directory', handle }, handle.name);
        } catch (e) {
            // cancelled
        }
    }

    private pickFile() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.zip,.ply,video/*';
        input.onchange = () => {
            const file = input.files?.[0];
            if (file) this.acceptFile(file);
        };
        input.click();
    }

    private async acceptFile(file: File) {
        if (file.type.startsWith('video/')) {
            const result = await ingestVideo(file, this.events);
            if (result) {
                this.sourceLabel.textContent = i18n.t('training.awaiting-poses');
            }
            return;
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        this.setSource({ kind: 'bytes', bytes, name: file.name }, file.name);
    }

    private setSource(source: TrainSource, name: string) {
        this.source = source;
        this.sourceName = name;
        this.sourceLabel.textContent = name;
        this.refresh();
    }

    private async start() {
        if (!this.source || this.engine.active) return;

        this.committed = false;
        this.noticeLine.hidden = true;
        try {
            await this.engine.start(this.source, (defaults) => {
                const config = { ...defaults };
                for (const [key, input] of this.form) {
                    if (input.value !== '') {
                        config[key] = parseFloat(input.value);
                    } else {
                        // show the effective value the run is using
                        input.value = defaults[key] === undefined ? '' : String(defaults[key]);
                    }
                }
                this.lastConfig = config;
                return Promise.resolve(config);
            });
            // the pump has ended: a finished run commits itself
            if (this.phase === 'done' && !this.committed) {
                await this.commit();
            }
        } catch (error) {
            if (error instanceof WebGPUTrainingUnavailableError) {
                this.markUnsupported();
            } else {
                this.noticeLine.textContent = String(error.message ?? error);
                this.noticeLine.hidden = false;
            }
        }
    }

    private togglePause() {
        if (this.engine.isPaused) {
            this.engine.resume();
        } else {
            this.engine.pause();
        }
        this.refresh();
    }

    private stopRun() {
        this.engine.stop();
        this.phase = 'idle';
        this.refresh();
    }

    private async commit() {
        if (!this.engine.active || this.committed) return;
        try {
            const bytes = await this.engine.exportPly();
            const name = this.sourceName.replace(/\.(zip|ply|mp4|mov|webm|mkv)$/i, '') || 'trained';
            const settings = {
                datasetName: this.sourceName,
                config: this.lastConfig ?? {},
                iterations: this.progress?.iter ?? 0,
                finalSplats: this.progress?.numSplats ?? 0,
                psnr: this.progress?.psnr
            };
            const splat = await this.events.invoke('training.commit', {
                plyBytes: bytes, name, settings, dataset: this.source
            });
            if (splat) {
                this.committed = true;
                this.statusLine.textContent = i18n.t('training.committed');
            }
        } catch (error) {
            this.noticeLine.textContent = String(error.message ?? error);
            this.noticeLine.hidden = false;
        }
    }

    private refresh() {
        const p = this.progress;
        const phaseText = i18n.t(`training.phase-${this.phase}`);
        this.statusLine.textContent = phaseText;
        if (p) {
            const parts = [
                `${p.iter.toLocaleString()} it`,
                `${p.numSplats.toLocaleString()} splats`,
                p.stepsPerSec ? `${p.stepsPerSec.toFixed(1)} it/s` : null,
                p.trainViews ? `${p.trainViews}/${p.evalViews} views` : null,
                p.psnr !== undefined ? `${p.psnr.toFixed(2)} dB` : null
            ].filter(s => s !== null);
            this.statsLine.textContent = parts.join(' · ');
        } else {
            this.statsLine.textContent = '';
        }

        const running = this.engine.active;
        this.buttons.start.disabled = !this.source || (running && this.phase !== 'done');
        this.buttons.pause.disabled = !running || this.phase === 'done';
        this.buttons.pause.textContent = this.engine.isPaused ? i18n.t('training.resume') : i18n.t('training.pause');
        this.buttons.stop.disabled = !running;
        this.buttons.commit.disabled = !running || !p || p.numSplats === 0;
    }

    private renderLoop() {
        const tick = () => {
            // a parked pane sits off-screen; don't render into it
            const visible = this.canvas.isConnected && this.canvas.offsetParent !== null;
            if (visible && this.engine.device) {
                if (!this.renderer) {
                    this.renderer = new PreviewRenderer(this.engine.device, this.canvas);
                }
                if (this.rebindWanted) {
                    this.rebindWanted = false;
                    const buffers = this.engine.currentBuffers();
                    if (buffers) this.renderer.bindExternal(buffers);
                }
                this.renderer.render();
            }
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }
}

export { TrainingPanel };
