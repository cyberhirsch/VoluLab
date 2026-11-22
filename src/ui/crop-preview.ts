import { ImageCropSettings, cropRect } from '../edit-ops';
import { imageSize } from '../training/image-nodes';

type Sides = { left: number, top: number, right: number, bottom: number };

// the largest share of the image a side's margin may take when dragged
const MAX_SIDE = 0.45;
// how near an edge of the rectangle a press grabs that edge, in css pixels
const GRAB = 7;
const BOX_W = 240;
const BOX_H = 180;

/**
 * The 2d crop node's preview: the first photo, small, with the crop drawn
 * over it. The margins' rectangle can be dragged to move it, and its
 * edges and corners to resize it; the aspect then cuts what is kept down
 * to its shape, centred, as the node will. A drag changes the node only
 * when it ends, so the photos are cropped once per drag.
 *
 * The photo is decoded at a small size only; its full size, which pixel
 * margins need, comes from its header.
 */
class CropPreview {
    dom: HTMLElement;
    private canvas: HTMLCanvasElement;
    private onCommit: (sides: Partial<ImageCropSettings>) => void;
    private blob: Blob | null = null;
    private thumb: ImageBitmap | null = null;
    /** the photo's full size, oriented as it is seen */
    private dims: [number, number] | null = null;
    private settings: ImageCropSettings | null = null;
    /** the margins while a drag goes on, as shares of the photo */
    private draft: Sides | null = null;
    private loading = 0;

    constructor(onCommit: (sides: Partial<ImageCropSettings>) => void) {
        this.onCommit = onCommit;
        this.dom = document.createElement('div');
        this.dom.className = 'if-preview';
        this.dom.hidden = true;
        this.canvas = document.createElement('canvas');
        this.canvas.width = BOX_W;
        this.canvas.height = BOX_H;
        this.dom.appendChild(this.canvas);
        this.listen();
    }

    /** the full size of the photo shown, once known */
    get size() {
        return this.dims;
    }

    /** Show this photo with this crop; a new photo is decoded, small. */
    show(blob: Blob | null, settings: ImageCropSettings) {
        this.settings = settings;
        if (blob !== this.blob) {
            this.blob = blob;
            this.thumb?.close();
            this.thumb = null;
            this.dims = null;
            if (blob) this.load(blob).catch(() => {});
        }
        this.dom.hidden = !blob;
        this.draw();
    }

    private async load(blob: Blob) {
        const ticket = ++this.loading;
        const [thumb, header] = await Promise.all([
            createImageBitmap(blob, { resizeHeight: BOX_H, resizeQuality: 'medium' }),
            imageSize(blob)
        ]);
        if (ticket !== this.loading) {
            thumb.close();
            return;
        }
        // the header is the stored orientation; the decode applies EXIF
        const swap = (thumb.width > thumb.height) !== (header[0] > header[1]);
        this.dims = swap ? [header[1], header[0]] : header;
        this.thumb = thumb;
        const scale = Math.min(BOX_W / thumb.width, BOX_H / thumb.height, 1);
        this.canvas.width = Math.max(1, Math.round(thumb.width * scale));
        this.canvas.height = Math.max(1, Math.round(thumb.height * scale));
        this.draw();
    }

    /** the margins of `s` as shares of the photo */
    sidesOf(s: ImageCropSettings): Sides {
        if (s.unit === '%') return { left: s.left / 100, top: s.top / 100, right: s.right / 100, bottom: s.bottom / 100 };
        const [w, h] = this.dims ?? [1, 1];
        return { left: s.left / w, top: s.top / h, right: s.right / w, bottom: s.bottom / h };
    }

    /** shares of the photo as margins in `unit` */
    valuesOf(sides: Sides, unit: '%' | 'px'): Sides {
        if (unit === '%') {
            const pc = (v: number) => Math.round(v * 1000) / 10;
            return { left: pc(sides.left), top: pc(sides.top), right: pc(sides.right), bottom: pc(sides.bottom) };
        }
        const [w, h] = this.dims ?? [1, 1];
        return { left: Math.round(sides.left * w), top: Math.round(sides.top * h), right: Math.round(sides.right * w), bottom: Math.round(sides.bottom * h) };
    }

    /** the margins' rectangle on the canvas, in canvas pixels */
    private rectOf(sides: Sides) {
        const { width: cw, height: ch } = this.canvas;
        return { x0: sides.left * cw, y0: sides.top * ch, x1: cw - sides.right * cw, y1: ch - sides.bottom * ch };
    }

