import { BridgeImage } from './bridge-client';
import { isRawCapture } from './dataset-source';
import { CropOp, DatasetOp, EditOp, ImageCropSettings, PoseMatcher, ResizeOp, ResizeSettings, isDatasetInput, isImageNode } from '../edit-ops';
import { Events } from '../events';
import { i18n } from '../ui/localization';

/**
 * The image nodes' work: a resize node shrinking the photos an import node
 * holds, and a crop node in 2d mode cutting margins off them, before they
 * are posed. COLMAP in the browser registered none of 99 12 MP photos
 * where 20 smaller renders posed fine; a long edge of 1600 px is plenty
 * for both posing and training a capture of that kind.
 *
 * Both chain in any order (import → resize → crop → pose), and both hand
 * a video or a posed dataset on untouched.
 */

// photos with a longer edge than this get a resize node when imported
const AUTO_RESIZE_ABOVE = 2048;

// images done at once: a 12 MP photo decodes to ~48 MB
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

/**
 * Where an image's pixels came from: x = ax * X + bx, y = ay * Y + by,
 * with X, Y a pixel of the photo as imported. An image node's photos carry
 * one, so cameras found on one copy can be fitted to another
 * (train-inputs.ts). A photo without one is as imported.
 */
type Frame = { ax: number, bx: number, ay: number, by: number };

type FramedImage = BridgeImage & { frame?: Frame };

const IDENTITY: Frame = { ax: 1, bx: 0, ay: 1, by: 0 };

const frameOf = (image: BridgeImage): Frame => (image as FramedImage).frame ?? IDENTITY;

type Done = { image: FramedImage, from: [number, number], to: [number, number], changed: boolean };

const toJpeg = async (bitmap: ImageBitmap, quality: number) => {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    return await canvas.convertToBlob({ type: 'image/jpeg', quality });
};

