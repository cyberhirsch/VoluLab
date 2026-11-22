import { Container } from '@playcanvas/pcui';

import { i18n } from './localization';
import { CropOp, ImageCropSettings, ResizeBy, ResizeOp, ResizeSettings, resizeScale } from '../edit-ops';
import { Events } from '../events';

// long edges offered on the resolution field; any other can be typed
const EDGE_PRESETS = [1024, 1280, 1600, 2048, 2560, 3200, 4096];

type Kind = 'resize' | 'crop';

/** a number for a field: no trailing zeros, at most `digits` decimals */
const short = (v: number, digits: number) => String(Number(v.toFixed(digits)));

/**
 * An image node's face, in the node pane: what it works on, its settings,
 * and what it did. One face per kind.
 *
 * A resize node shows three linked fields - scale, long edge, megapixels.
 * Typing into one sets the size and the other two follow, worked out from
 * the first photo's size (the largest one's when they differ); only the
 * field typed into is kept, so the intent holds for other photos. A crop
 * node in 2d mode shows the margins.
 */
class ImageFace extends Container {
    private events: Events;
    private kind: Kind;
    private op: ResizeOp | CropOp | null = null;

    private sourceLabel: HTMLElement;
    private inputs = new Map<string, HTMLInputElement>();
    private linked = new Map<ResizeBy, HTMLInputElement>();
    private linkedNote: HTMLElement;
    private neverEnlarge: HTMLInputElement;
    private resample: HTMLSelectElement;
    private format: HTMLSelectElement;
    private qualityRow: HTMLElement;
    private quality: HTMLInputElement;
    private qualityValue: HTMLElement;
    private statusLine: HTMLElement;
    private summaryLine: HTMLElement;
    private section: HTMLElement;

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
        this.section = section;
        const head = document.createElement('div');
        head.className = 'tf-heading';
        head.textContent = i18n.t(`${key}.heading`);
        section.appendChild(head);
        this.dom.appendChild(section);

        this.sourceLabel = document.createElement('div');
        this.sourceLabel.className = 'tf-source';
        section.appendChild(this.sourceLabel);

        if (kind === 'crop') {
            this.buildCrop();
        } else {
            this.buildResize();
        }

        // the quality of the lossy formats, as a slider with its value
        const slider = document.createElement('span');
        slider.className = 'if-slider';
        this.quality = document.createElement('input');
        this.quality.type = 'range';
        this.quality.min = '0.1';
        this.quality.max = '1';
        this.quality.step = '0.01';
        this.quality.addEventListener('keydown', e => e.stopPropagation());
        this.quality.addEventListener('input', () => {
            this.qualityValue.textContent = `${Math.round(Number(this.quality.value) * 100)}`;
        });
        this.quality.addEventListener('change', () => {
            const v = Number(this.quality.value);
            if (this.op instanceof ResizeOp) this.events.fire('resize.setSettings', this.op, { quality: v });
            else if (this.op) this.events.fire('crop.setImageCrop', this.op, { quality: v });
            this.refresh();
        });
        this.qualityValue = document.createElement('span');
        this.qualityValue.className = 'if-slider-value';
        slider.appendChild(this.quality);
        slider.appendChild(this.qualityValue);
        this.qualityRow = this.field(i18n.t(kind === 'resize' ? 'resize.quality' : 'crop.quality'), slider);

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

    private field(label: string, input: HTMLElement) {
        const row = document.createElement('label');
        row.className = 'tf-field';
        const text = document.createElement('span');
        text.textContent = label;
        row.appendChild(text);
        row.appendChild(input);
        this.section.appendChild(row);
        return row;
    }

    private numberInput(name: string, min: number, max: number, step: number | 'any', apply: (v: number) => void) {
        const input = document.createElement('input');
        input.type = 'number';
        input.min = String(min);
        input.max = String(max);
        input.step = String(step);
        // the viewport's shortcuts stay out of typing
        input.addEventListener('keydown', e => e.stopPropagation());
        input.addEventListener('change', () => {
            const v = Number(input.value);
            if (this.op && input.value !== '' && Number.isFinite(v)) apply(v);
            this.refresh();
        });
        this.inputs.set(name, input);
        return input;
    }

    private select(options: [string, string][], apply: (v: string) => void) {
        const select = document.createElement('select');
        options.forEach(([value, label]) => {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            select.appendChild(option);
        });
        select.addEventListener('keydown', e => e.stopPropagation());
        select.addEventListener('change', () => {
            if (this.op) apply(select.value);
            this.refresh();
        });
        return select;
    }

