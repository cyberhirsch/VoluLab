import { isRawCapture } from './dataset-source';
import { DEFAULT_VIDEO_FPS, DatasetOp, ImportSubset, importSubsetFrom } from '../edit-ops';
import { Events } from '../events';
import { i18n } from '../ui/localization';

/**
 * An import node's subset: which of its photos go on to the image and pose
 * nodes, and at what rate a video's frames are taken. The node keeps what
 * was imported (`original`) and hands on the subset (`source`).
 *
 * Also the photos' small analysis, shared by the faces: a thumbnail about
 * 96 px high and a sharpness score, the variance of the Laplacian of the
 * photo in grey at 320 px high. Blurry photos are a classic cause of SfM
 * failing, and the score finds them cheaply: a blurred photo has little
 * second derivative. Neither keeps a full-size decode: the photo is
 * decoded straight to 320 px, and only the thumbnail and the number stay.
 */

const SCORE_HEIGHT = 320;
const THUMB_HEIGHT = 96;
// photos decoded at once, across every face and node
const POOL = 2;

type Analysis = { sharpness: number, thumb: ImageBitmap };

const analyses = new WeakMap<Blob, Promise<Analysis>>();
// the scores known so far, readable without waiting
const scores = new WeakMap<Blob, number>();

let active = 0;
const waiting: (() => void)[] = [];
const slot = async () => {
    if (active >= POOL) {
        await new Promise<void>((resolve) => {
            waiting.push(resolve);
        });
    }
    active++;
};
const release = () => {
    active--;
    waiting.shift()?.();
};

/** variance of the 4-neighbour Laplacian of the grey image */
const laplacianVariance = (rgba: Uint8ClampedArray, w: number, h: number) => {
    const grey = new Float32Array(w * h);
    for (let i = 0, j = 0; i < grey.length; i++, j += 4) {
        grey[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
    }
    let sum = 0;
    let sum2 = 0;
    let n = 0;
    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            const i = y * w + x;
            const v = grey[i - 1] + grey[i + 1] + grey[i - w] + grey[i + w] - 4 * grey[i];
            sum += v;
            sum2 += v * v;
            n++;
        }
    }
    if (!n) return 0;
    const mean = sum / n;
    return sum2 / n - mean * mean;
};

const analyse = async (blob: Blob): Promise<Analysis> => {
    await slot();
    try {
        const bitmap = await createImageBitmap(blob, { resizeHeight: SCORE_HEIGHT, resizeQuality: 'medium' });
        try {
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(bitmap, 0, 0);
            const sharpness = laplacianVariance(ctx.getImageData(0, 0, bitmap.width, bitmap.height).data, bitmap.width, bitmap.height);
            const thumb = await createImageBitmap(bitmap, { resizeHeight: THUMB_HEIGHT, resizeQuality: 'medium' });
            scores.set(blob, sharpness);
            return { sharpness, thumb };
        } finally {
            bitmap.close();
        }
    } finally {
        release();
    }
};

/** A photo's thumbnail and sharpness, worked out once per photo. */
const analysisOf = (blob: Blob): Promise<Analysis> => {
    let a = analyses.get(blob);
    if (!a) {
        a = analyse(blob);
        analyses.set(blob, a);
        a.catch(() => analyses.delete(blob));
    }
    return a;
};

/** a photo's sharpness, if it is known yet */
const knownSharpness = (blob: Blob) => scores.get(blob);

/** the places of the photos kept, by every Nth and the range, in order */
const rangeOf = (n: number, s: ImportSubset) => {
    const from = Math.min(Math.max(1, s.from), n) - 1;
    const to = s.to > 0 ? Math.min(s.to, n) : n;
    const out: number[] = [];
    for (let i = from; i < to; i += Math.max(1, s.every)) out.push(i);
    return out;
};

