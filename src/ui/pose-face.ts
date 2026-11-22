import { Container } from '@playcanvas/pcui';

import { i18n } from './localization';
import { PoseMatcher, PoseOp } from '../edit-ops';
import { Events } from '../events';
import { poseJobRunning } from '../training/bridge-ingest';

/**
 * The pose node's face, in the node pane: what it poses, the matcher,
 * how far the job is, how many images came out posed, and whether their
 * cameras are drawn.
 */
class PoseFace extends Container {
    private events: Events;
    private op: PoseOp | null = null;

    private sourceLabel: HTMLElement;
    private statusLine: HTMLElement;
    private countLine: HTMLElement;
    private matcher: HTMLSelectElement;
    private runButton: HTMLButtonElement;
    private cancelButton: HTMLButtonElement;
    private shown: HTMLInputElement;

    constructor(events: Events, args = {}) {
        super({ ...args, id: 'pose-face' });
        this.events = events;

        // the node pane holds elements, not instances
        (this.dom as any).bindNode = (op: PoseOp | null) => {
            this.op = op;
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

        const field = (label: string, input: HTMLElement) => {
            const row = document.createElement('label');
            row.className = 'tf-field';
            const text = document.createElement('span');
            text.textContent = label;
            row.appendChild(text);
            row.appendChild(input);
            section.appendChild(row);
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
        });
        field(i18n.t('pose.matcher'), this.matcher);

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

        this.statusLine = document.createElement('div');
        this.statusLine.className = 'tf-source';
        section.appendChild(this.statusLine);

        this.countLine = document.createElement('div');
        this.countLine.className = 'tf-stats';
        section.appendChild(this.countLine);

        events.on('dataset.statusChanged', (op: unknown) => {
            if (op === this.op || op === this.op?.datasetOp) this.refresh();
        });
        events.on('pose.changed', (op: PoseOp) => {
            if (op === this.op) this.refresh();
        });
    }

    private refresh() {
        const op = this.op;
        if (!op) return;
        this.sourceLabel.textContent = op.datasetOp ? op.datasetOp.sourceLabel : i18n.t('pose.needs-import');
        this.matcher.value = op.matcher;
        this.shown.checked = op.showCameras;

        const running = poseJobRunning(op);
        this.runButton.disabled = !op.datasetOp || running;
        this.runButton.textContent = i18n.t(op.source ? 'pose.run-again' : 'pose.run');
        this.cancelButton.disabled = !running;

        this.statusLine.textContent = op.status ??
            (op.awaitingPoses ? i18n.t('training.awaiting-poses') :
                (op.source ? i18n.t('pose.ready') : (running ? '' : i18n.t('pose.idle'))));
        this.countLine.textContent = op.source ?
            i18n.t('pose.posed-count', { posed: op.cameras.length, total: op.total || op.cameras.length }) :
            '';
    }
}

export { PoseFace };
