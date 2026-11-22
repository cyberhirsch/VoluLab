import { Container } from '@playcanvas/pcui';

import { i18n } from './localization';
import { ResizeOp } from '../edit-ops';
import { Events } from '../events';

const PRESETS = [1024, 1600, 2048, 3200];

/**
 * The resize node's face, in the node pane: what it shrinks, the cap on
 * the long edge, the JPEG quality, and what it did.
 */
class ResizeFace extends Container {
    private events: Events;
    private op: ResizeOp | null = null;

    private sourceLabel: HTMLElement;
    private maxEdge: HTMLInputElement;
    private quality: HTMLInputElement;
    private statusLine: HTMLElement;
    private summaryLine: HTMLElement;

    constructor(events: Events, args = {}) {
        super({ ...args, id: 'resize-face' });
        this.events = events;

        // the node pane holds elements, not instances
        (this.dom as any).bindNode = (op: ResizeOp | null) => {
            this.op = op;
            this.refresh();
        };

        const section = document.createElement('div');
        section.className = 'tf-section';
        const head = document.createElement('div');
        head.className = 'tf-heading';
        head.textContent = i18n.t('resize.heading');
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

        const numberInput = (min: number, max: number, step: number) => {
            const input = document.createElement('input');
            input.type = 'number';
            input.min = String(min);
            input.max = String(max);
            input.step = String(step);
            // the viewport's shortcuts stay out of typing
            input.addEventListener('keydown', e => e.stopPropagation());
            return input;
        };

        // the presets, and any size typed in
        const presets = document.createElement('datalist');
        presets.id = 'resize-face-presets';
        PRESETS.forEach((px) => {
            const option = document.createElement('option');
            option.value = String(px);
            presets.appendChild(option);
        });
        section.appendChild(presets);
        this.maxEdge = numberInput(64, 16384, 1);
        this.maxEdge.setAttribute('list', presets.id);
        this.maxEdge.addEventListener('change', () => {
            if (this.op) this.events.fire('resize.setSettings', this.op, { maxEdge: Number(this.maxEdge.value) });
            this.refresh();
        });
        field(i18n.t('resize.max-edge'), this.maxEdge);

        this.quality = numberInput(0.1, 1, 0.01);
        this.quality.addEventListener('change', () => {
            if (this.op) this.events.fire('resize.setSettings', this.op, { quality: Number(this.quality.value) });
            this.refresh();
        });
        field(i18n.t('resize.quality'), this.quality);

        this.statusLine = document.createElement('div');
        this.statusLine.className = 'tf-source';
        section.appendChild(this.statusLine);

        this.summaryLine = document.createElement('div');
        this.summaryLine.className = 'tf-stats';
        section.appendChild(this.summaryLine);

        events.on('dataset.statusChanged', (op: unknown) => {
            if (op === this.op || op === this.op?.datasetOp) this.refresh();
        });
    }

    private refresh() {
        const op = this.op;
        if (!op) return;
        this.sourceLabel.textContent = op.datasetOp ? op.datasetOp.sourceLabel : i18n.t('resize.needs-import');
        if (document.activeElement !== this.maxEdge) this.maxEdge.value = String(op.settings.maxEdge);
        if (document.activeElement !== this.quality) this.quality.value = String(op.settings.quality);

        const s = op.summary;
        this.statusLine.textContent = op.status ??
            (s?.passed ? i18n.t(`resize.passed-${s.passed}`) : (op.source || !op.datasetOp ? '' : i18n.t('resize.idle')));
        this.summaryLine.textContent = !s || s.passed ? '' :
            (s.resized ?
                i18n.t('resize.summary', { images: s.images, from: `${s.from[0]}×${s.from[1]}`, to: `${s.to[0]}×${s.to[1]}` }) +
                    (s.resized < s.images ? ` (${i18n.t('resize.kept', { count: s.images - s.resized })})` : '') :
                i18n.t('resize.none', { images: s.images, max: op.settings.maxEdge }));
    }
}

export { ResizeFace };