/** the places less the blurriest share, in their order */
const lessBlurry = (places: number[], sharpness: (i: number) => number, percent: number) => {
    const drop = Math.floor(places.length * percent / 100);
    if (!drop) return places;
    const gone = new Set([...places].sort((a, b) => sharpness(a) - sharpness(b)).slice(0, drop));
    return places.filter(i => !gone.has(i));
};

type Photos = { kind: 'images', images: { name: string, data: Blob }[] };
type Video = { kind: 'video', file: File, fps?: number };

const sameList = (a: number[] | undefined, b: number[] | undefined) => (a ?? null) === (b ?? null) ||
    (!!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]));

const registerImportSubset = (events: Events) => {
    // the newest application per node; an older one finishing changes nothing
    const generation = new WeakMap<DatasetOp, number>();

    const handOn = (op: DatasetOp) => {
        events.fire('dataset.sourceChanged', op);
        events.fire('dataset.statusChanged', op);
        events.fire('edit.changed');
    };

    /**
     * Work out what the node hands on from what it holds and its subset,
     * and tell the nodes after it when that changed - or always, with
     * `force` (a new import). Scores still missing for the blur cut are
     * worked out first; the node hands on nothing meanwhile, so nothing
     * downstream starts on photos about to be dropped.
     */
    const apply = async (op: DatasetOp, force = false) => {
        const gen = (generation.get(op) ?? 0) + 1;
        generation.set(op, gen);
        const current = () => generation.get(op) === gen;
        const original = op.original;
        const s = op.subset;

        if (isRawCapture(original) && original.kind === 'video') {
            const video = original as Video;
            const source = s.fps === DEFAULT_VIDEO_FPS ? video : { ...video, fps: s.fps };
            const was = (op.source as Video | null)?.fps ?? DEFAULT_VIDEO_FPS;
            if (!force && op.source && was === s.fps) return;
            op.source = source;
            op.kept = undefined;
            handOn(op);
            return;
        }

        if (!isRawCapture(original) || original.kind !== 'images') {
            if (force) handOn(op);
            return;
        }

        const images = (original as Photos).images;
        let places = rangeOf(images.length, s);
        if (s.dropBlurry > 0) {
            const missing = places.filter(i => knownSharpness(images[i].data) === undefined);
            if (missing.length) {
                op.source = null;
                op.kept = undefined;
                let done = places.length - missing.length;
                op.status = i18n.t('import.scoring', { done, total: places.length });
                handOn(op);
                let failed = false;
                await Promise.all(missing.map(i => analysisOf(images[i].data).then(() => {
                    done++;
                    if (!current()) return;
                    op.status = i18n.t('import.scoring', { done, total: places.length });
                    events.fire('dataset.statusChanged', op);
                }).catch(() => {
                    failed = true;
                })));
                if (!current()) return;
                op.status = failed ? i18n.t('import.scoring-failed') : undefined;
                force = true;
            }
            // a photo that could not be scored counts as sharp: kept
            places = lessBlurry(places, i => knownSharpness(images[i].data) ?? Infinity, s.dropBlurry);
        }

        const all = places.length === images.length;
        const kept = all ? undefined : places;
        if (!force && op.source && sameList(op.kept, kept)) return;
        op.kept = kept;
        op.source = all ? original : { kind: 'images', images: places.map(i => images[i]) };
        handOn(op);
    };

    events.on('import.applySubset', (op: DatasetOp, force = true) => {
        if (op instanceof DatasetOp) apply(op, force).catch(() => {});
    });

    events.on('import.setSubset', (op: DatasetOp, subset: Partial<ImportSubset>) => {
        if (!(op instanceof DatasetOp)) return;
        const was = JSON.stringify(op.subset);
        op.subset = importSubsetFrom({ ...op.subset, ...subset }, op.subset);
        if (JSON.stringify(op.subset) === was) return;
        events.fire('edit.changed');
        apply(op).catch(() => {});
    });
};

export { analysisOf, knownSharpness, registerImportSubset };
