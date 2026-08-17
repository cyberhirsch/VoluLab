import { eigenSymmetric3, rotationToQuat } from './eigen';
import { NpzFile, NpyData } from './npz';

/**
 * A trained Temporal Gaussian Hierarchy checkpoint, evaluated in place.
 *
 * The checkpoint is one global set of 4D gaussians - position, time, a 4D
 * scale, an SO(4) rotation stored as a pair of quaternions, opacity and SH -
 * plus a hierarchy index saying which gaussians are alive at a given time.
 * Evaluating a frame means conditioning the active gaussians at time t:
 * a multivariate-normal conditional collapses each 4D gaussian to the 3D
 * gaussian it looks like on that frame.
 *
 * The maths mirrors GaussianModel4D.get_conditional_3d and
 * TemporalGaussianHierarchy.active_indices in the training code, including
 * their clamps and their float64 segment arithmetic, so that what VoluLab
 * shows is what the trained model says.
 */

const GLOBAL_LEVEL = -1;

type TghMeta = {
    frames: number | null;
    fps: number | null;
};

type TghFrame = {
    count: number;
    // column name -> per-gaussian values, in PLY property order
    props: Map<string, Float32Array>;
};

const toF32 = (a: NpyData, name: string): Float32Array => {
    if (a instanceof Float32Array) return a;
    if (a instanceof Float64Array) return new Float32Array(a);
    throw new Error(`Expected float data for ${name}`);
};

const toI32 = (a: NpyData, name: string): Int32Array => {
    if (a instanceof Int32Array) return a;
    if (a instanceof BigInt64Array) {
        const out = new Int32Array(a.length);
        for (let i = 0; i < a.length; i++) {
            out[i] = Number(a[i]);
        }
        return out;
    }
    throw new Error(`Expected integer data for ${name}`);
};

class TghModel {
    // total 4D gaussians in the model
    readonly numSplats: number;

    // f_rest coefficients per colour channel (15 for SH degree 3)
    readonly restCoeffs: number;

    readonly meta: TghMeta;

    // per-gaussian tensors, flat row-major
    private xyz: Float32Array;          // (N,3)
    private t: Float32Array;            // (N)   temporal mean, normalised [0,1]
    private scaling: Float32Array;      // (N,3) log spatial std
    private scalingT: Float32Array;     // (N)   log temporal std
    private rotL: Float32Array;         // (N,4) wxyz
    private rotR: Float32Array;         // (N,4) wxyz
    private opacity: Float32Array;      // (N)   logit
    private featuresDc: Float32Array;   // (N,3)
    private featuresRest: Float32Array; // (N, restCoeffs, 3) coeff-major

    // hierarchy: segment lengths in float64 (the training code's
    // active_indices floors in python floats, and S is a power-of-two
    // fraction, so converting the stored f32 values is exact)
    private segLen: Float64Array;
    private globalRows: Uint32Array;
    private segmentRows: Map<number, Uint32Array>[];

    private constructor(init: {
        xyz: Float32Array; t: Float32Array;
        scaling: Float32Array; scalingT: Float32Array;
        rotL: Float32Array; rotR: Float32Array;
        opacity: Float32Array;
        featuresDc: Float32Array; featuresRest: Float32Array;
        level: Int32Array; segment: Int32Array; segLen: Float64Array;
        meta: TghMeta;
    }) {
        const N = init.t.length;
        this.numSplats = N;
        this.restCoeffs = N ? init.featuresRest.length / N / 3 : 0;
        this.meta = init.meta;

        this.xyz = init.xyz;
        this.t = init.t;
        this.scaling = init.scaling;
        this.scalingT = init.scalingT;
        this.rotL = init.rotL;
        this.rotR = init.rotR;
        this.opacity = init.opacity;
        this.featuresDc = init.featuresDc;
        this.featuresRest = init.featuresRest;
        this.segLen = init.segLen;

        // index rows by (level, segment), preserving ascending row order to
        // match the training code's active_indices output exactly
        const { level, segment } = init;
        const numLevels = this.segLen.length;

        const counts: Map<number, number>[] = [];
        for (let l = 0; l < numLevels; l++) counts.push(new Map());
        let numGlobal = 0;

        for (let i = 0; i < N; i++) {
            if (level[i] === GLOBAL_LEVEL) {
                numGlobal++;
            } else {
                const m = counts[level[i]];
                m.set(segment[i], (m.get(segment[i]) ?? 0) + 1);
            }
        }

        this.globalRows = new Uint32Array(numGlobal);
        this.segmentRows = counts.map((m) => {
            const rows = new Map<number, Uint32Array>();
            m.forEach((count, seg) => rows.set(seg, new Uint32Array(count)));
            return rows;
        });

        let globalCursor = 0;
        const cursors: Map<number, number>[] = counts.map(() => new Map());
        for (let i = 0; i < N; i++) {
            if (level[i] === GLOBAL_LEVEL) {
                this.globalRows[globalCursor++] = i;
            } else {
                const cursor = cursors[level[i]];
                const at = cursor.get(segment[i]) ?? 0;
                this.segmentRows[level[i]].get(segment[i])[at] = i;
                cursor.set(segment[i], at + 1);
            }
        }
    }

