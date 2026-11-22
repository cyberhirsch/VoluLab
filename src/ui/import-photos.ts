import { i18n } from './localization';
import { DatasetOp, ImportSubset } from '../edit-ops';
import { Events } from '../events';
import { cachedSize } from '../training/image-nodes';
import { analysisOf } from '../training/import-subset';

type Photo = { name: string, data: Blob };

/** '3060×4080' or '3060×4080 ×97 · 4080×3060 ×2', most common first */
const describeSizes = (sizes: [number, number][]) => {
    const tally = new Map<string, number>();
    sizes.forEach(([w, h]) => tally.set(`${w}×${h}`, (tally.get(`${w}×${h}`) ?? 0) + 1));
    const sorted = [...tally].sort((a, b) => b[1] - a[1]);
    if (sorted.length === 1) return sorted[0][0];
    const shown = sorted.slice(0, 3).map(([size, n]) => `${size} ×${n}`);
    return sorted.length > 3 ? `${shown.join(' · ')} · …` : shown.join(' · ');
};

const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * The import node's photos, under its pickers: what it holds (how many,
 * at what sizes, how many megabytes), which of them it hands on (every
 * Nth, a range, less the blurriest share) or a video's frame rate, and a
 * grid of thumbnails with the ones left out dimmed.
 *
 * The thumbnails are made only as they scroll into view, at about 96 px
 * high, and nothing holds a full-size decode (import-subset.ts).
 */
class ImportPhotos {
    dom: HTMLElement;
    private events: Events;
    private op: DatasetOp | null = null;
    private infoLine: HTMLElement;
    private keptLine: HTMLElement;
    private photoFields: HTMLElement;
    private videoFields: HTMLElement;
    private inputs = new Map<keyof ImportSubset, HTMLInputElement>();
    private grid: HTMLElement;
    private observer: IntersectionObserver;
    /** what the grid and the info line are of */
    private shownFor: unknown = null;
    private cells: HTMLElement[] = [];

