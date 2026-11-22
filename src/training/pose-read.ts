import { DatasetReader } from './dataset-source';
import type { PoseCamera } from '../edit-ops';

/**
 * Camera poses read out of a dataset's pose files, for drawing.
 *
 * COLMAP stores world-to-camera rotations and translations; nerfstudio's
 * transforms.json stores camera-to-world matrices with OpenGL axes. Both
 * end up as a centre and COLMAP-style axes (x right, y down, z forward),
 * then turned into the scene's frame the way a trained PLY is: 180 degrees
 * about z, which negates x and y (the same as loadImagesTxt in
 * file-handler.ts and the rotation splat-transform gives a PLY).
 */

type Vec = number[];

const toScene = (v: Vec): Vec => [-v[0], -v[1], v[2]];

/** rows of the world-to-camera rotation of a unit quaternion (w, x, y, z) */
const quatRows = (qw: number, qx: number, qy: number, qz: number): Vec[] => {
    const n = Math.hypot(qw, qx, qy, qz) || 1;
    const w = qw / n, x = qx / n, y = qy / n, z = qz / n;
    return [
        [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]
    ];
};

type Intrinsics = { width: number, height: number, fx: number, fy: number };

/** a COLMAP image record as a camera: centre -R^T t, axes the rows of R */
const colmapCamera = (name: string, q: number[], t: number[], k: Intrinsics | undefined): PoseCamera => {
    const r = quatRows(q[0], q[1], q[2], q[3]);
    const center = [0, 1, 2].map(j => -(r[0][j] * t[0] + r[1][j] * t[1] + r[2][j] * t[2]));
    const width = k?.width ?? 4;
    const height = k?.height ?? 3;
    return {
        name,
        center: toScene(center),
        right: toScene(r[0]),
        down: toScene(r[1]),
        forward: toScene(r[2]),
        width,
        height,
        fx: k?.fx ?? width,
        fy: k?.fy ?? k?.fx ?? width
    };
};

// parameters per COLMAP camera model id, and which models have their own fy
const MODEL_PARAMS = [3, 4, 4, 5, 8, 8, 12, 5, 4, 5, 12];
const MODEL_NAMES = ['SIMPLE_PINHOLE', 'PINHOLE', 'SIMPLE_RADIAL', 'RADIAL', 'OPENCV', 'OPENCV_FISHEYE', 'FULL_OPENCV', 'FOV', 'SIMPLE_RADIAL_FISHEYE', 'RADIAL_FISHEYE', 'THIN_PRISM_FISHEYE'];
const HAS_FY = new Set([1, 4, 5, 6, 10]);

const intrinsics = (model: number, width: number, height: number, params: number[]): Intrinsics => ({
    width,
    height,
    fx: params[0],
    fy: HAS_FY.has(model) ? params[1] : params[0]
});

const readCamerasBin = (bytes: Uint8Array) => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const cameras = new Map<number, Intrinsics>();
    let at = 0;
    const count = Number(view.getBigUint64(at, true));
    at += 8;
    for (let i = 0; i < count; i++) {
        const id = view.getInt32(at, true);
        const model = view.getInt32(at + 4, true);
        const width = Number(view.getBigUint64(at + 8, true));
        const height = Number(view.getBigUint64(at + 16, true));
        at += 24;
        const n = MODEL_PARAMS[model] ?? 0;
        const params: number[] = [];
        for (let p = 0; p < n; p++) params.push(view.getFloat64(at + p * 8, true));
        at += n * 8;
        cameras.set(id, intrinsics(model, width, height, params));
    }
    return cameras;
};

const readImagesBin = (bytes: Uint8Array, cameras: Map<number, Intrinsics>) => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out: PoseCamera[] = [];
    const decoder = new TextDecoder();
    let at = 0;
    const count = Number(view.getBigUint64(at, true));
    at += 8;
    for (let i = 0; i < count; i++) {
        at += 4; // image id
        const base = at;
        const q = [0, 1, 2, 3].map(k => view.getFloat64(base + k * 8, true));
        const t = [0, 1, 2].map(k => view.getFloat64(base + 32 + k * 8, true));
        const cameraId = view.getInt32(at + 56, true);
        at += 60;
        let end = at;
        while (end < bytes.length && bytes[end] !== 0) end++;
        const name = decoder.decode(bytes.subarray(at, end));
        at = end + 1;
        const points = Number(view.getBigUint64(at, true));
        at += 8 + points * 24;
        out.push(colmapCamera(name, q, t, cameras.get(cameraId)));
    }
    return out;
};

const dataLines = (text: string) => text.split(/\r?\n/).filter(l => !l.trim().startsWith('#'));

const readCamerasTxt = (text: string) => {
    const cameras = new Map<number, Intrinsics>();
    for (const line of dataLines(text)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) continue;
        const model = MODEL_NAMES.indexOf(parts[1]);
        cameras.set(Number(parts[0]), intrinsics(model, Number(parts[2]), Number(parts[3]), parts.slice(4).map(Number)));
    }
    return cameras;
};