    static async fromNpz(blob: Blob): Promise<TghModel> {
        const npz = NpzFile.open(blob);
        try {
            const keys = await npz.list();
            const find = (scope: string, name: string) => {
                return keys.find(k => k === name || k.endsWith(`${scope}.${name}`));
            };
            const read = async (scope: string, name: string) => {
                const key = find(scope, name);
                if (!key) {
                    throw new Error(`Not a TGH checkpoint: missing ${scope}.${name}`);
                }
                return await npz.read(key);
            };

            const g = (name: string) => read('gaussians', name);
            const h = (name: string) => read('hierarchy', name);

            let meta: TghMeta = { frames: null, fps: null };
            const metaKey = keys.find(k => k === 'volulab.meta');
            if (metaKey) {
                const m = toF32((await npz.read(metaKey)).data, metaKey);
                meta = {
                    frames: m.length > 0 && m[0] > 0 ? Math.round(m[0]) : null,
                    fps: m.length > 1 && m[1] > 0 ? m[1] : null
                };
            }

            const segLenF = toF32((await h('seg_len')).data, 'seg_len');

            return new TghModel({
                xyz: toF32((await g('_xyz')).data, '_xyz'),
                t: toF32((await g('_t')).data, '_t'),
                scaling: toF32((await g('_scaling')).data, '_scaling'),
                scalingT: toF32((await g('_scaling_t')).data, '_scaling_t'),
                rotL: toF32((await g('_rotation_l')).data, '_rotation_l'),
                rotR: toF32((await g('_rotation_r')).data, '_rotation_r'),
                opacity: toF32((await g('_opacity')).data, '_opacity'),
                featuresDc: toF32((await g('_features_dc')).data, '_features_dc'),
                featuresRest: toF32((await g('_features_rest')).data, '_features_rest'),
                level: toI32((await h('level')).data, 'level'),
                segment: toI32((await h('segment')).data, 'segment'),
                segLen: Float64Array.from(segLenF),
                meta
            });
        } finally {
            npz.close();
        }
    }

    /**
     * Global row indices of the gaussians alive at normalised time t:
     * the global segment, then one segment per level, finest last.
     */
    activeIndices(t: number): Uint32Array {
        const pieces: Uint32Array[] = [];
        if (this.globalRows.length > 0) {
            pieces.push(this.globalRows);
        }
        for (let l = 0; l < this.segLen.length; l++) {
            const rows = this.segmentRows[l].get(Math.floor(t / this.segLen[l]));
            if (rows && rows.length > 0) {
                pieces.push(rows);
            }
        }

        const total = pieces.reduce((a, p) => a + p.length, 0);
        const out = new Uint32Array(total);
        let at = 0;
        for (const p of pieces) {
            out.set(p, at);
            at += p.length;
        }
        return out;
    }

