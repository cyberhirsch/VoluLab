import { BridgeImage } from './bridge-client';
import { isRawCapture } from './dataset-source';
import { CropOp, DatasetOp, EditOp, ImageCropSettings, PoseMatcher, ResizeFormat, ResizeOp, ResizeSettings, cropRect, imageCropFrom, isDatasetInput, isImageNode, resizeSettingsFrom, resizeTarget } from '../edit-ops';
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

const MIME: Record<ResizeFormat, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

/** A bitmap as an image file; PNG is lossless and takes no quality. */
const encode = async (bitmap: ImageBitmap, format: ResizeFormat, quality: number) => {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    return await canvas.convertToBlob(format === 'png' ? { type: MIME.png } : { type: MIME[format], quality });
};

const toJpeg = (bitmap: ImageBitmap, quality: number) => encode(bitmap, 'jpeg', quality);

/**
 * One photo at the size the settings give it, in their format. One that
 * comes out at its own size goes through as it is, read from its header
 * when it can be, so it is not even decoded.
 */
const shrink = async (image: BridgeImage, settings: ResizeSettings): Promise<Done> => {
    const header = await headerSize(image.data);
    if (header) {
        // EXIF orientation may swap the header's sides: the rule is the
        // same either way round
        const [tw, th] = resizeTarget(settings, header[0], header[1]);
        if (tw === header[0] && th === header[1]) return { image, from: header, to: header, changed: false };
    }

    // decoded the way it is shown, EXIF orientation applied, so the image
    // that comes out needs no orientation of its own
    const bitmap = await createImageBitmap(image.data);
    const w = bitmap.width;
    const h = bitmap.height;
    const [tw, th] = resizeTarget(settings, w, h);
    if (tw === w && th === h) {
        bitmap.close();
        return { image, from: [w, h], to: [w, h], changed: false };
    }
    let small: ImageBitmap;
    try {
        small = await createImageBitmap(bitmap, { resizeWidth: tw, resizeHeight: th, resizeQuality: settings.resample });
    } finally {
        bitmap.close();
    }
    const f = frameOf(image);
    const sx = tw / w;
    const sy = th / h;
    const frame = { ax: f.ax * sx, bx: f.bx * sx, ay: f.ay * sy, by: f.by * sy };
    try {
        return { image: { name: image.name, data: await encode(small, settings.format, settings.quality), frame }, from: [w, h], to: [tw, th], changed: true };
    } finally {
        small.close();
    }
};

const cropsNothing = (c: ImageCropSettings) => !c.left && !c.top && !c.right && !c.bottom && c.aspect === 'free';

/** One photo with its margins cut off and cut to the aspect, as a JPEG. */
const crop = async (image: BridgeImage, settings: ImageCropSettings): Promise<Done> => {
    if (cropsNothing(settings)) {
        const size = await imageSize(image.data);
        return { image, from: size, to: size, changed: false };
    }
    // decoded with EXIF orientation applied: the margins are the photo's
    // as it is seen
    const bitmap = await createImageBitmap(image.data);
    const w = bitmap.width;
    const h = bitmap.height;
    const [sx, sy, sw, sh] = cropRect(settings, w, h);
    if (sx === 0 && sy === 0 && sw === w && sh === h) {
        // already that aspect, no margins: as it is
        bitmap.close();
        return { image, from: [w, h], to: [w, h], changed: false };
    }
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
        return { key: `resize ${JSON.stringify(settings)}`, each: (image: BridgeImage) => shrink(image, settings), progress: 'resize.progress', failed: 'resize.failed' };
    }
    const settings = { ...op.imageCrop };
    return { key: `crop ${JSON.stringify(settings)}`, each: (image: BridgeImage) => crop(image, settings), progress: 'crop.progress', failed: 'crop.failed' };
};

/**
 * What each photo came out as, by the photo and the work's key: a subset
 * of the photos changing, or the settings going back to what they were,
 * does not do again what was done. A few keys per photo at most; the
 * entries go with the photo.
 */
const memo = new WeakMap<object, Map<string, Done>>();
const MEMO_KEYS = 2;

