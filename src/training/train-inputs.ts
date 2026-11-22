import { flattenNames } from './bridge-ingest';
import { TrainSource } from './brush-engine';
import { packDataset } from './dataset';
import { Frame, frameOf, imageSize } from './image-nodes';
import { TrainOp } from '../edit-ops';

/**
 * A train node's two inputs put together: the images wired into "images"
 * with the cameras a pose node found, on what may be other copies of the
 * same photos - smaller (a resize node), cut (a 2d crop), or the full-size
 * originals while the poses came from a smaller copy.
 *
 * Images and cameras are matched by file name, without the extension (a
 * PNG shrunk becomes a JPEG). Each camera's intrinsics are fitted to the
 * image it is trained with: where both copies carry a frame (how their
 * pixels relate to the photo as imported, image-nodes.ts) that says the
 * scale and the shift exactly - a crop after posing moves cx and cy;
 * otherwise the sizes' ratio scales fx, fy, cx and cy. Every image gets a
 * camera of its own in the model written, as two copies of one camera
 * need not stay one.
 */

type Camera = { model: number, width: number, height: number, params: number[] };

// parameters per COLMAP camera model id, and which models have their own fy
const MODEL_PARAMS = [3, 4, 4, 5, 8, 8, 12, 5, 4, 5, 12];
const MODEL_NAMES = ['SIMPLE_PINHOLE', 'PINHOLE', 'SIMPLE_RADIAL', 'RADIAL', 'OPENCV', 'OPENCV_FISHEYE', 'FULL_OPENCV', 'FOV', 'SIMPLE_RADIAL_FISHEYE', 'RADIAL_FISHEYE', 'THIN_PRISM_FISHEYE'];
const HAS_FY = new Set([1, 4, 5, 6, 10]);

/** a posed image: its pose, its camera, and its 2D points */
type Posed = { id: number, q: number[], t: number[], cameraId: number, name: string, points: { x: number, y: number, id: bigint }[] };

const readCamerasBin = (bytes: Uint8Array) => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const cameras = new Map<number, Camera>();
    let at = 8;
    const count = Number(view.getBigUint64(0, true));
    for (let i = 0; i < count; i++) {
        const id = view.getInt32(at, true);
        const model = view.getInt32(at + 4, true);
        const width = Number(view.getBigUint64(at + 8, true));
        const height = Number(view.getBigUint64(at + 16, true));
        at += 24;
        const params: number[] = [];
        for (let p = 0; p < (MODEL_PARAMS[model] ?? 0); p++) params.push(view.getFloat64(at + p * 8, true));
        at += params.length * 8;
        cameras.set(id, { model, width, height, params });
    }
    return cameras;
};

const readImagesBin = (bytes: Uint8Array) => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const decoder = new TextDecoder();
    const out: Posed[] = [];
    let at = 8;
    const count = Number(view.getBigUint64(0, true));
    for (let i = 0; i < count; i++) {
        const id = view.getInt32(at, true);
        const base = at + 4;
        const q = [0, 1, 2, 3].map(k => view.getFloat64(base + k * 8, true));
        const t = [0, 1, 2].map(k => view.getFloat64(base + 32 + k * 8, true));
        const cameraId = view.getInt32(base + 56, true);
        at = base + 60;
        let end = at;
        while (end < bytes.length && bytes[end] !== 0) end++;
        const name = decoder.decode(bytes.subarray(at, end));
        at = end + 1;
        const n = Number(view.getBigUint64(at, true));
        at += 8;
        const points = [];
        for (let p = 0; p < n; p++) {
            points.push({ x: view.getFloat64(at, true), y: view.getFloat64(at + 8, true), id: view.getBigInt64(at + 16, true) });
            at += 24;
        }
        out.push({ id, q, t, cameraId, name, points });
    }
    return out;
};

const dataLines = (text: string) => text.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#'));

const readCamerasTxt = (text: string) => {
    const cameras = new Map<number, Camera>();
    for (const line of dataLines(text)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) continue;
        cameras.set(Number(parts[0]), { model: MODEL_NAMES.indexOf(parts[1]), width: Number(parts[2]), height: Number(parts[3]), params: parts.slice(4).map(Number) });
    }
    return cameras;
};