    constructor(events: Events) {
        this.events = events;
        this.dom = document.createElement('div');
        this.dom.className = 'tf-section';
        this.dom.hidden = true;

        const head = document.createElement('div');
        head.className = 'tf-heading';
        head.textContent = i18n.t('import.photos');
        this.dom.appendChild(head);

        this.infoLine = document.createElement('div');
        this.infoLine.className = 'tf-source';
        this.dom.appendChild(this.infoLine);

        this.photoFields = document.createElement('div');
        this.dom.appendChild(this.photoFields);
        this.videoFields = document.createElement('div');
        this.dom.appendChild(this.videoFields);

        const field = (into: HTMLElement, key: keyof ImportSubset, label: string, min: number, max: number, step: number, hint: string) => {
            const row = document.createElement('label');
            row.className = 'tf-field';
            row.title = hint;
            const text = document.createElement('span');
            text.textContent = label;
            const input = document.createElement('input');
            input.type = 'number';
            input.min = String(min);
            input.max = String(max);
            input.step = String(step);
            input.addEventListener('keydown', e => e.stopPropagation());
            input.addEventListener('change', () => {
                if (this.op && input.value !== '') this.events.fire('import.setSubset', this.op, { [key]: Number(input.value) });
                this.refresh();
            });
            row.appendChild(text);
            row.appendChild(input);
            into.appendChild(row);
            this.inputs.set(key, input);
        };
        field(this.photoFields, 'every', i18n.t('import.every'), 1, 1000, 1, i18n.t('import.every-hint'));
        field(this.photoFields, 'from', i18n.t('import.from'), 1, 1e6, 1, i18n.t('import.range-hint'));
        field(this.photoFields, 'to', i18n.t('import.to'), 0, 1e6, 1, i18n.t('import.range-hint'));
        field(this.photoFields, 'dropBlurry', i18n.t('import.drop-blurry'), 0, 90, 1, i18n.t('import.drop-blurry-hint'));
        field(this.videoFields, 'fps', i18n.t('import.fps'), 0.1, 30, 0.5, i18n.t('import.fps-hint'));

        this.keptLine = document.createElement('div');
        this.keptLine.className = 'tf-stats';
        this.dom.appendChild(this.keptLine);

        this.grid = document.createElement('div');
        this.grid.className = 'ip-grid';
        this.dom.appendChild(this.grid);

        // a thumbnail is made when its cell comes into view
        this.observer = new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
                if (!entry.isIntersecting) return;
                this.observer.unobserve(entry.target);
                this.fill(entry.target as HTMLElement);
            });
        }, { root: this.grid, rootMargin: '64px' });
    }

    bind(op: DatasetOp | null) {
        this.op = op;
        this.refresh();
    }

    private photos(): Photo[] | null {
        const original = this.op?.original as { kind?: string, images?: Photo[] } | null;
        return original?.kind === 'images' && original.images ? original.images : null;
    }

    private fill(cell: HTMLElement) {
        const photos = this.photos();
        const k = Number(cell.dataset.place);
        const photo = photos?.[k];
        if (!photo) return;
        analysisOf(photo.data).then(({ thumb, sharpness }) => {
            if (this.cells[k] !== cell) return;
            const canvas = cell.querySelector('canvas');
            canvas.width = thumb.width;
            canvas.height = thumb.height;
            canvas.getContext('2d').drawImage(thumb, 0, 0);
            cell.title = `${photo.name}\n${megabytes(photo.data.size)} · ${i18n.t('import.sharpness')} ${Math.round(sharpness)}`;
        }).catch(() => {
            cell.classList.add('ip-failed');
        });
    }

    /** the grid and the info line, once per import */
    private build(photos: Photo[]) {
        this.observer.disconnect();
        this.grid.textContent = '';
        this.cells = photos.map((photo, k) => {
            const cell = document.createElement('div');
            cell.className = 'ip-cell';
            cell.dataset.place = String(k);
            cell.title = photo.name;
            const canvas = document.createElement('canvas');
            canvas.width = 72;
            canvas.height = 96;
            cell.appendChild(canvas);
            this.grid.appendChild(cell);
            this.observer.observe(cell);
            return cell;
        });

        const total = photos.reduce((sum, p) => sum + p.data.size, 0);
        this.infoLine.textContent = `${i18n.t('import.count-images')}: ${photos.length} · ${megabytes(total)}`;
        const of = this.shownFor;
        Promise.all(photos.map(p => cachedSize(p.data).catch((): [number, number] => [0, 0]))).then((sizes) => {
            if (this.shownFor !== of) return;
            const known = sizes.filter(s => s[0] > 0);
            this.infoLine.textContent = `${i18n.t('import.count-images')}: ${photos.length} · ${known.length ? describeSizes(known) : '?'} · ${megabytes(total)}`;
        }).catch(() => {});
    }

    /** Highlight the photo of this name, as the pose node names it. */
    highlight(name: string) {
        const photos = this.photos();
        const base = (n: string) => n.split('/').pop().toLowerCase();
        const k = photos?.findIndex(p => base(p.name) === base(name) || p.name.replace(/\//g, '_').toLowerCase() === name.toLowerCase()) ?? -1;
        this.cells.forEach((cell, i) => cell.classList.toggle('ip-highlight', i === k));
        this.cells[k]?.scrollIntoView({ block: 'nearest' });
    }

    refresh() {
        const op = this.op;
        const original = op?.original as { kind?: string } | null;
        const photos = this.photos();
        const video = original?.kind === 'video';
        this.dom.hidden = !photos && !video;
        if (!op || this.dom.hidden) {
            this.shownFor = null;
            return;
        }

        this.photoFields.hidden = !photos;
        this.videoFields.hidden = !video;
        this.grid.hidden = !photos;
        const s = op.subset;
        this.inputs.forEach((input, key) => {
            if (document.activeElement !== input) input.value = String(s[key]);
        });

        if (video) {
            this.shownFor = original;
            this.infoLine.textContent = `${(original as { file?: File }).file?.name ?? ''} · ${megabytes((original as { file?: File }).file?.size ?? 0)}`;
            this.keptLine.textContent = '';
            return;
        }

        if (this.shownFor !== original) {
            this.shownFor = original;
            this.build(photos);
        }
        const kept = op.kept ? new Set(op.kept) : null;
        this.cells.forEach((cell, k) => cell.classList.toggle('ip-dropped', !!kept && !kept.has(k)));
        this.keptLine.textContent = op.source ? i18n.t('import.kept', { kept: kept ? kept.size : photos.length, total: photos.length }) : '';
    }
}

export { ImportPhotos };
