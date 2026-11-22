import { Container } from '@playcanvas/pcui';

import { i18n } from './localization';
import { DatasetOp, DatasetInput, POSE_CAMERA_MODELS, PoseMatcher, PoseOp, PoseOptions, isImageNode } from '../edit-ops';
import { Events } from '../events';
import { poseJobRunning } from '../training/bridge-ingest';
import { analysisOf } from '../training/import-subset';

// feature caps offered; any other can be typed
const FEATURE_PRESETS = [2048, 4096, 8192, 16384];

/** the import node at the head of a chain of image nodes */
const importOf = (input: DatasetInput | undefined): DatasetOp | null => {
    let at = input;
    while (at && isImageNode(at)) at = at.datasetOp;
    return at instanceof DatasetOp ? at : null;
};

/**
 * The pose node's face, in the node pane: what it poses, the matcher and
 * COLMAP's options, how far the job is (in words: which stage, and what
 * its numbers count), the newest line of the run's log, and what the run
 * came to - how many images it placed, the mean reprojection error, and
 * the images it could not place, each of which shows its thumbnail when
 * clicked.
 */
class PoseFace extends Container {
    private events: Events;
    private op: PoseOp | null = null;

    private sourceLabel: HTMLElement;
    private statusLine: HTMLElement;
    private logLine: HTMLElement;
    private countLine: HTMLElement;
    private staleLine: HTMLElement;
    private missingList: HTMLElement;
    private missingThumb: HTMLCanvasElement;
    private matcher: HTMLSelectElement;
    private cameraModel: HTMLSelectElement;
    private sharedCamera: HTMLInputElement;
    private maxFeatures: HTMLInputElement;
    private overlap: HTMLInputElement;
    private overlapRow: HTMLElement;
    private runButton: HTMLButtonElement;
    private cancelButton: HTMLButtonElement;
    private shown: HTMLInputElement;
    /** the unplaced images the list shows, so it is built once per run */
    private listed: string | null = null;

