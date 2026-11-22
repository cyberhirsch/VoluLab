import { Mat4, Quat, Vec3 } from 'playcanvas';

import { Splat } from './splat';
import { State } from './splat-state';

/**
 * The geometry the motion nodes are built on (motion-nodes.ts): where a 4D
 * model's gaussians are at a time, a rigid transform fitted between two
 * sets of points, a plane fitted to points, and ICP between two objects.
 *
 * Positions are the model's own (model space) unless said otherwise. A 4D
 * model played on the GPU moves each gaussian along its velocity from its
 * temporal centre and fades it by its temporal falloff (splat-shader.ts);
 * the same is worked out here on the CPU for the few thousand gaussians a
 * fit needs.
 */

/** Which rows to fit to: the selected ones, or every live one, at most `max` of them, spread evenly. */
const sampleRows = (splat: Splat, max: number, filter: 'selected' | 'all' | 'static' = 'selected') => {
    const state = splat.splatData.getProp('state') as Uint8Array;
    const n = splat.splatData.numSplats;
    const vt = splat.motion?.velocityTime ?? null;

    // a gaussian that travels less than this over the whole sequence stands still
    const stillBelow = 1e-3 * Math.max(1e-6, splat.localBound?.halfExtents?.length() ?? 1);

    const pick: number[] = [];
    let selected = 0;
    for (let i = 0; i < n; ++i) {
        if (state[i] & State.selected) selected++;
    }
    const wantSelected = filter === 'selected' && selected > 0;
    for (let i = 0; i < n; ++i) {
        const s = state[i];
        if (s & (State.deleted | State.locked)) continue;
        if (wantSelected && !(s & State.selected)) continue;
        if (filter === 'static' && vt && Math.hypot(vt[i * 4], vt[i * 4 + 1], vt[i * 4 + 2]) > stillBelow) continue;
        pick.push(i);
    }
    if (pick.length <= max) return { rows: Uint32Array.from(pick), selected };
    const rows = new Uint32Array(max);
    const step = pick.length / max;
    for (let k = 0; k < max; ++k) rows[k] = pick[Math.floor(k * step)];
    return { rows, selected };
};

/**
 * Where the rows are at normalised time t, and how much each is there: its
 * temporal falloff, 1 for a 3D model.
 */
const positionsAt = (splat: Splat, rows: Uint32Array, t: number, pos: Float64Array, weight: Float64Array) => {
    const x = splat.splatData.getProp('x') as Float32Array;
    const y = splat.splatData.getProp('y') as Float32Array;
    const z = splat.splatData.getProp('z') as Float32Array;
    const motion = splat.motion;
    const vt = motion?.velocityTime;
    const fo = motion?.falloff;
    for (let k = 0; k < rows.length; ++k) {
        const i = rows[k];
        let px = x[i];
        let py = y[i];
        let pz = z[i];
        let w = 1;
        if (vt) {
            const dt = t - vt[i * 4 + 3];
            px += vt[i * 4] * dt;
            py += vt[i * 4 + 1] * dt;
            pz += vt[i * 4 + 2] * dt;
            w = Math.exp(-dt * dt * fo[i]);
        }
        pos[k * 3] = px;
        pos[k * 3 + 1] = py;
        pos[k * 3 + 2] = pz;
        weight[k] = w;
    }
};