const readImagesTxt = (text: string, cameras: Map<number, Intrinsics>) => {
    const out: PoseCamera[] = [];
    // two lines per image: the pose, then its 2D points (which may be empty)
    const lines = text.split(/\r?\n/);
    let expectPose = true;
    for (const line of lines) {
        if (line.trim().startsWith('#')) continue;
        if (!expectPose) {
            expectPose = true;
            continue;
        }
        const parts = line.trim().split(/\s+/);
        if (parts.length < 10) continue;
        const q = parts.slice(1, 5).map(Number);
        const t = parts.slice(5, 8).map(Number);
        out.push(colmapCamera(parts.slice(9).join(' '), q, t, cameras.get(Number(parts[8]))));
        expectPose = false;
    }
    return out;
};

/** nerfstudio / instant-ngp: camera-to-world matrices, OpenGL axes (y up, z back) */
const readTransformsJson = (text: string): PoseCamera[] => {
    const json = JSON.parse(text);
    const frames = Array.isArray(json?.frames) ? json.frames : [];
    return frames.flatMap((frame: any) => {
        const m = frame.transform_matrix;
        if (!Array.isArray(m) || m.length < 3) return [];
        const col = (j: number) => [m[0][j], m[1][j], m[2][j]];
        const width = Number(frame.w ?? json.w) || 4;
        const height = Number(frame.h ?? json.h) || 3;
        const angle = Number(frame.camera_angle_x ?? json.camera_angle_x);
        const fx = Number(frame.fl_x ?? json.fl_x) || (angle ? width / 2 / Math.tan(angle / 2) : width);
        const fy = Number(frame.fl_y ?? json.fl_y) || fx;
        const up = col(1);
        const back = col(2);
        return [{
            name: String(frame.file_path ?? ''),
            center: toScene(col(3)),
            right: toScene(col(0)),
            down: toScene(up.map(v => -v)),
            forward: toScene(back.map(v => -v)),
            width,
            height,
            fx,
            fy
        }];
    });
};

/** the model files estimation hands back, or a dataset's own, as cameras */
const camerasFromSparse = (files: { path: string, data: Uint8Array }[]): PoseCamera[] => {
    const find = (name: string) => files.find(f => f.path.toLowerCase().endsWith(name));
    const text = (f: { data: Uint8Array }) => new TextDecoder().decode(f.data);
    const camerasBin = find('cameras.bin');
    const imagesBin = find('images.bin');
    if (imagesBin) return readImagesBin(imagesBin.data, camerasBin ? readCamerasBin(camerasBin.data) : new Map());
    const imagesTxt = find('images.txt');
    if (imagesTxt) {
        const camerasTxt = find('cameras.txt');
        return readImagesTxt(text(imagesTxt), camerasTxt ? readCamerasTxt(text(camerasTxt)) : new Map());
    }
    const transforms = find('transforms.json');
    if (transforms) return readTransformsJson(text(transforms));
    return [];
};

/**
 * The mean reprojection error of a COLMAP model's points, in pixels, from
 * points3D.bin or points3D.txt; undefined when it has neither.
 */
const meanReprojectionError = (files: { path: string, data: Uint8Array }[]): number | undefined => {
    const find = (name: string) => files.find(f => f.path.toLowerCase().endsWith(name));
    let sum = 0;
    let n = 0;
    const bin = find('points3d.bin');
    if (bin) {
        const view = new DataView(bin.data.buffer, bin.data.byteOffset, bin.data.byteLength);
        const count = Number(view.getBigUint64(0, true));
        let at = 8;
        for (let i = 0; i < count && at + 51 <= view.byteLength; i++) {
            // id (8), xyz (24), rgb (3), error (8), track length (8), track (8 each)
            sum += view.getFloat64(at + 35, true);
            n++;
            const track = Number(view.getBigUint64(at + 43, true));
            at += 51 + track * 8;
        }
    } else {
        const txt = find('points3d.txt');
        if (!txt) return undefined;
        for (const line of dataLines(new TextDecoder().decode(txt.data))) {
            const error = Number(line.trim().split(/\s+/)[7]);
            if (Number.isFinite(error)) {
                sum += error;
                n++;
            }
        }
    }
    return n ? sum / n : undefined;
};

const IMAGE_RE = /\.(?:jpg|jpeg|png|webp)$/i;

/**
 * The poses of a dataset that already has them, and how many images it
 * holds. The first COLMAP model found wins (sparse/0 before sparse/1);
 * a RealityCapture csv is not read, so its cameras are not drawn.
 */
const readDatasetPoses = async (reader: DatasetReader): Promise<{ cameras: PoseCamera[], total: number, found: boolean }> => {
    const list = [...reader.list].sort();
    const total = list.filter(p => IMAGE_RE.test(p)).length;
    const pick = (name: string) => list.find(p => p.toLowerCase().endsWith(name));
    const wanted = [
        pick('images.bin'), pick('cameras.bin'),
        pick('images.txt'), pick('cameras.txt'),
        pick('transforms.json')
    ].filter(Boolean);
    // a COLMAP pair from the same folder, not one file from each of two models
    const dir = (p: string) => p.slice(0, p.lastIndexOf('/') + 1);
    const model = wanted[0] ? dir(wanted[0]) : '';
    const files: { path: string, data: Uint8Array }[] = [];
    for (const path of wanted) {
        if (path.toLowerCase().endsWith('transforms.json') || dir(path) === model) {
            files.push({ path, data: await reader.read(path) });
        }
    }
    const found = files.length > 0 || list.some(p => p.toLowerCase().endsWith('.csv'));
    return { cameras: camerasFromSparse(files), total, found };
};

export { camerasFromSparse, meanReprojectionError, readDatasetPoses };