const readImagesTxt = (text: string) => {
    const out: Posed[] = [];
    // two lines per image: the pose, then its 2D points (which may be empty)
    const lines = text.split(/\r?\n/).filter(l => !l.trim().startsWith('#'));
    for (let i = 0; i < lines.length; i++) {
        const parts = lines[i].trim().split(/\s+/);
        if (parts.length < 10) continue;
        const values = (lines[i + 1] ?? '').trim().split(/\s+/).filter(Boolean);
        const points = [];
        for (let p = 0; p + 2 < values.length; p += 3) {
            points.push({ x: Number(values[p]), y: Number(values[p + 1]), id: BigInt(values[p + 2]) });
        }
        out.push({ id: Number(parts[0]), q: parts.slice(1, 5).map(Number), t: parts.slice(5, 8).map(Number), cameraId: Number(parts[8]), name: parts.slice(9).join(' '), points });
        i++;
    }
    return out;
};

const writeCamerasBin = (cameras: Camera[]) => {
    const size = 8 + cameras.reduce((n, c) => n + 24 + c.params.length * 8, 0);
    const view = new DataView(new ArrayBuffer(size));
    view.setBigUint64(0, BigInt(cameras.length), true);
    let at = 8;
    cameras.forEach((c, i) => {
        view.setInt32(at, i + 1, true);
        view.setInt32(at + 4, c.model, true);
        view.setBigUint64(at + 8, BigInt(c.width), true);
        view.setBigUint64(at + 16, BigInt(c.height), true);
        at += 24;
        c.params.forEach((p) => {
            view.setFloat64(at, p, true);
            at += 8;
        });
    });
    return new Uint8Array(view.buffer);
};

const writeImagesBin = (images: Posed[]) => {
    const encoder = new TextEncoder();
    const names = images.map(i => encoder.encode(i.name));
    const size = 8 + images.reduce((n, image, k) => n + 4 + 60 + names[k].length + 1 + 8 + image.points.length * 24, 0);
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    view.setBigUint64(0, BigInt(images.length), true);
    let at = 8;
    images.forEach((image, k) => {
        view.setInt32(at, image.id, true);
        image.q.forEach((v, j) => view.setFloat64(at + 4 + j * 8, v, true));
        image.t.forEach((v, j) => view.setFloat64(at + 36 + j * 8, v, true));
        view.setInt32(at + 60, image.cameraId, true);
        at += 64;
        bytes.set(names[k], at);
        at += names[k].length + 1;
        view.setBigUint64(at, BigInt(image.points.length), true);
        at += 8;
        image.points.forEach((p) => {
            view.setFloat64(at, p.x, true);
            view.setFloat64(at + 8, p.y, true);
            view.setBigInt64(at + 16, p.id, true);
            at += 24;
        });
    });
    return bytes;
};

const writeCamerasTxt = (cameras: Camera[]) => new TextEncoder().encode(cameras.map((c, i) => `${i + 1} ${MODEL_NAMES[c.model]} ${c.width} ${c.height} ${c.params.join(' ')}\n`).join(''));

const writeImagesTxt = (images: Posed[]) => new TextEncoder().encode(images.map(image => `${image.id} ${image.q.join(' ')} ${image.t.join(' ')} ${image.cameraId} ${image.name}\n${image.points.map(p => `${p.x} ${p.y} ${p.id}`).join(' ')}\n`).join(''));

/** a file's name without folder or extension, for matching copies of one photo */
const stem = (name: string) => (name.split('/').pop() ?? name).replace(/\.[^.]*$/, '').toLowerCase();

const isIdentity = (f: Frame) => f.ax === 1 && f.ay === 1 && f.bx === 0 && f.by === 0;

/**
 * The camera found on one copy, fitted to another: x_t = ax * x_p + bx.
 * Distortion coefficients are in normalised coordinates and stay.
 */
const fitCamera = (c: Camera, width: number, height: number, ax: number, bx: number, ay: number, by: number): Camera => {
    const p = c.params.slice();
    if (HAS_FY.has(c.model)) {
        p[0] *= ax;
        p[1] *= ay;
        p[2] = ax * p[2] + bx;
        p[3] = ay * p[3] + by;
    } else {
        // one focal length: the scale across, which is the scale down too
        // unless a crop stretched nothing - neither does
        p[0] *= ax;
        p[1] = ax * p[1] + bx;
        p[2] = ay * p[2] + by;
    }
    return { model: c.model, width, height, params: p };
};

