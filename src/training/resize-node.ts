import { BridgeImage } from './bridge-client';
import { isRawCapture } from './dataset-source';
import { DatasetOp, EditOp, PoseMatcher, ResizeOp, ResizeSettings } from '../edit-ops';
import { Events } from '../events';
import { i18n } from '../ui/localization';

/**
 * The resize nodes' work: shrinking the photos an import node holds before
 * they are posed. COLMAP in the browser registered none of 99 12 MP photos
 * where 20 smaller renders posed fine; a long edge of 1600 px is plenty
 * for both posing and training a capture of that kind.
 */

// photos with a longer edge than this get a resize node when imported
const AUTO_RESIZE_ABOVE = 2048;

// images shrunk at once: a 12 MP photo decodes to ~48 MB
const POOL = 2;

/**
 * Width and height from a JPEG's or PNG's header, without decoding the
 * image; null when the header does not say. EXIF orientation is left
 * out, which does not change the long edge.
 */
const headerSize = async (blob: Blob): Promise<[number, number] | null> => {
    const b = new Uint8Array(await blob.slice(0, 512 * 1024).arrayBuffer());
    if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
        const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
        return [v.getUint32(16), v.getUint32(20)];
    }
    if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
    let i = 2;
    while (i + 9 < b.length) {
        if (b[i] !== 0xff) return null;
        const marker = b[i + 1];
        if (marker === 0xff) {
            // fill byte
            i++;
            continue;
        }
        // markers with no length
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
            i += 2;
            continue;
        }
        const length = (b[i + 2] << 8) | b[i + 3];
        // the start-of-frame markers, not DHT (c4), JPG (c8) or DAC (cc)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return [(b[i + 7] << 8) | b[i + 8], (b[i + 5] << 8) | b[i + 6]];
        }
        i += 2 + length;
    }
    return null;
};

/** An image's size from its header, or from decoding it when that fails. */
const imageSize = async (blob: Blob): Promise<[number, number]> => {
    const size = await headerSize(blob);
    if (size) return size;
    const bitmap = await createImageBitmap(blob);
    const decoded: [number, number] = [bitmap.width, bitmap.height];
    bitmap.close();
    return decoded;
};

/** Is any of these photos larger than a resize node would let through? */
const needsResize = async (images: BridgeImage[], maxEdge = AUTO_RESIZE_ABOVE) => {
    for (const image of images) {
        try {
            const [w, h] = await imageSize(image.data);
            if (Math.max(w, h) > maxEdge) return true;
        } catch {
            // not an image the browser reads: posing will say so
        }
    }
    return false;
};

type Shrunk = { image: BridgeImage, from: [number, number], to: [number, number], resized: boolean };

/** One photo with its long edge brought down to `maxEdge`, as a JPEG. */
const shrink = async (image: BridgeImage, settings: ResizeSettings): Promise<Shrunk> => {
    const { maxEdge, quality } = settings;
    const header = await headerSize(image.data);
    if (header && Math.max(...header) <= maxEdge) {
        return { image, from: header, to: header, resized: false };
    }

    // decoded the way it is shown, EXIF orientation applied, so the JPEG
    // that comes out needs no orientation of its own
    const bitmap = await createImageBitmap(image.data);
    const w = bitmap.width;
    const h = bitmap.height;
    const long = Math.max(w, h);
    if (long <= maxEdge) {
        bitmap.close();
        return { image, from: [w, h], to: [w, h], resized: false };
    }
    const scale = maxEdge / long;
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));
    let small: ImageBitmap;
    try {
        small = await createImageBitmap(bitmap, { resizeWidth: tw, resizeHeight: th, resizeQuality: 'high' });
    } finally {
        bitmap.close();
    }
    const canvas = new OffscreenCanvas(tw, th);
    canvas.getContext('2d').drawImage(small, 0, 0);
    small.close();
    const data = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    return { image: { name: image.name, data }, from: [w, h], to: [tw, th], resized: true };
};

/** the size most of them have, as [w, h] */
const commonSize = (sizes: [number, number][]): [number, number] => {
    const tally = new Map<string, { size: [number, number], n: number }>();
    sizes.forEach((size) => {
        const key = `${size[0]}x${size[1]}`;
        const entry = tally.get(key) ?? { size, n: 0 };
        entry.n++;
        tally.set(key, entry);
    });
    let best: { size: [number, number], n: number } | null = null;
    tally.forEach((entry) => {
        if (!best || entry.n > best.n) best = entry;
    });
    return best?.size ?? [0, 0];
};

/**
 * A JPEG keeps its name; another format, now a JPEG, takes .jpg - unless
 * that name is taken.
 */
const jpegNames = (shrunk: Shrunk[]) => {
    const taken = new Set(shrunk.map(s => s.image.name.toLowerCase()));
    return shrunk.map((s) => {
        const name = s.image.name;
        if (!s.resized || /\.jpe?g$/i.test(name)) return s.image;
        const renamed = `${name.replace(/\.[^./]*$/, '')}.jpg`;
        if (taken.has(renamed.toLowerCase())) return s.image;
        taken.add(renamed.toLowerCase());
        return { name: renamed, data: s.image.data };
    });
};