/** Eigen decomposition of a symmetric n x n matrix (row major), by Jacobi rotations. */
const symmetricEigen = (a: Float64Array, n: number) => {
    const m = Float64Array.from(a);
    const v = new Float64Array(n * n);
    for (let i = 0; i < n; ++i) v[i * n + i] = 1;
    for (let sweep = 0; sweep < 60; ++sweep) {
        let off = 0;
        for (let p = 0; p < n; ++p) for (let q = p + 1; q < n; ++q) off += m[p * n + q] * m[p * n + q];
        if (off < 1e-30) break;
        for (let p = 0; p < n; ++p) {
            for (let q = p + 1; q < n; ++q) {
                const apq = m[p * n + q];
                if (Math.abs(apq) < 1e-300) continue;
                const theta = (m[q * n + q] - m[p * n + p]) / (2 * apq);
                const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
                const c = 1 / Math.sqrt(t * t + 1);
                const s = t * c;
                for (let k = 0; k < n; ++k) {
                    const mkp = m[k * n + p];
                    const mkq = m[k * n + q];
                    m[k * n + p] = c * mkp - s * mkq;
                    m[k * n + q] = s * mkp + c * mkq;
                }
                for (let k = 0; k < n; ++k) {
                    const mpk = m[p * n + k];
                    const mqk = m[q * n + k];
                    m[p * n + k] = c * mpk - s * mqk;
                    m[q * n + k] = s * mpk + c * mqk;
                }
                for (let k = 0; k < n; ++k) {
                    const vkp = v[k * n + p];
                    const vkq = v[k * n + q];
                    v[k * n + p] = c * vkp - s * vkq;
                    v[k * n + q] = s * vkp + c * vkq;
                }
            }
        }
    }
    const values = new Float64Array(n);
    for (let i = 0; i < n; ++i) values[i] = m[i * n + i];
    // vectors are the columns of v
    return { values, vectors: v };
};

type RigidFit = { matrix: Mat4, rms: number, weight: number };

/**
 * The rotation and translation that best take points P onto points Q,
 * weighted (Horn's quaternion method). Null with too little to go on.
 */
const fitRigid = (P: Float64Array, Q: Float64Array, W: Float64Array, count = W.length): RigidFit | null => {
    let sw = 0;
    const cp = [0, 0, 0];
    const cq = [0, 0, 0];
    for (let k = 0; k < count; ++k) {
        const w = W[k];
        if (!(w > 0)) continue;
        sw += w;
        for (let a = 0; a < 3; ++a) {
            cp[a] += w * P[k * 3 + a];
            cq[a] += w * Q[k * 3 + a];
        }
    }
    if (sw <= 1e-9) return null;
    for (let a = 0; a < 3; ++a) {
        cp[a] /= sw;
        cq[a] /= sw;
    }
    // cross-covariance S[a][b] = sum w (p_a - cp_a)(q_b - cq_b)
    const S = new Float64Array(9);
    for (let k = 0; k < count; ++k) {
        const w = W[k];
        if (!(w > 0)) continue;
        for (let a = 0; a < 3; ++a) {
            const pa = P[k * 3 + a] - cp[a];
            for (let b = 0; b < 3; ++b) S[a * 3 + b] += w * pa * (Q[k * 3 + b] - cq[b]);
        }
    }
    const [sxx, sxy, sxz, syx, syy, syz, szx, szy, szz] = S;
    const N = new Float64Array([
        sxx + syy + szz, syz - szy, szx - sxz, sxy - syx,
        syz - szy, sxx - syy - szz, sxy + syx, szx + sxz,
        szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy,
        sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz
    ]);
    const { values, vectors } = symmetricEigen(N, 4);
    let best = 0;
    for (let i = 1; i < 4; ++i) if (values[i] > values[best]) best = i;
    // (w, x, y, z)
    const q = new Quat(vectors[1 * 4 + best], vectors[2 * 4 + best], vectors[3 * 4 + best], vectors[best]).normalize();

    const rc = q.transformVector(new Vec3(cp[0], cp[1], cp[2]));
    const t = new Vec3(cq[0] - rc.x, cq[1] - rc.y, cq[2] - rc.z);
    const matrix = new Mat4().setTRS(t, q, Vec3.ONE);

    // the fit's residual, weighted
    let se = 0;
    const p = new Vec3();
    for (let k = 0; k < count; ++k) {
        const w = W[k];
        if (!(w > 0)) continue;
        p.set(P[k * 3], P[k * 3 + 1], P[k * 3 + 2]);
        matrix.transformPoint(p, p);
        se += w * ((p.x - Q[k * 3]) ** 2 + (p.y - Q[k * 3 + 1]) ** 2 + (p.z - Q[k * 3 + 2]) ** 2);
    }
    return { matrix, rms: Math.sqrt(se / sw), weight: sw };
};