    private buildResize() {
        const set = (settings: Partial<ResizeSettings>) => this.events.fire('resize.setSettings', this.op, settings);

        const presets = document.createElement('datalist');
        presets.id = 'resize-face-edges';
        EDGE_PRESETS.forEach((px) => {
            const option = document.createElement('option');
            option.value = String(px);
            presets.appendChild(option);
        });
        this.section.appendChild(presets);

        const linked = (by: ResizeBy, label: string, min: number, max: number, step: number | 'any') => {
            const input = this.numberInput(by, min, max, step, value => set({ by, value }));
            this.inputs.delete(by);
            this.linked.set(by, input);
            this.field(label, input);
            return input;
        };
        linked('percent', i18n.t('resize.percent'), 1, 400, 'any');
        linked('edge', i18n.t('resize.edge'), 16, 16384, 1).setAttribute('list', presets.id);
        linked('megapixels', i18n.t('resize.megapixels'), 0.01, 400, 'any');

        this.linkedNote = document.createElement('div');
        this.linkedNote.className = 'tf-source if-note';
        this.section.appendChild(this.linkedNote);

        this.neverEnlarge = document.createElement('input');
        this.neverEnlarge.type = 'checkbox';
        this.neverEnlarge.style.width = 'auto';
        this.neverEnlarge.addEventListener('change', () => {
            if (this.op) set({ neverEnlarge: this.neverEnlarge.checked });
            this.refresh();
        });
        this.field(i18n.t('resize.never-enlarge'), this.neverEnlarge);

        this.resample = this.select([
            ['high', i18n.t('resize.resample-high')],
            ['medium', i18n.t('resize.resample-medium')],
            ['low', i18n.t('resize.resample-low')]
        ], v => set({ resample: v as ResizeSettings['resample'] }));
        this.field(i18n.t('resize.resample'), this.resample);

        this.format = this.select([['jpeg', 'JPEG'], ['png', 'PNG'], ['webp', 'WebP']], v => set({ format: v as ResizeSettings['format'] }));
        this.field(i18n.t('resize.format'), this.format);
    }

    private buildCrop() {
        // the crop node's mode follows from where it sits: on a dataset
        // wire it crops photos; a crop of gaussians sits on an object
        const mode = this.select([['volume', i18n.t('crop.mode-volume')], ['2d', i18n.t('crop.mode-2d')]], () => {});
        Array.from(mode.options).forEach((option) => {
            option.disabled = option.value !== '2d';
        });
        mode.value = '2d';
        mode.title = i18n.t('crop.mode-hint');
        this.field(i18n.t('crop.mode'), mode);

        (['left', 'top', 'right', 'bottom'] as const).forEach((side) => {
            this.field(i18n.t(`crop.${side}`), this.numberInput(side, 0, 45, 0.5, (v) => {
                this.events.fire('crop.setImageCrop', this.op, { [side]: v } as Partial<ImageCropSettings>);
            }));
        });
    }

    /** the three linked fields: the one typed into as typed, the others worked out */
    private refreshLinked(op: ResizeOp) {
        const s = op.settings;
        const ref = op.reference;
        const scale = ref ? resizeScale(s, ref[0], ref[1]) : NaN;
        const values: Record<ResizeBy, string> = ref ? {
            percent: short(scale * 100, 1),
            edge: String(Math.round(Math.max(ref[0], ref[1]) * scale)),
            megapixels: short(ref[0] * ref[1] * scale * scale / 1e6, 2)
        } : { percent: '', edge: '', megapixels: '' };
        values[s.by] = String(s.value);
        this.linked.forEach((input, by) => {
            input.classList.toggle('if-entered', by === s.by);
            input.placeholder = '—';
            if (document.activeElement !== input) input.value = values[by];
        });

        let note = '';
        if (ref) {
            const [w, h] = ref;
            note = i18n.t('resize.reference', { size: `${w}×${h}` });
            const raw = s.by === 'percent' ? s.value / 100 :
                (s.by === 'edge' ? s.value / Math.max(w, h) : Math.sqrt(s.value * 1e6 / (w * h)));
            if (s.neverEnlarge && raw > 1) note += ` · ${i18n.t('resize.kept-size')}`;
        }
        this.linkedNote.textContent = note;
        this.linkedNote.hidden = !note;
        this.neverEnlarge.checked = s.neverEnlarge;
        this.resample.value = s.resample;
        this.format.value = s.format;
        this.qualityRow.hidden = s.format === 'png';
    }

    private refresh() {
        const op = this.op;
        if (!op) return;
        const key = this.kind === 'resize' ? 'resize' : 'crop';
        this.sourceLabel.textContent = op.datasetOp ? op.datasetOp.sourceLabel : i18n.t('resize.needs-import');
        const values: Record<string, number> = op instanceof ResizeOp ? {} : { ...op.imageCrop };
        this.inputs.forEach((input, name) => {
            if (document.activeElement !== input && values[name] !== undefined) input.value = String(values[name]);
        });
        if (op instanceof ResizeOp) this.refreshLinked(op);
        const quality = op instanceof ResizeOp ? op.settings.quality : op.imageCrop.quality;
        if (document.activeElement !== this.quality) this.quality.value = String(quality);
        this.qualityValue.textContent = `${Math.round(quality * 100)}`;

        const s = op.summary;
        this.statusLine.textContent = op.status ??
            (s?.passed ? i18n.t(`${key}.passed-${s.passed}`) : (op.source || !op.datasetOp ? '' : i18n.t(`${key}.idle`)));
        this.summaryLine.textContent = !s || s.passed ? '' :
            (s.resized ?
                i18n.t('resize.summary', { images: s.images, from: `${s.from[0]}×${s.from[1]}`, to: `${s.to[0]}×${s.to[1]}` }) +
                    (s.resized < s.images ? ` (${i18n.t('resize.kept', { count: s.images - s.resized })})` : '') :
                (op instanceof ResizeOp ?
                    i18n.t('resize.none', { images: s.images }) :
                    i18n.t('crop.none', { images: s.images })));
    }
}

export { ImageFace };