const remembered = (image: BridgeImage, key: string) => memo.get(image)?.get(key);

const remember = (image: BridgeImage, key: string, done: Done) => {
    let byKey = memo.get(image);
    if (!byKey) {
        byKey = new Map();
        memo.set(image, byKey);
    }
    byKey.delete(key);
    byKey.set(key, done);
    while (byKey.size > MEMO_KEYS) byKey.delete(byKey.keys().next().value);
};

// image sizes from their headers, by blob
const sizes = new WeakMap<Blob, Promise<[number, number]>>();
const cachedSize = (blob: Blob) => {
    let size = sizes.get(blob);
    if (!size) {
        size = imageSize(blob);
        sizes.set(blob, size);
        size.catch(() => sizes.delete(blob));
    }
    return size;
};

/**
 * The size a resize node's linked fields are worked out from: the first
 * photo's, or the largest one's when the photos differ in size.
 */
const referenceSize = async (images: BridgeImage[]): Promise<[number, number] | undefined> => {
    let first: [number, number] | undefined;
    let largest: [number, number] | undefined;
    let mixed = false;
    for (const image of images) {
        try {
            const size = await cachedSize(image.data);
            first ??= size;
            if (size[0] * size[1] !== first[0] * first[1] || Math.max(...size) !== Math.max(...first)) mixed = true;
            if (!largest || size[0] * size[1] > largest[0] * largest[1]) largest = size;
        } catch {
            // not an image the browser reads: the work will say so
        }
    }
    return mixed ? largest : first;
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

// the extension an image file of this type takes, and the ones it may have
const EXTENSIONS: Record<string, { ext: string, re: RegExp }> = {
    'image/jpeg': { ext: '.jpg', re: /\.jpe?g$/i },
    'image/png': { ext: '.png', re: /\.png$/i },
    'image/webp': { ext: '.webp', re: /\.webp$/i }
};

/**
 * An image made keeps its name when the extension fits its format, and
 * takes the format's extension when it does not (a PNG now a JPEG takes
 * .jpg) - unless that name is taken.
 */
const fittingNames = (done: Done[]) => {
    const taken = new Set(done.map(s => s.image.name.toLowerCase()));
    return done.map((s) => {
        const name = s.image.name;
        const fit = EXTENSIONS[s.image.data.type];
        if (!s.changed || !fit || fit.re.test(name)) return s.image;
        const renamed = `${name.replace(/\.[^./]*$/, '')}${fit.ext}`;
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
        if (op instanceof ResizeOp) op.reference = undefined;

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
        if (op instanceof ResizeOp) {
            // read from the headers: quick, and the face shows its linked
            // fields from it while the work goes on
            referenceSize(images).then((size) => {
                if (!current()) return;
                op.reference = size;
                events.fire('dataset.statusChanged', op);
            }).catch(() => {});
        }

        const out: Done[] = new Array(images.length);
        let next = 0;
        let done = 0;
        let failed: unknown = null;
        const worker = async () => {
            while (next < images.length && !failed && current()) {
                const k = next++;
                try {
                    out[k] = remembered(images[k], work.key) ?? await work.each(images[k]);
                    remember(images[k], work.key, out[k]);
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

        op.source = { kind: 'images', images: fittingNames(out) };
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
        const was = JSON.stringify(op.settings);
        op.settings = resizeSettingsFrom({ ...op.settings, ...settings }, op.settings);
        // the same settings again: what it made stands
        if (JSON.stringify(op.settings) === was) return;
        events.fire('edit.changed');
        run(op).catch(() => {});
    });

    events.on('crop.setImageCrop', (op: CropOp, settings: Partial<ImageCropSettings>) => {
        if (!(op instanceof CropOp) || op.mode !== '2d') return;
        const was = JSON.stringify(op.imageCrop);
        op.imageCrop = imageCropFrom({ ...op.imageCrop, ...settings }, op.imageCrop);
        // the same crop again: what it made stands
        if (JSON.stringify(op.imageCrop) === was) return;
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

export { cachedSize, frameOf, headerSize, imageSize, needsResize, referenceSize, registerImageNodes, workKey, type Frame, type FramedImage };
