import { Container } from '@playcanvas/pcui';

import { i18n } from './localization';
import { CropOp, ImageCropSettings, ResizeOp } from '../edit-ops';
import { Events } from '../events';

const PRESETS = [1024, 1600, 2048, 3200];

type Kind = 'resize' | 'crop';

/**
 * An image node's face, in the node pane: what it works on, its settings
 * (the cap on the long edge for a resize node; the margins for a crop node
 * in 2d mode), the JPEG quality, and what it did. One face per kind.
 */
class ImageFace extends Container {
    private events: Events;
    private kind: Kind;
    private op: ResizeOp | CropOp | null = null;

    private sourceLabel: HTMLElement;
    private inputs = new Map<string, HTMLInputElement>();
    private statusLine: HTMLElement;
    private summaryLine: HTMLElement;

    constructor(events: Events, kind: Kind, args = {}) {
        super({ ...args, id: `${kind}-image-face` });
        this.events = events;
        this.kind = kind;
        const key = kind === 'resize' ? 'resize' : 'crop';

        // the node pane holds elements, not instances
        (this.dom as any).bindNode = (op: ResizeOp | CropOp | null) => {
            this.op = op;
            this.refresh();
        };

        const section = document.createElement('div');
        section.className = 'tf-section';
        const head = document.createElement('div');
        head.className = 'tf-heading';
        head.textContent = i18n.t(`${key}.heading`);
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

        const numberInput = (name: string, min: number, max: number, step: number, apply: (v: number) => void) => {
            const input = document.createElement('input');
            input.type = 'number';
            input.min = String(min);
            input.max = String(max);
            input.step = String(step);
            // the viewport's shortcuts stay out of typing
            input.addEventListener('keydown', e => e.stopPropagation());
            input.addEventListener('change', () => {
                if (this.op) apply(Number(input.value));
                this.refresh();
            });
            this.inputs.set(name, input);
            return input;
        };

        if (kind === 'crop') {
            // the crop node's mode follows from where it sits: on a dataset
            // wire it crops photos; a crop of gaussians sits on an object
            const mode = document.createElement('select');
            [['volume', i18n.t('crop.mode-volume')], ['2d', i18n.t('crop.mode-2d')]].forEach(([value, label]) => {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = label;
                option.disabled = value !== '2d';
                mode.appendChild(option);
            });
            mode.value = '2d';
            mode.title = i18n.t('crop.mode-hint');
            field(i18n.t('crop.mode'), mode);

            (['left', 'top', 'right', 'bottom'] as const).forEach((side) => {
                field(i18n.t(`crop.${side}`), numberInput(side, 0, 45, 0.5, (v) => {
                    this.events.fire('crop.setImageCrop', this.op, { [side]: v } as Partial<ImageCropSettings>);
                }));
            });
        } else {
            // the presets, and any size typed in
            const presets = document.createElement('datalist');
            presets.id = 'resize-face-presets';
            PRESETS.forEach((px) => {
                const option = document.createElement('option');
                option.value = String(px);
                presets.appendChild(option);
            });
            section.appendChild(presets);
            const maxEdge = numberInput('maxEdge', 64, 16384, 1, (v) => {
                this.events.fire('resize.setSettings', this.op, { maxEdge: v });
            });
            maxEdge.setAttribute('list', presets.id);
            field(i18n.t('resize.max-edge'), maxEdge);
        }

        field(i18n.t('resize.quality'), numberInput('quality', 0.1, 1, 0.01, (v) => {
            if (this.op instanceof ResizeOp) this.events.fire('resize.setSettings', this.op, { quality: v });
            else this.events.fire('crop.setImageCrop', this.op, { quality: v });
        }));

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
        const key = this.kind === 'resize' ? 'resize' : 'crop';
        this.sourceLabel.textContent = op.datasetOp ? op.datasetOp.sourceLabel : i18n.t('resize.needs-import');
        const values: Record<string, number> = op instanceof ResizeOp ? { ...op.settings } : { ...op.imageCrop };
        this.inputs.forEach((input, name) => {
            if (document.activeElement !== input) input.value = String(values[name]);
        });

        const s = op.summary;
        this.statusLine.textContent = op.status ??
            (s?.passed ? i18n.t(`${key}.passed-${s.passed}`) : (op.source || !op.datasetOp ? '' : i18n.t(`${key}.idle`)));
        this.summaryLine.textContent = !s || s.passed ? '' :
            (s.resized ?
                i18n.t('resize.summary', { images: s.images, from: `${s.from[0]}×${s.from[1]}`, to: `${s.to[0]}×${s.to[1]}` }) +
                    (s.resized < s.images ? ` (${i18n.t('resize.kept', { count: s.images - s.resized })})` : '') :
                (op instanceof ResizeOp ?
                    i18n.t('resize.none', { images: s.images, max: op.settings.maxEdge }) :
                    i18n.t('crop.none', { images: s.images })));
    }
}

export { ImageFace };