const registerResizeNodes = (events: Events) => {
    // the newest run per node; an older one finishing changes nothing
    const generation = new WeakMap<ResizeOp, number>();

    const statusChanged = (op: ResizeOp) => {
        events.fire('dataset.statusChanged', op);
    };

    /** the output changed: the pose nodes it feeds start again */
    const handOn = (op: ResizeOp) => {
        events.fire('dataset.sourceChanged', op);
        events.fire('dataset.statusChanged', op);
        events.fire('edit.changed');
    };

    const run = async (op: ResizeOp) => {
        const input = op.datasetOp;
        const source = input?.source ?? null;
        const settings = { ...op.settings };
        const made = op.madeFrom;
        // the same input at the same settings: what it has stands
        if (made && made.source === source && made.maxEdge === settings.maxEdge && made.quality === settings.quality) return;

        const gen = (generation.get(op) ?? 0) + 1;
        generation.set(op, gen);
        const current = () => generation.get(op) === gen && op.datasetOp === input;

        op.status = undefined;
        op.summary = undefined;

        if (!source || !isRawCapture(source) || source.kind === 'video') {
            // nothing, a video, or a dataset with poses: handed on as it is
            op.source = source;
            op.madeFrom = source ? { source, ...settings } : null;
            if (source) op.summary = { images: 0, resized: 0, from: [0, 0], to: [0, 0], passed: isRawCapture(source) ? 'video' : 'dataset' };
            handOn(op);
            return;
        }

        // what it had is for another input: downstream stops using it
        op.source = null;
        op.madeFrom = null;
        const images = source.images;
        op.status = i18n.t('resize.progress', { done: 0, total: images.length });
        handOn(op);

        const out: Shrunk[] = new Array(images.length);
        let next = 0;
        let done = 0;
        let failed: unknown = null;
        const worker = async () => {
            while (next < images.length && !failed && current()) {
                const k = next++;
                try {
                    out[k] = await shrink(images[k], settings);
                } catch (error) {
                    failed = new Error(`${images[k].name}: ${(error as any)?.message ?? error}`);
                    return;
                }
                done++;
                if (current()) {
                    op.status = i18n.t('resize.progress', { done, total: images.length });
                    statusChanged(op);
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(POOL, images.length) }, worker));
        if (!current()) return;

        if (failed) {
            op.status = `${i18n.t('resize.failed')} — ${String((failed as any)?.message ?? failed).slice(0, 120)}`;
            statusChanged(op);
            events.fire('edit.changed');
            return;
        }

        // a pose node added with this one goes into history through the
        // edit queue: let it land before the news goes out
        await events.invoke('queue', () => {});
        if (!current()) return;

        op.source = { kind: 'images', images: jpegNames(out) };
        op.madeFrom = { source, ...settings };
        op.summary = {
            images: out.length,
            resized: out.filter(s => s.resized).length,
            from: commonSize(out.map(s => s.from)),
            to: commonSize(out.map(s => s.to))
        };
        op.status = undefined;
        handOn(op);
    };

    events.on('resize.run', (op: ResizeOp) => {
        if (op instanceof ResizeOp) run(op).catch(() => {});
    });

    events.on('resize.setSettings', (op: ResizeOp, settings: Partial<ResizeSettings>) => {
        if (!(op instanceof ResizeOp)) return;
        const maxEdge = Math.round(Number(settings.maxEdge ?? op.settings.maxEdge));
        const quality = Number(settings.quality ?? op.settings.quality);
        op.settings = {
            maxEdge: Number.isFinite(maxEdge) && maxEdge >= 64 ? Math.min(maxEdge, 16384) : op.settings.maxEdge,
            quality: Number.isFinite(quality) ? Math.min(1, Math.max(0.1, quality)) : op.settings.quality
        };
        events.fire('edit.changed');
        run(op).catch(() => {});
    });

    // an import node taking a new source: the resize nodes it feeds start again
    events.on('dataset.sourceChanged', (dataset: unknown) => {
        if (!(dataset instanceof DatasetOp)) return;
        const { ops } = (events.invoke('edit.history') ?? { ops: [] }) as { ops: EditOp[] };
        ops.forEach((op) => {
            if (op instanceof ResizeOp && op.datasetOp === dataset) run(op).catch(() => {});
        });
    });

    /**
     * Photos coming in get a pose node; when any is larger than
     * AUTO_RESIZE_ABOVE a resize node goes between, at the default cap.
     */
    events.function('pose.addNodeFor', async (dataset: DatasetOp, matcher: PoseMatcher = 'exhaustive') => {
        const source = dataset?.source;
        const big = isRawCapture(source) && source.kind === 'images' && await needsResize(source.images);
        const input = big ? events.invoke('resize.addNode', dataset) : dataset;
        return events.invoke('pose.addNode', input, matcher);
    });
};

export { headerSize, needsResize, registerResizeNodes };