    private draw() {
        const ctx = this.canvas.getContext('2d');
        const { width: cw, height: ch } = this.canvas;
        ctx.clearRect(0, 0, cw, ch);
        if (!this.thumb || !this.settings || !this.dims) return;
        ctx.drawImage(this.thumb, 0, 0, cw, ch);

        const sides = this.draft ?? this.sidesOf(this.settings);
        const [w, h] = this.dims;
        // what the node keeps: the margins, then the aspect
        const kept = cropRect({ ...this.settings, unit: '%', ...this.valuesOf(sides, '%') }, w, h);
        const kx = kept[0] / w * cw;
        const ky = kept[1] / h * ch;
        const kw = kept[2] / w * cw;
        const kh = kept[3] / h * ch;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.fillRect(0, 0, cw, ky);
        ctx.fillRect(0, ky + kh, cw, ch - ky - kh);
        ctx.fillRect(0, ky, kx, kh);
        ctx.fillRect(kx + kw, ky, cw - kx - kw, kh);

        const r = this.rectOf(sides);
        ctx.lineWidth = 1;
        if (this.settings.aspect !== 'free') {
            // the margins' rectangle, which is what a drag moves
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
            ctx.setLineDash([3, 3]);
            ctx.strokeRect(r.x0 + 0.5, r.y0 + 0.5, r.x1 - r.x0 - 1, r.y1 - r.y0 - 1);
            ctx.setLineDash([]);
        }
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
        ctx.strokeRect(kx + 0.5, ky + 0.5, kw - 1, kh - 1);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
        [[r.x0, r.y0], [r.x1, r.y0], [r.x0, r.y1], [r.x1, r.y1]].forEach(([x, y]) => ctx.fillRect(x - 2.5, y - 2.5, 5, 5));
    }

    /** which edges a point grabs, or 'move' inside, or null */
    private grab(x: number, y: number) {
        if (!this.settings) return null;
        const r = this.rectOf(this.sidesOf(this.settings));
        const near = (a: number, b: number) => Math.abs(a - b) <= GRAB;
        const inY = y >= r.y0 - GRAB && y <= r.y1 + GRAB;
        const inX = x >= r.x0 - GRAB && x <= r.x1 + GRAB;
        const edges = {
            left: inY && near(x, r.x0),
            right: inY && near(x, r.x1),
            top: inX && near(y, r.y0),
            bottom: inX && near(y, r.y1)
        };
        if (edges.left || edges.right || edges.top || edges.bottom) return edges;
        if (x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1) return 'move';
        return null;
    }

    private listen() {
        const canvas = this.canvas;
        const at = (e: PointerEvent) => {
            const b = canvas.getBoundingClientRect();
            return [(e.clientX - b.left) * canvas.width / (b.width || 1), (e.clientY - b.top) * canvas.height / (b.height || 1)];
        };
        const cursorOf = (g: ReturnType<CropPreview['grab']>) => {
            if (!g) return 'default';
            if (g === 'move') return 'move';
            if ((g.left && g.top) || (g.right && g.bottom)) return 'nwse-resize';
            if ((g.right && g.top) || (g.left && g.bottom)) return 'nesw-resize';
            return g.left || g.right ? 'ew-resize' : 'ns-resize';
        };

        let drag: { grab: Exclude<ReturnType<CropPreview['grab']>, null>, from: [number, number], start: Sides } | null = null;

        canvas.addEventListener('pointerdown', (e) => {
            if (!this.settings || !this.dims) return;
            const [x, y] = at(e);
            const g = this.grab(x, y);
            if (!g) return;
            e.preventDefault();
            e.stopPropagation();
            canvas.setPointerCapture(e.pointerId);
            drag = { grab: g, from: [x, y], start: this.sidesOf(this.settings) };
            this.draft = { ...drag.start };
        });

        canvas.addEventListener('pointermove', (e) => {
            const [x, y] = at(e);
            if (!drag) {
                canvas.style.cursor = cursorOf(this.grab(x, y));
                return;
            }
            const dx = (x - drag.from[0]) / canvas.width;
            const dy = (y - drag.from[1]) / canvas.height;
            const s = { ...drag.start };
            const clamp = (v: number) => Math.min(MAX_SIDE, Math.max(0, v));
            if (drag.grab === 'move') {
                // the rectangle keeps its size: each way, as far as both margins allow
                const mx = Math.min(Math.max(dx, -s.left, s.right - MAX_SIDE), s.right, MAX_SIDE - s.left);
                const my = Math.min(Math.max(dy, -s.top, s.bottom - MAX_SIDE), s.bottom, MAX_SIDE - s.top);
                s.left += mx;
                s.right -= mx;
                s.top += my;
                s.bottom -= my;
            } else {
                if (drag.grab.left) s.left = clamp(s.left + dx);
                if (drag.grab.right) s.right = clamp(s.right - dx);
                if (drag.grab.top) s.top = clamp(s.top + dy);
                if (drag.grab.bottom) s.bottom = clamp(s.bottom - dy);
            }
            this.draft = s;
            this.draw();
        });

        const end = (e: PointerEvent) => {
            if (!drag) return;
            if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
            const sides = this.draft;
            drag = null;
            this.draft = null;
            if (sides && this.settings) this.onCommit(this.valuesOf(sides, this.settings.unit));
            this.draw();
        };
        canvas.addEventListener('pointerup', end);
        canvas.addEventListener('pointercancel', end);
    }
}

export { CropPreview };