    constructor(events: Events, args = {}) {
        super({ ...args, id: 'pose-face' });
        this.events = events;

        // the node pane holds elements, not instances
        (this.dom as any).bindNode = (op: PoseOp | null) => {
            this.op = op;
            this.listed = null;
            this.refresh();
        };

        const section = document.createElement('div');
        section.className = 'tf-section';
        const head = document.createElement('div');
        head.className = 'tf-heading';
        head.textContent = i18n.t('pose.heading');
        section.appendChild(head);
        this.dom.appendChild(section);

        this.sourceLabel = document.createElement('div');
        this.sourceLabel.className = 'tf-source';
        section.appendChild(this.sourceLabel);

        const field = (label: string, input: HTMLElement, hint?: string) => {
            const row = document.createElement('label');
            row.className = 'tf-field';
            if (hint) row.title = hint;
            const text = document.createElement('span');
            text.textContent = label;
            row.appendChild(text);
            row.appendChild(input);
            section.appendChild(row);
            return row;
        };
        const setOptions = (options: Partial<PoseOptions>) => {
            if (this.op) this.events.fire('pose.setOptions', this.op, options);
        };

        // sequential suits video and walk-throughs, exhaustive loose photos
        this.matcher = document.createElement('select');
        (['sequential', 'exhaustive'] as PoseMatcher[]).forEach((value) => {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = i18n.t(`pose.matcher-${value}`);
            this.matcher.appendChild(option);
        });
        this.matcher.addEventListener('keydown', e => e.stopPropagation());
        this.matcher.addEventListener('change', () => {
            if (!this.op) return;
            this.op.matcher = this.matcher.value as PoseMatcher;
            this.events.fire('edit.changed');
            this.refresh();
        });
        field(i18n.t('pose.matcher'), this.matcher);

        this.overlap = document.createElement('input');
        this.overlap.type = 'number';
        this.overlap.min = '1';
        this.overlap.max = '200';
        this.overlap.step = '1';
        this.overlap.addEventListener('keydown', e => e.stopPropagation());
        this.overlap.addEventListener('change', () => setOptions({ overlap: Number(this.overlap.value) }));
        this.overlapRow = field(i18n.t('pose.overlap'), this.overlap, i18n.t('pose.overlap-hint'));

        this.cameraModel = document.createElement('select');
        POSE_CAMERA_MODELS.forEach((model) => {
            const option = document.createElement('option');
            option.value = model;
            option.textContent = i18n.t(`pose.model-${model.toLowerCase().replace('_', '-')}`);
            this.cameraModel.appendChild(option);
        });
        this.cameraModel.addEventListener('keydown', e => e.stopPropagation());
        this.cameraModel.addEventListener('change', () => setOptions({ cameraModel: this.cameraModel.value as PoseOptions['cameraModel'] }));
        field(i18n.t('pose.camera-model'), this.cameraModel, i18n.t('pose.browser-camera'));

        this.sharedCamera = document.createElement('input');
        this.sharedCamera.type = 'checkbox';
        this.sharedCamera.style.width = 'auto';
        this.sharedCamera.addEventListener('change', () => setOptions({ sharedCamera: this.sharedCamera.checked }));
        field(i18n.t('pose.shared-camera'), this.sharedCamera, i18n.t('pose.shared-camera-hint'));

        const presets = document.createElement('datalist');
        presets.id = 'pose-face-features';
        FEATURE_PRESETS.forEach((n) => {
            const option = document.createElement('option');
            option.value = String(n);
            presets.appendChild(option);
        });
        section.appendChild(presets);
        this.maxFeatures = document.createElement('input');
        this.maxFeatures.type = 'number';
        this.maxFeatures.min = '256';
        this.maxFeatures.max = '65536';
        this.maxFeatures.step = '256';
        this.maxFeatures.setAttribute('list', presets.id);
        this.maxFeatures.addEventListener('keydown', e => e.stopPropagation());
        this.maxFeatures.addEventListener('change', () => setOptions({ maxFeatures: Number(this.maxFeatures.value) }));
        field(i18n.t('pose.max-features'), this.maxFeatures, i18n.t('pose.max-features-hint'));

        const note = document.createElement('div');
        note.className = 'tf-source pf-note';
        note.textContent = i18n.t('pose.browser-camera');
        section.appendChild(note);

        this.shown = document.createElement('input');
        this.shown.type = 'checkbox';
        this.shown.style.width = 'auto';
        this.shown.addEventListener('change', () => {
            if (this.op) this.events.fire('pose.setShown', this.op, this.shown.checked);
        });
        field(i18n.t('pose.show-cameras'), this.shown);

        const row = document.createElement('div');
        row.className = 'tf-row';
        section.appendChild(row);
        const button = (label: string, action: () => void) => {
            const el = document.createElement('button');
            el.className = 'tf-button';
            el.type = 'button';
            el.textContent = label;
            el.addEventListener('click', action);
            row.appendChild(el);
            return el;
        };
        this.runButton = button(i18n.t('pose.run'), () => {
            if (this.op) this.events.fire('pose.run', this.op);
        });
        this.cancelButton = button(i18n.t('pose.cancel'), () => {
            if (this.op) this.events.fire('pose.cancel', this.op);
        });

        this.staleLine = document.createElement('div');
        this.staleLine.className = 'tf-notice';
        this.staleLine.textContent = i18n.t('pose.stale');
        this.staleLine.hidden = true;
        section.appendChild(this.staleLine);

        this.statusLine = document.createElement('div');
        this.statusLine.className = 'tf-source pf-status';
        section.appendChild(this.statusLine);

        // the newest line of COLMAP's log while it maps
        this.logLine = document.createElement('div');
        this.logLine.className = 'tf-log';
        this.logLine.hidden = true;
        section.appendChild(this.logLine);

        this.countLine = document.createElement('div');
        this.countLine.className = 'tf-stats';
        this.countLine.title = i18n.t('pose.report-hint');
        section.appendChild(this.countLine);

        this.missingList = document.createElement('div');
        this.missingList.className = 'pf-missing';
        section.appendChild(this.missingList);
        this.missingThumb = document.createElement('canvas');
        this.missingThumb.className = 'pf-thumb';
        this.missingThumb.hidden = true;
        section.appendChild(this.missingThumb);

        events.on('dataset.statusChanged', (op: unknown) => {
            if (op === this.op || op === this.op?.datasetOp) this.refresh();
        });
        events.on('pose.changed', (op: PoseOp) => {
            if (op === this.op) this.refresh();
        });
    }