/** The plane through three points: a point on it and its unit normal, or null if they are on a line. */
const planeFrom3 = (a: Vec3, b: Vec3, c: Vec3) => {
    const n = new Vec3().cross(new Vec3().sub2(b, a), new Vec3().sub2(c, a));
    if (n.length() < 1e-12) return null;
    return { point: a.clone(), normal: n.normalize() };
};

/**
 * The dominant plane among points (world space): RANSAC for the plane most
 * of them lie near, then refined to the least-squares plane of those. For a
 * scan, that is the floor or the ground more often than not, but it is the
 * largest flat thing, whatever it is.
 */
const fitPlane = (pts: Float64Array, count: number, tolerance: number, iterations = 300) => {
    if (count < 3) return null;
    let seed = 12345;
    const rand = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
    };
    const at = (i: number, out: Vec3) => out.set(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
    const a = new Vec3();
    const b = new Vec3();
    const c = new Vec3();
    let best: { point: Vec3, normal: Vec3 } | null = null;
    let bestCount = -1;
    for (let it = 0; it < iterations; ++it) {
        at(Math.floor(rand() * count), a);
        at(Math.floor(rand() * count), b);
        at(Math.floor(rand() * count), c);
        const plane = planeFrom3(a, b, c);
        if (!plane) continue;
        const d0 = plane.normal.dot(plane.point);
        let inliers = 0;
        for (let i = 0; i < count; ++i) {
            const d = plane.normal.x * pts[i * 3] + plane.normal.y * pts[i * 3 + 1] + plane.normal.z * pts[i * 3 + 2] - d0;
            if (Math.abs(d) < tolerance) inliers++;
        }
        if (inliers > bestCount) {
            bestCount = inliers;
            best = plane;
        }
    }
    if (!best) return null;

    // least squares over the inliers: the normal is the covariance's
    // smallest eigenvector
    const d0 = best.normal.dot(best.point);
    const cen = [0, 0, 0];
    let m = 0;
    const inside: number[] = [];
    for (let i = 0; i < count; ++i) {
        const d = best.normal.x * pts[i * 3] + best.normal.y * pts[i * 3 + 1] + best.normal.z * pts[i * 3 + 2] - d0;
        if (Math.abs(d) < tolerance) {
            inside.push(i);
            for (let k = 0; k < 3; ++k) cen[k] += pts[i * 3 + k];
            m++;
        }
    }
    for (let k = 0; k < 3; ++k) cen[k] /= m;
    const C = new Float64Array(9);
    inside.forEach((i) => {
        for (let r = 0; r < 3; ++r) {
            for (let s = 0; s < 3; ++s) C[r * 3 + s] += (pts[i * 3 + r] - cen[r]) * (pts[i * 3 + s] - cen[s]);
        }
    });
    const { values, vectors } = symmetricEigen(C, 3);
    let lo = 0;
    for (let i = 1; i < 3; ++i) if (values[i] < values[lo]) lo = i;
    const normal = new Vec3(vectors[lo], vectors[3 + lo], vectors[6 + lo]).normalize();
    // the same side as the RANSAC plane's normal
    if (normal.dot(best.normal) < 0) normal.mulScalar(-1);
    return { point: new Vec3(cen[0], cen[1], cen[2]), normal, inliers: m, of: count };
};

/**
 * The rotation taking unit vector `from` onto unit vector `to`, the
 * shortest way round.
 */
const rotationBetween = (from: Vec3, to: Vec3) => {
    const d = from.dot(to);
    if (d > 1 - 1e-9) return new Quat();
    if (d < -1 + 1e-9) {
        // half a turn about any axis at right angles to `from`
        const axis = Math.abs(from.x) < 0.9 ? new Vec3(1, 0, 0) : new Vec3(0, 1, 0);
        axis.cross(axis, from).normalize();
        return new Quat().setFromAxisAngle(axis, 180);
    }
    const axis = new Vec3().cross(from, to).normalize();
    return new Quat().setFromAxisAngle(axis, Math.acos(d) * 180 / Math.PI);
};

