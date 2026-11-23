import { Quat, Vec3 } from 'playcanvas';

import { TrainSource } from './brush-engine';
import { packDataset } from './dataset';
import { openDataset } from './dataset-source';
import type { PoseCamera } from '../edit-ops';
import { Transform } from '../transform';

/**
 * A pose node's cameras put somewhere else: what the transform nodes on
 * its cameras output come to (PoseOp.placement), taken to the frustums in
 * the viewport and to the dataset the trainer reads, so the two agree and
 * the splat trained comes out in the frame the cameras were put in.
 *
 * A camera can be moved, turned and scaled with the scene it sees, but
 * not stretched along one axis or mirrored: a pose has a rotation, not a
 * shear. The scale taken is the mean of the placement's three (their
 * geometric mean, which keeps the volume), its rotation as it is.
 *
 * The scene's frame is COLMAP's turned 180 degrees about z (pose-read.ts):
 * x and y negated. A placement in the scene's frame is the same rotation
 * about the axis turned likewise in COLMAP's.
 */

type Motion = { scale: number, rotation: Quat, translation: Vec3 };

const motionOf = (placement: Transform): Motion => {
    const { x, y, z } = placement.scale;
    return {
        scale: Math.cbrt(Math.abs(x * y * z)) || 1,
        rotation: placement.rotation.clone().normalize(),
        translation: placement.position.clone()
    };
};

/** does this placement leave the cameras where they are? */
const isIdentityPlacement = (placement: Transform | undefined) => !placement || placement.equalsApprox(new Transform(), 1e-9);

/** a camera as the viewport draws it, in the placed frame */
const placeCamera = (camera: PoseCamera, placement: Transform): PoseCamera => {
    const m = motionOf(placement);
    const v = new Vec3();
    const turn = (a: number[]) => {
        m.rotation.transformVector(v.set(a[0], a[1], a[2]), v);
        return [v.x, v.y, v.z];
    };
    const centre = turn(camera.center);
    return {
        ...camera,
        center: [m.scale * centre[0] + m.translation.x, m.scale * centre[1] + m.translation.y, m.scale * centre[2] + m.translation.z],
        right: turn(camera.right),
        down: turn(camera.down),
        forward: turn(camera.forward)
    };
};

// ---- COLMAP's frame: quaternions as (w, x, y, z), Hamilton

type Q = [number, number, number, number];

const qmul = (a: Q, b: Q): Q => [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]
];

const qrows = (q: Q): number[][] => {
    const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    const w = q[0] / n, x = q[1] / n, y = q[2] / n, z = q[3] / n;
    return [
        [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]
    ];
};

const mulRows = (r: number[][], v: number[]) => r.map(row => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);

/** the placement in COLMAP's frame: X' = s R X + T */
const colmapMotion = (placement: Transform) => {
    const m = motionOf(placement);
    const { x, y, z, w } = m.rotation;
    // turned 180 degrees about z: the axis's x and y negate
    const q: Q = [w, -x, -y, z];
    return { s: m.scale, q, rows: qrows(q), t: [-m.translation.x, -m.translation.y, m.translation.z] };
};

type Colmap = ReturnType<typeof colmapMotion>;

const point = (c: Colmap, p: number[]) => {
    const r = mulRows(c.rows, p);
    return [c.s * r[0] + c.t[0], c.s * r[1] + c.t[1], c.s * r[2] + c.t[2]];
};

/**
 * A world-to-camera pose under the placement. With X' = s R X + T and the
 * camera's own coordinates scaled with the world: R' = Rcam R^T, and
 * t' = s t - R' T.
 */
const pose = (c: Colmap, q: Q, t: number[]): { q: Q, t: number[] } => {
    const inverse: Q = [c.q[0], -c.q[1], -c.q[2], -c.q[3]];
    const q2 = qmul(q, inverse);
    const rt = mulRows(qrows(q2), c.t);
    return { q: q2, t: [c.s * t[0] - rt[0], c.s * t[1] - rt[1], c.s * t[2] - rt[2]] };
};

const imagesBin = (bytes: Uint8Array, c: Colmap) => {
    const out = bytes.slice();
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    const count = Number(view.getBigUint64(0, true));
    let at = 8;
    for (let i = 0; i < count; i++) {
        const base = at + 4;
        const q = [0, 1, 2, 3].map(k => view.getFloat64(base + k * 8, true)) as Q;
        const t = [0, 1, 2].map(k => view.getFloat64(base + 32 + k * 8, true));
        const placed = pose(c, q, t);
        placed.q.forEach((v, k) => view.setFloat64(base + k * 8, v, true));
        placed.t.forEach((v, k) => view.setFloat64(base + 32 + k * 8, v, true));
        at = base + 60;
        while (at < out.length && out[at] !== 0) at++;
        at++;
        const n = Number(view.getBigUint64(at, true));
        at += 8 + n * 24;
    }
    return out;
};