/** One photo with its long edge brought down to `maxEdge`, as a JPEG. */
const shrink = async (image: BridgeImage, settings: ResizeSettings): Promise<Done> => {
    const { maxEdge, quality } = settings;
    const header = await headerSize(image.data);
    if (header && Math.max(...header) <= maxEdge) {
        return { image, from: header, to: header, changed: false };
    }

    // decoded the way it is shown, EXIF orientation applied, so the JPEG
    // that comes out needs no orientation of its own
    const bitmap = await createImageBitmap(image.data);
    const w = bitmap.width;
    const h = bitmap.height;
    const long = Math.max(w, h);
    if (long <= maxEdge) {
        bitmap.close();
        return { image, from: [w, h], to: [w, h], changed: false };
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
    const f = frameOf(image);
    const sx = tw / w;
    const sy = th / h;
    const frame = { ax: f.ax * sx, bx: f.bx * sx, ay: f.ay * sy, by: f.by * sy };
    try {
        return { image: { name: image.name, data: await toJpeg(small, quality), frame }, from: [w, h], to: [tw, th], changed: true };
    } finally {
        small.close();
    }
};

const cropsNothing = (c: ImageCropSettings) => !c.left && !c.top && !c.right && !c.bottom;

/** One photo with the same share of each side cut off, as a JPEG. */
const crop = async (image: BridgeImage, settings: ImageCropSettings): Promise<Done> => {
    if (cropsNothing(settings)) {
        const size = await imageSize(image.data);
        return { image, from: size, to: size, changed: false };
    }
    const bitmap = await createImageBitmap(image.data);
    const w = bitmap.width;
    const h = bitmap.height;
    const sx = Math.round(w * settings.left / 100);
    const sy = Math.round(h * settings.top / 100);
    const sw = Math.max(1, w - sx - Math.round(w * settings.right / 100));
    const sh = Math.max(1, h - sy - Math.round(h * settings.bottom / 100));
    let cut: ImageBitmap;
    try {
        cut = await createImageBitmap(bitmap, sx, sy, sw, sh);
    } finally {
        bitmap.close();
    }
    const f = frameOf(image);
    const frame = { ax: f.ax, bx: f.bx - sx, ay: f.ay, by: f.by - sy };
    try {
        return { image: { name: image.name, data: await toJpeg(cut, settings.quality), frame }, from: [w, h], to: [sw, sh], changed: true };
    } finally {
        cut.close();
    }
};

/** What a node does, and to what settings: an unchanged key keeps its result. */
const workOf = (op: ResizeOp | CropOp) => {
    if (op instanceof ResizeOp) {
        const settings = { ...op.settings };
        return { key: JSON.stringify(settings), each: (image: BridgeImage) => shrink(image, settings), progress: 'resize.progress', failed: 'resize.failed' };
    }
    const settings = { ...op.imageCrop };
    return { key: JSON.stringify(settings), each: (image: BridgeImage) => crop(image, settings), progress: 'crop.progress', failed: 'crop.failed' };
};

/** the key a node's result is cached against, for a project to put back */
const workKey = (op: ResizeOp | CropOp) => workOf(op).key;

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
const jpegNames = (done: Done[]) => {
    const taken = new Set(done.map(s => s.image.name.toLowerCase()));
    return done.map((s) => {
        const name = s.image.name;
        if (!s.changed || /\.jpe?g$/i.test(name)) return s.image;
        const renamed = `${name.replace(/\.[^./]*$/, '')}.jpg`;
        if (taken.has(renamed.toLowerCase())) return s.image;
        taken.add(renamed.toLowerCase());
        return { ...s.image, name: renamed };
    });
};

const registerImageNodes = (events: Events) => {
    // the newest run per node; an older one finishing changes nothing
    const generation = new WeakMap<object, number>();

    /** the output changed: the image and pose nodes it feeds start again */
    const handOn = (op: ResizeOp | CropOp) => {
        events.fire('dataset.sourceChanged', op);
        events.fire('dataset.statusChanged', op);
        events.fire('edit.changed');
    };

    const run = async (op: ResizeOp | CropOp) => {
        if (!isImageNode(op)) return;
        const input = op.datasetOp;
        const source = input?.source ?? null;
        const work = workOf(op);
        const made = op.madeFrom;
        // the same input at the same settings: what it has stands
        if (made && made.source === source && made.key === work.key) return;

        const gen = (generation.get(op) ?? 0) + 1;
        generation.set(op, gen);
        const current = () => generation.get(op) === gen && op.datasetOp === input;

        op.status = undefined;
        op.summary = undefined;

        if (!source || !isRawCapture(source) || source.kind === 'video') {
            // nothing, a video, or a dataset with poses: handed on as it is
            op.source = source;
            op.madeFrom = source ? { source, key: work.key } : null;
            if (source) op.summary = { images: 0, resized: 0, from: [0, 0], to: [0, 0], passed: isRawCapture(source) ? 'video' : 'dataset' };
            handOn(op);
            return;
        }

        // what it had is for another input: downstream stops using it
        op.source = null;
        op.madeFrom = null;
        const images = source.images;
        op.status = i18n.t(work.progress, { done: 0, total: images.length });
        handOn(op);

        const out: Done[] = new Array(images.length);
        let next = 0;
        let done = 0;
        let failed: unknown = null;
        const worker = async () => {
            while (next < images.length && !failed && current()) {
                const k = next++;
                try {
                    out[k] = await work.each(images[k]);
                } catch (error) {
                    failed = new Error(`${images[k].name}: ${(error as any)?.message ?? error}`);
                    return;
                }
                done++;
                if (current()) {
                    op.status = i18n.t(work.progress, { done, total: images.length });
                    events.fire('dataset.statusChanged', op);
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(POOL, images.length) }, worker));
        if (!current()) return;

        if (failed) {
            op.status = `${i18n.t(work.failed)} — ${String((failed as any)?.message ?? failed).slice(0, 120)}`;
            events.fire('dataset.statusChanged', op);
            events.fire('edit.changed');
            return;
        }

        // a pose node added with this one goes into history through the
        // edit queue: let it land before the news goes out
        await events.invoke('queue', () => {});
        if (!current()) return;

        op.source = { kind: 'images', images: jpegNames(out) };
        op.madeFrom = { source, key: work.key };
        op.summary = {
            images: out.length,
            resized: out.filter(s => s.changed).length,
            from: commonSize(out.map(s => s.from)),
            to: commonSize(out.map(s => s.to))
        };
        op.status = undefined;
        handOn(op);
    };

    events.on('image.run', (op: ResizeOp | CropOp) => {
        run(op).catch(() => {});
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

    events.on('crop.setImageCrop', (op: CropOp, settings: Partial<ImageCropSettings>) => {
        if (!(op instanceof CropOp) || op.mode !== '2d') return;
        const was = op.imageCrop;
        const side = (v: unknown, old: number) => {
            const n = Number(v ?? old);
            return Number.isFinite(n) ? Math.min(45, Math.max(0, n)) : old;
        };
        const quality = Number(settings.quality ?? was.quality);
        op.imageCrop = {
            left: side(settings.left, was.left),
            top: side(settings.top, was.top),
            right: side(settings.right, was.right),
            bottom: side(settings.bottom, was.bottom),
            quality: Number.isFinite(quality) ? Math.min(1, Math.max(0.1, quality)) : was.quality
        };
        events.fire('edit.changed');
        run(op).catch(() => {});
    });

    // an import or image node handing on something new: the image nodes
    // it feeds start again
    events.on('dataset.sourceChanged', (dataset: unknown) => {
        if (!isDatasetInput(dataset)) return;
        const { ops } = (events.invoke('edit.history') ?? { ops: [] }) as { ops: EditOp[] };
        ops.forEach((op) => {
            if (isImageNode(op) && op.datasetOp === dataset) run(op).catch(() => {});
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

export { frameOf, headerSize, imageSize, needsResize, registerImageNodes, workKey, type Frame, type FramedImage };