/**
 * The train node's dataset as the trainer gets it. Most of the time that
 * is one input's own; with images and cameras from different copies, the
 * pair is put together here. `note` hears what was matched.
 */
const resolveTrainSource = async (op: TrainOp, note: (text: string) => void = () => {}): Promise<TrainSource | null> => {
    const ready = op.dataset;
    if (!ready) return null;
    if (ready !== 'fit') return ready as TrainSource;

    const cameras = op.camerasOp;
    const sparse = cameras.sparse;
    const posedImages = ((cameras.datasetOp?.source as any)?.images ?? []) as { name: string, data: Blob }[];
    const trainImages = flattenNames(((op.imagesOp.source as any)?.images ?? []) as { name: string, data: Blob }[])
    .map((image, k) => ({ ...image, frame: frameOf(((op.imagesOp.source as any).images)[k]) }));

    const find = (name: string) => sparse.find(f => f.path.endsWith(`/${name}`) || f.path === name);
    const camerasFile = find('cameras.bin') ?? find('cameras.txt');
    const imagesFile = find('images.bin') ?? find('images.txt');
    const pointsFile = find('points3D.bin') ?? find('points3D.txt');
    if (!camerasFile || !imagesFile) throw new Error('the pose node\'s model has no cameras or images file');
    // each file is written back in the format it came in; the image ids
    // stay, so the points' tracks still name the right images
    const text = camerasFile.path.endsWith('.txt');
    const imagesText = imagesFile.path.endsWith('.txt');
    const decoder = new TextDecoder();
    const model = text ? readCamerasTxt(decoder.decode(camerasFile.data)) : readCamerasBin(camerasFile.data);
    const posed = imagesText ? readImagesTxt(decoder.decode(imagesFile.data)) : readImagesBin(imagesFile.data);

    const posedFrames = new Map(posedImages.map(image => [stem(image.name), frameOf(image)]));
    const byStem = new Map(trainImages.map(image => [stem(image.name), image]));

    const outCameras: Camera[] = [];
    const outImages: Posed[] = [];
    const used: typeof trainImages = [];
    for (const image of posed) {
        const train = byStem.get(stem(image.name));
        const camera = model.get(image.cameraId);
        if (!train || !camera) continue;
        const [w, h] = await imageSize(train.data);
        const fp = posedFrames.get(stem(image.name)) ?? { ax: 1, bx: 0, ay: 1, by: 0 };
        const ft = train.frame;
        let ax: number, bx: number, ay: number, by: number;
        if (isIdentity(fp) && isIdentity(ft)) {
            // no frames to go by (copies from elsewhere): the sizes' ratio
            ax = w / camera.width;
            ay = h / camera.height;
            bx = 0;
            by = 0;
        } else {
            ax = ft.ax / fp.ax;
            ay = ft.ay / fp.ay;
            bx = ft.bx - ax * fp.bx;
            by = ft.by - ay * fp.by;
        }
        outCameras.push(fitCamera(camera, w, h, ax, bx, ay, by));
        outImages.push({
            ...image,
            cameraId: outCameras.length,
            name: train.name,
            points: image.points.map(p => ({ x: ax * p.x + bx, y: ay * p.y + by, id: p.id }))
        });
        used.push(train);
    }
    if (!outImages.length) throw new Error('no image on the images input has a camera on the cameras input (matched by file name)');
    note(`trained on ${outImages.length} of ${trainImages.length} images with cameras from ${cameras.sourceName}`);

    const files = [
        ...used.map(image => ({ filename: `images/${image.name}`, contents: image.data as Blob })),
        { filename: `sparse/0/cameras.${text ? 'txt' : 'bin'}`, contents: new Blob([(text ? writeCamerasTxt(outCameras) : writeCamerasBin(outCameras)) as BlobPart]) },
        { filename: `sparse/0/images.${imagesText ? 'txt' : 'bin'}`, contents: new Blob([(imagesText ? writeImagesTxt(outImages) : writeImagesBin(outImages)) as BlobPart]) },
        ...(pointsFile ? [{ filename: `sparse/0/${pointsFile.path.split('/').pop()}`, contents: new Blob([pointsFile.data as BlobPart]) }] : [])
    ];
    const { zip } = await packDataset(files);
    return { kind: 'bytes', bytes: zip, name: 'dataset.zip' };
};

export { resolveTrainSource };