const pointsBin = (bytes: Uint8Array, c: Colmap) => {
    const out = bytes.slice();
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    const count = Number(view.getBigUint64(0, true));
    let at = 8;
    for (let i = 0; i < count && at + 43 <= view.byteLength; i++) {
        // id (8), xyz (24), rgb (3), error (8), track length (8), track (8 each)
        const xyz = at + 8;
        const p = [0, 1, 2].map(k => view.getFloat64(xyz + k * 8, true));
        point(c, p).forEach((v, k) => view.setFloat64(xyz + k * 8, v, true));
        const track = Number(view.getBigUint64(at + 43, true));
        at += 51 + track * 8;
    }
    return out;
};

const lines = (bytes: Uint8Array) => new TextDecoder().decode(bytes).split(/\r?\n/);
const encode = (text: string[]) => new TextEncoder().encode(text.join('\n'));

const imagesTxt = (bytes: Uint8Array, c: Colmap) => {
    // two lines per image: the pose, then its 2D points (which may be empty)
    let expectPose = true;
    return encode(lines(bytes).map((line) => {
        if (line.trim().startsWith('#')) return line;
        if (!expectPose) {
            expectPose = true;
            return line;
        }
        const parts = line.trim().split(/\s+/);
        if (parts.length < 10) return line;
        expectPose = false;
        const placed = pose(c, parts.slice(1, 5).map(Number) as Q, parts.slice(5, 8).map(Number));
        return [parts[0], ...placed.q, ...placed.t, ...parts.slice(8)].join(' ');
    }));
};

const pointsTxt = (bytes: Uint8Array, c: Colmap) => encode(lines(bytes).map((line) => {
    const parts = line.trim().split(/\s+/);
    if (line.trim().startsWith('#') || parts.length < 4) return line;
    return [parts[0], ...point(c, parts.slice(1, 4).map(Number)), ...parts.slice(4)].join(' ');
}));

/** camera-to-world matrices: the rotation turned, the centre placed */
const transformsJson = (bytes: Uint8Array, c: Colmap) => {
    const json = JSON.parse(new TextDecoder().decode(bytes));
    (Array.isArray(json?.frames) ? json.frames : []).forEach((frame: any) => {
        const m = frame?.transform_matrix;
        if (!Array.isArray(m) || m.length < 3) return;
        const col = (j: number) => [Number(m[0][j]), Number(m[1][j]), Number(m[2][j])];
        const axes = [0, 1, 2].map(j => mulRows(c.rows, col(j)));
        const centre = point(c, col(3));
        for (let i = 0; i < 3; i++) {
            m[i] = [axes[0][i], axes[1][i], axes[2][i], centre[i], ...m[i].slice(4)];
        }
    });
    return new TextEncoder().encode(JSON.stringify(json, null, 2));
};

/** a pose file, placed; null for any other file */
const placeFile = (path: string, data: Uint8Array, c: Colmap): Uint8Array | null => {
    const name = path.toLowerCase().split('/').pop();
    switch (name) {
        case 'images.bin': return imagesBin(data, c);
        case 'images.txt': return imagesTxt(data, c);
        case 'points3d.bin': return pointsBin(data, c);
        case 'points3d.txt': return pointsTxt(data, c);
        case 'transforms.json': return transformsJson(data, c);
        default: return null;
    }
};

const isPoseFile = (path: string) => /(?:^|\/)(?:images\.(?:bin|txt)|points3d\.(?:bin|txt)|transforms\.json)$/i.test(path);

/** a COLMAP model's files (or a transforms.json), placed */
const placeModelFiles = (files: { path: string, data: Uint8Array }[], placement: Transform) => {
    if (isIdentityPlacement(placement)) return files;
    const c = colmapMotion(placement);
    return files.map(f => ({ path: f.path, data: placeFile(f.path, f.data, c) ?? f.data }));
};

/**
 * A posed dataset with its cameras and points placed: every pose file
 * written again, everything else as it was, packed as a zip. A folder's
 * files are handed on as the browser's own blobs; a zip's are read.
 */
const placeTrainSource = async (source: TrainSource, placement: Transform): Promise<TrainSource> => {
    if (isIdentityPlacement(placement)) return source;
    const reader = await openDataset(source);
    if (!reader) throw new Error('the cameras cannot be transformed: the dataset is not a folder or a zip');
    try {
        const c = colmapMotion(placement);
        const files: { filename: string, contents: Blob }[] = [];
        for (const path of reader.list) {
            if (isPoseFile(path)) {
                const data = await reader.read(path);
                files.push({ filename: path, contents: new Blob([(placeFile(path, data, c) ?? data) as BlobPart]) });
            } else {
                files.push({ filename: path, contents: reader.blob ? await reader.blob(path) : new Blob([await reader.read(path) as BlobPart]) });
            }
        }
        const { zip } = await packDataset(files);
        return { kind: 'bytes', bytes: zip, name: 'dataset.zip' };
    } finally {
        reader.close();
    }
};

export { isIdentityPlacement, placeCamera, placeModelFiles, placeTrainSource };