    /** An image it could not place: its thumbnail here, and marked on its import node. */
    private showMissing(name: string, link: HTMLElement) {
        const op = this.op;
        if (!op) return;
        this.missingList.querySelectorAll('.pf-picked').forEach(el => el.classList.remove('pf-picked'));
        link.classList.add('pf-picked');
        const root = importOf(op.datasetOp);
        if (root) this.events.fire('import.highlight', root, name);
        const image = op.images?.find(i => i.name === name);
        if (!image) {
            this.missingThumb.hidden = true;
            return;
        }
        analysisOf(image.data).then(({ thumb }) => {
            if (!link.classList.contains('pf-picked')) return;
            this.missingThumb.width = thumb.width;
            this.missingThumb.height = thumb.height;
            this.missingThumb.getContext('2d').drawImage(thumb, 0, 0);
            this.missingThumb.hidden = false;
        }).catch(() => {
            this.missingThumb.hidden = true;
        });
    }

    private refreshReport(op: PoseOp) {
        const r = op.report;
        if (!op.source) {
            this.countLine.textContent = '';
        } else if (r) {
            const parts = [i18n.t('pose.registered', { registered: r.registered, total: r.total })];
            if (r.meanError !== undefined) parts.push(i18n.t('pose.mean-error', { error: r.meanError.toFixed(2) }));
            this.countLine.textContent = parts.join(' · ');
        } else {
            this.countLine.textContent = i18n.t('pose.posed-count', { posed: op.cameras.length, total: op.total || op.cameras.length });
        }

        const missing = op.source ? r?.unregistered ?? [] : [];
        const key = missing.join('\n');
        if (key === this.listed) return;
        this.listed = key;
        this.missingList.textContent = '';
        this.missingThumb.hidden = true;
        if (!missing.length) return;
        const head = document.createElement('div');
        head.className = 'tf-source';
        head.textContent = i18n.t('pose.unregistered', { count: missing.length });
        this.missingList.appendChild(head);
        missing.forEach((name) => {
            const link = document.createElement('button');
            link.type = 'button';
            link.className = 'pf-name';
            link.textContent = name;
            link.title = i18n.t('pose.unregistered-hint');
            link.addEventListener('click', () => this.showMissing(name, link));
            this.missingList.appendChild(link);
        });
    }

    private refresh() {
        const op = this.op;
        if (!op) return;
        this.sourceLabel.textContent = op.datasetOp ? op.datasetOp.sourceLabel : i18n.t('pose.needs-import');
        this.matcher.value = op.matcher;
        const o = op.options;
        this.cameraModel.value = o.cameraModel;
        this.sharedCamera.checked = o.sharedCamera;
        if (document.activeElement !== this.maxFeatures) this.maxFeatures.value = String(o.maxFeatures);
        if (document.activeElement !== this.overlap) this.overlap.value = String(o.overlap);
        this.overlapRow.hidden = op.matcher !== 'sequential';
        this.shown.checked = op.showCameras;

        const running = poseJobRunning(op);
        this.runButton.disabled = !op.datasetOp || running;
        this.runButton.textContent = i18n.t(op.source ? 'pose.run-again' : 'pose.run');
        this.cancelButton.disabled = !running;
        // the cameras it has were found with other settings
        this.staleLine.hidden = running || !op.source || !op.madeWith || op.madeWith === op.settingsKey;

        this.statusLine.textContent = op.status ??
            (op.awaitingPoses ? i18n.t('training.awaiting-poses') :
                (op.source ? i18n.t('pose.ready') : (running ? '' : i18n.t('pose.idle'))));
        this.logLine.textContent = op.log ?? '';
        this.logLine.hidden = !op.log;
        this.refreshReport(op);
    }
}

export { PoseFace };