    /**
     * Evaluate the model at normalised time t, producing the columns of a
     * plain 3D gaussian set in PLY convention: log-scales, wxyz rotation,
     * logit opacity, channel-major SH.
     */
    evalFrame(t: number): TghFrame {
        const idx = this.activeIndices(t);
        const M = idx.length;
        const K = this.restCoeffs;

        const names = ['x', 'y', 'z'];
        for (let c = 0; c < 3; c++) names.push(`f_dc_${c}`);
        for (let c = 0; c < 3 * K; c++) names.push(`f_rest_${c}`);
        names.push('opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3');

        const props = new Map<string, Float32Array>();
        names.forEach(n => props.set(n, new Float32Array(M)));

        const x = props.get('x'), y = props.get('y'), z = props.get('z');
        const op = props.get('opacity');
        const scales = [props.get('scale_0'), props.get('scale_1'), props.get('scale_2')];
        const dc = [props.get('f_dc_0'), props.get('f_dc_1'), props.get('f_dc_2')];
        const rest: Float32Array[] = [];
        for (let c = 0; c < 3 * K; c++) rest.push(props.get(`f_rest_${c}`));
        const rot = props.get('rot_0');
        const rots = [rot, props.get('rot_1'), props.get('rot_2'), props.get('rot_3')];

        const L = new Float64Array(16);
        const R = new Float64Array(16);
        const R4 = new Float64Array(16);
        const s2 = new Float64Array(4);
        const sigma = new Float64Array(16);
        const quat = new Float32Array(4);

        for (let i = 0; i < M; i++) {
            const n = idx[i];

            // normalised quaternion pair -> 4D rotation R4 = L(ql) @ R(qr)
            let a = this.rotL[n * 4], b = this.rotL[n * 4 + 1], c = this.rotL[n * 4 + 2], d = this.rotL[n * 4 + 3];
            let inv = 1 / Math.sqrt(a * a + b * b + c * c + d * d);
            a *= inv; b *= inv; c *= inv; d *= inv;
            L[0] = a; L[1] = -b; L[2] = -c; L[3] = -d;
            L[4] = b; L[5] = a; L[6] = -d; L[7] = c;
            L[8] = c; L[9] = d; L[10] = a; L[11] = -b;
            L[12] = d; L[13] = -c; L[14] = b; L[15] = a;

            let p = this.rotR[n * 4], q = this.rotR[n * 4 + 1], r = this.rotR[n * 4 + 2], s = this.rotR[n * 4 + 3];
            inv = 1 / Math.sqrt(p * p + q * q + r * r + s * s);
            p *= inv; q *= inv; r *= inv; s *= inv;
            R[0] = p; R[1] = -q; R[2] = -r; R[3] = -s;
            R[4] = q; R[5] = p; R[6] = s; R[7] = -r;
            R[8] = r; R[9] = -s; R[10] = p; R[11] = q;
            R[12] = s; R[13] = r; R[14] = -q; R[15] = p;

            for (let row = 0; row < 4; row++) {
                for (let col = 0; col < 4; col++) {
                    R4[row * 4 + col] =
                        L[row * 4] * R[col] +
                        L[row * 4 + 1] * R[4 + col] +
                        L[row * 4 + 2] * R[8 + col] +
                        L[row * 4 + 3] * R[12 + col];
                }
            }

            // squared 4D scales
            s2[0] = Math.exp(2 * this.scaling[n * 3]);
            s2[1] = Math.exp(2 * this.scaling[n * 3 + 1]);
            s2[2] = Math.exp(2 * this.scaling[n * 3 + 2]);
            s2[3] = Math.exp(2 * this.scalingT[n]);

            // Sigma4 = R4 diag(s2) R4^T, symmetric
            for (let row = 0; row < 4; row++) {
                for (let col = row; col < 4; col++) {
                    sigma[row * 4 + col] =
                        R4[row * 4] * s2[0] * R4[col * 4] +
                        R4[row * 4 + 1] * s2[1] * R4[col * 4 + 1] +
                        R4[row * 4 + 2] * s2[2] * R4[col * 4 + 2] +
                        R4[row * 4 + 3] * s2[3] * R4[col * 4 + 3];
                }
            }

            // condition on time, with the training code's variance clamp
            const varT = Math.max(sigma[15], 1e-12);
            const invTT = 1 / varT;
            const dt = t - this.t[n];

            x[i] = this.xyz[n * 3] + sigma[3] * invTT * dt;
            y[i] = this.xyz[n * 3 + 1] + sigma[7] * invTT * dt;
            z[i] = this.xyz[n * 3 + 2] + sigma[11] * invTT * dt;

            const cxx = sigma[0] - sigma[3] * sigma[3] * invTT;
            const cxy = sigma[1] - sigma[3] * sigma[7] * invTT;
            const cxz = sigma[2] - sigma[3] * sigma[11] * invTT;
            const cyy = sigma[5] - sigma[7] * sigma[7] * invTT;
            const cyz = sigma[6] - sigma[7] * sigma[11] * invTT;
            const czz = sigma[10] - sigma[11] * sigma[11] * invTT;

            // covariance -> log-scales + rotation
            const eig = eigenSymmetric3(cxx, cxy, cxz, cyy, cyz, czz);
            scales[0][i] = 0.5 * Math.log(Math.max(eig.values[0], 1e-18));
            scales[1][i] = 0.5 * Math.log(Math.max(eig.values[1], 1e-18));
            scales[2][i] = 0.5 * Math.log(Math.max(eig.values[2], 1e-18));
            rotationToQuat(eig.vectors, quat, 0);
            rots[0][i] = quat[0];
            rots[1][i] = quat[1];
            rots[2][i] = quat[2];
            rots[3][i] = quat[3];

            // linear alpha (temporal falloff applied) -> stored logit
            const alphaRaw = (1 / (1 + Math.exp(-this.opacity[n]))) * Math.exp(-0.5 * dt * dt * invTT);
            const alpha = Math.min(1 - 1e-6, Math.max(1e-6, alphaRaw));
            op[i] = Math.log(alpha / (1 - alpha));

            // SH: dc straight through, rest transposed to channel-major
            dc[0][i] = this.featuresDc[n * 3];
            dc[1][i] = this.featuresDc[n * 3 + 1];
            dc[2][i] = this.featuresDc[n * 3 + 2];
            const base = n * K * 3;
            for (let k = 0; k < K; k++) {
                rest[k][i] = this.featuresRest[base + k * 3];
                rest[K + k][i] = this.featuresRest[base + k * 3 + 1];
                rest[2 * K + k][i] = this.featuresRest[base + k * 3 + 2];
            }
        }

        return { count: M, props };
    }
}

export { TghModel, type TghFrame, type TghMeta };