/** A uniform grid over points, for nearest neighbours within a radius. */
class PointGrid {
    private cell: number;
    private map = new Map<string, number[]>();
    private pts: Float64Array;

    constructor(pts: Float64Array, count: number, cell: number) {
        this.pts = pts;
        this.cell = cell;
        for (let i = 0; i < count; ++i) {
            const key = this.key(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
            let list = this.map.get(key);
            if (!list) this.map.set(key, list = []);
            list.push(i);
        }
    }

    private key(x: number, y: number, z: number) {
        return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)},${Math.floor(z / this.cell)}`;
    }

    /** The nearest point within one cell of (x, y, z), and its squared distance, or -1. */
    nearest(x: number, y: number, z: number): [number, number] {
        const cx = Math.floor(x / this.cell);
        const cy = Math.floor(y / this.cell);
        const cz = Math.floor(z / this.cell);
        let best = -1;
        let bd = Infinity;
        for (let i = -1; i <= 1; ++i) {
            for (let j = -1; j <= 1; ++j) {
                for (let k = -1; k <= 1; ++k) {
                    const list = this.map.get(`${cx + i},${cy + j},${cz + k}`);
                    if (!list) continue;
                    for (const n of list) {
                        const d = (this.pts[n * 3] - x) ** 2 + (this.pts[n * 3 + 1] - y) ** 2 + (this.pts[n * 3 + 2] - z) ** 2;
                        if (d < bd) {
                            bd = d;
                            best = n;
                        }
                    }
                }
            }
        }
        return [best, bd];
    }
}

/**
 * ICP: the rigid transform that brings the moving points onto the
 * reference points (both world space), starting from `start`. Point to
 * point, nearest neighbours within `radius`, which shrinks as the fit
 * settles; pairs further apart than that are taken as not overlapping.
 */
const icp = (moving: Float64Array, nm: number, reference: Float64Array, nr: number, radius: number, start = new Mat4(), iterations = 40) => {
    const grid = new PointGrid(reference, nr, radius);
    const P = new Float64Array(nm * 3);
    const Q = new Float64Array(nm * 3);
    const W = new Float64Array(nm);
    const total = start.clone();
    const p = new Vec3();
    let r = radius;
    let last: RigidFit | null = null;
    let pairs = 0;
    for (let it = 0; it < iterations; ++it) {
        pairs = 0;
        const r2 = r * r;
        for (let k = 0; k < nm; ++k) {
            p.set(moving[k * 3], moving[k * 3 + 1], moving[k * 3 + 2]);
            total.transformPoint(p, p);
            const [n, d] = grid.nearest(p.x, p.y, p.z);
            W[k] = 0;
            if (n < 0 || d > r2) continue;
            P[k * 3] = p.x;
            P[k * 3 + 1] = p.y;
            P[k * 3 + 2] = p.z;
            Q[k * 3] = reference[n * 3];
            Q[k * 3 + 1] = reference[n * 3 + 1];
            Q[k * 3 + 2] = reference[n * 3 + 2];
            W[k] = 1;
            pairs++;
        }
        if (pairs < 6) break;
        const fit = fitRigid(P, Q, W, nm);
        if (!fit) break;
        total.mul2(fit.matrix, total);
        last = fit;
        // settle: pull the radius in towards a few times the residual
        r = Math.max(radius * 0.05, Math.min(r, fit.rms * 3));
        const moved = fit.matrix.getTranslation().length();
        if (moved < 1e-6 * radius && it > 3) break;
    }
    return { matrix: total, rms: last?.rms ?? NaN, pairs };
};

export { sampleRows, positionsAt, fitRigid, fitPlane, planeFrom3, rotationBetween, icp, symmetricEigen, type RigidFit };
