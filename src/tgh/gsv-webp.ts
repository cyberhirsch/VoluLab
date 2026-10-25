import { WebPCodec } from '@playcanvas/splat-transform';

import { kmeansGpu } from './kmeans-gpu';
import { ZipEntry } from '../io/write/stored-zip';

/**
 * GSV's compact encoding (docs/format-gsv.md, section 7.2): a page's
 * attributes as RGBA images saved as lossless WebP, one texel per
 * primitive, with codebooks shared by the whole file.
 *
 * The primitives are stored in motion form: a conditioned 4D gaussian is
 * a 3D gaussian of fixed shape moving at constant velocity, so each one is
 * written as that 3D gaussian - SOG's layout, the same position transform,
 * smallest-three quaternion and SH palette - plus its time, temporal scale
 * and velocity. Quantising the 4D rotation instead does not survive: on a
 * very elongated gaussian an 8-bit rotation error tips its long axis into
 * time, which reads as a spurious velocity, and measured on a real capture
 * moved some visible gaussians by a third of the scene.
 */

/** A page's attributes in motion form, rows in file order. */
type MotionPage = {
    mean: Float32Array;         // N x 4: x, y, z, t
    logScale: Float32Array;     // N x 4: conditional 3D log std (3), log temporal std
    rot: Float32Array;          // N x 4, wxyz, of the conditional 3D covariance
    velocity: Float32Array;     // N x 3, per unit of normalised time
    opacity: Float32Array;      // N, logit
    sh: Float32Array;           // N x (3 + 3K): dc, then each rest coefficient's r, g, b
};

type WebpPageInfo = {
    width: number;
    mins: number[];
    maxs: number[];
    timeRange: [number, number];
    velMins: number[];
    velMaxs: number[];
};

type WebpCodebooks = {
    scale: number[];
    timeScale: number[];
    colour: number[];
    sh?: number[];
    shN?: { count: number, file: string };
};

const CODEBOOK_SIZE = 256;
const MAX_PALETTE = 65536;
const PALETTE_ROW = 64;            // centroids per row of the palette texture
const SQRT2 = Math.SQRT2;

// libwebp drops the colour of fully transparent texels unless an explicit
// effort is given - and alpha here is data (a time byte), so 0 is common
const EFFORT = 4;

// SOG's position transform: fine near the origin, coarse far out
const logTransform = (v: number) => Math.sign(v) * Math.log(Math.abs(v) + 1);
const invLogTransform = (v: number) => Math.sign(v) * (Math.exp(Math.abs(v)) - 1);

const sigmoid = (v: number) => 1 / (1 + Math.exp(-v));
const logit = (p: number) => {
    const e = Math.min(1 - 1e-6, Math.max(1e-6, p));
    return Math.log(e / (1 - e));
};

/**
 * A 1D codebook: k centroids, ascending, by Lloyd's algorithm on a sorted
 * sample - every cell is a contiguous run of the sorted values, so each
 * iteration is k binary searches and prefix-sum means.
 */
const codebook1d = (values: Float32Array, k = CODEBOOK_SIZE): Float32Array => {
    const step = Math.max(1, Math.floor(values.length / 2_000_000));
    const picked: number[] = [];
    for (let i = 0; i < values.length; i += step) {
        if (Number.isFinite(values[i])) picked.push(values[i]);
    }
    const out = new Float32Array(k);
    if (picked.length === 0) return out;

    const sorted = Float64Array.from(picked).sort();
    const m = sorted.length;
    const prefix = new Float64Array(m + 1);
    for (let i = 0; i < m; i++) prefix[i + 1] = prefix[i] + sorted[i];

    // first index whose value is above v
    const upper = (v: number) => {
        let lo = 0, hi = m;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (sorted[mid] <= v) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };

    const c = new Float64Array(k);
    for (let i = 0; i < k; i++) c[i] = sorted[Math.min(m - 1, Math.floor(((i + 0.5) / k) * m))];

    for (let it = 0; it < 24; it++) {
        let start = 0;
        for (let i = 0; i < k; i++) {
            const end = i < k - 1 ? upper((c[i] + c[i + 1]) * 0.5) : m;
            if (end > start) c[i] = (prefix[end] - prefix[start]) / (end - start);
            start = Math.max(start, end);
        }
        c.sort();
    }
    out.set(c);
    return out;
};

/**
 * k evenly spaced values over the range of `values`, as a codebook. Used
 * for the spatial log-scales: a Lloyd codebook minimises the mean error and
 * so leaves the sparse tail of large splats with size errors up to e^4,
 * and those few large splats dominate the image; even spacing bounds every
 * error by half a step.
 */
const uniformCodebook = (values: Float32Array, k = CODEBOOK_SIZE): Float32Array => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
    }
    const out = new Float32Array(k);
    if (!(hi >= lo)) return out;
    for (let i = 0; i < k; i++) out[i] = lo + ((hi - lo) * i) / (k - 1);
    return out;
};

/** The index of the codebook entry nearest v (codebook ascending). */
const nearest = (codebook: Float32Array, v: number) => {
    if (!(v > codebook[0])) return 0;               // also catches NaN
    const last = codebook.length - 1;
    if (v >= codebook[last]) return last;
    let lo = 0, hi = last;
    while (hi - lo > 1) {
        const mid = (lo + hi) >>> 1;
        if (codebook[mid] <= v) lo = mid;
        else hi = mid;
    }
    return v - codebook[lo] <= codebook[hi] - v ? lo : hi;
};

// which components follow the largest one, as SOG orders them
const QUAT_IDX = [1, 2, 3, 2, 3, 0, 3, 0, 1, 0, 1, 2];

/** Smallest-three: a wxyz quaternion into 3 bytes and a tag. */
const packQuat = (q: Float32Array, i: number, out: Uint8Array, o: number) => {
    let w = q[i], x = q[i + 1], y = q[i + 2], z = q[i + 3];
    const len = Math.hypot(w, x, y, z) || 1;
    w /= len; x /= len; y /= len; z /= len;
    const c = [w, x, y, z];
    let max = 0;
    for (let j = 1; j < 4; j++) {
        if (Math.abs(c[j]) > Math.abs(c[max])) max = j;
    }
    // the dropped component comes back positive; q and -q are one rotation
    const sign = c[max] < 0 ? -1 : 1;
    for (let j = 0; j < 3; j++) {
        const v = c[QUAT_IDX[max * 3 + j]] * sign * SQRT2;
        out[o + j] = Math.max(0, Math.min(255, Math.round((v * 0.5 + 0.5) * 255)));
    }
    out[o + 3] = 252 + max;
};

const unpackQuat = (tex: Uint8Array, o: number, out: Float32Array, i: number) => {
    const max = tex[o + 3] - 252;
    let sum = 0;
    for (let j = 0; j < 4; j++) out[i + j] = 0;
    for (let j = 0; j < 3; j++) {
        const v = ((tex[o + j] / 255) * 2 - 1) / SQRT2;
        out[i + QUAT_IDX[max * 3 + j]] = v;
        sum += v * v;
    }
    out[i + max] = Math.sqrt(Math.max(0, 1 - sum));
};

const pageWidth = (count: number) => Math.max(1, Math.ceil(Math.sqrt(count)));

const q16 = (v: number, lo: number, hi: number) => {
    const range = hi - lo;
    return range > 0 ? Math.max(0, Math.min(65535, Math.round(((v - lo) / range) * 65535))) : 0;
};

type EncodeOptions = {
    device: GPUDevice;
    // SH palette size; defaults to 65 536, or one per primitive if fewer
    paletteSize?: number;
};

/**
 * Encode every page. Codebooks and the SH palette are fitted on all pages
 * together, so this sees the whole model before it writes anything.
 */
const encodeWebpPages = async (pages: { id: string, data: MotionPage }[], K: number, options: EncodeOptions) => {
    const codec = await WebPCodec.create();
    const shStride = 3 + 3 * K;
    const total = pages.reduce((sum, p) => sum + p.data.opacity.length, 0);

    // pooled values for the 1D codebooks
    const spatial = new Float32Array(total * 3);
    const temporal = new Float32Array(total);
    const colour = new Float32Array(total * 3);
    let at = 0;
    for (const { data } of pages) {
        const n = data.opacity.length;
        for (let i = 0; i < n; i++, at++) {
            spatial[at * 3] = data.logScale[i * 4];
            spatial[at * 3 + 1] = data.logScale[i * 4 + 1];
            spatial[at * 3 + 2] = data.logScale[i * 4 + 2];
            temporal[at] = data.logScale[i * 4 + 3];
            colour[at * 3] = data.sh[i * shStride];
            colour[at * 3 + 1] = data.sh[i * shStride + 1];
            colour[at * 3 + 2] = data.sh[i * shStride + 2];
        }
    }
    const scaleBook = uniformCodebook(spatial);
    const timeScaleBook = codebook1d(temporal);
    const colourBook = codebook1d(colour);

    const files: ZipEntry[] = [];
    const codebooks: WebpCodebooks = {
        scale: Array.from(scaleBook),
        timeScale: Array.from(timeScaleBook),
        colour: Array.from(colourBook)
    };

    // the SH palette: every primitive's rest coefficients clustered
    let labels: Uint32Array | null = null;
    if (K > 0) {
        const dim = 3 * K;
        const rest = new Float32Array(total * dim);
        at = 0;
        for (const { data } of pages) {
            const n = data.opacity.length;
            for (let i = 0; i < n; i++, at++) {
                rest.set(data.sh.subarray(i * shStride + 3, (i + 1) * shStride), at * dim);
            }
        }
        const k = Math.min(options.paletteSize ?? MAX_PALETTE, MAX_PALETTE, total);
        const clustered = await kmeansGpu(options.device, rest, dim, k);
        labels = clustered.labels;

        const shBook = codebook1d(clustered.centroids);
        codebooks.sh = Array.from(shBook);

        // one row per PALETTE_ROW centroids, one texel per coefficient: its
        // r, g, b as codebook indices
        const width = PALETTE_ROW * K;
        const height = Math.ceil(clustered.k / PALETTE_ROW);
        const tex = new Uint8Array(width * height * 4);
        for (let c = 0; c < clustered.k; c++) {
            const row = Math.floor(c / PALETTE_ROW);
            const col = (c % PALETTE_ROW) * K;
            for (let j = 0; j < K; j++) {
                const o = (row * width + col + j) * 4;
                tex[o] = nearest(shBook, clustered.centroids[c * dim + j * 3]);
                tex[o + 1] = nearest(shBook, clustered.centroids[c * dim + j * 3 + 1]);
                tex[o + 2] = nearest(shBook, clustered.centroids[c * dim + j * 3 + 2]);
                tex[o + 3] = 255;
            }
        }
        files.push({ name: 'shN_centroids.webp', data: codec.encodeLosslessRGBA(tex, width, height, width * 4, EFFORT) });
        codebooks.shN = { count: clustered.k, file: 'shN_centroids.webp' };
    }

    const info = new Map<string, WebpPageInfo>();
    let labelAt = 0;
    for (const { id, data } of pages) {
        const n = data.opacity.length;
        const width = pageWidth(n);
        const height = Math.ceil(n / width);
        const texel = width * height * 4;

        // per-page position, time and velocity ranges
        const mins = [Infinity, Infinity, Infinity];
        const maxs = [-Infinity, -Infinity, -Infinity];
        const velMins = [Infinity, Infinity, Infinity];
        const velMaxs = [-Infinity, -Infinity, -Infinity];
        let tLo = Infinity, tHi = -Infinity;
        for (let i = 0; i < n; i++) {
            for (let a = 0; a < 3; a++) {
                const v = logTransform(data.mean[i * 4 + a]);
                if (v < mins[a]) mins[a] = v;
                if (v > maxs[a]) maxs[a] = v;
                const u = logTransform(data.velocity[i * 3 + a]);
                if (u < velMins[a]) velMins[a] = u;
                if (u > velMaxs[a]) velMaxs[a] = u;
            }
            const t = data.mean[i * 4 + 3];
            if (t < tLo) tLo = t;
            if (t > tHi) tHi = t;
        }
        if (n === 0) {
            [mins, maxs, velMins, velMaxs].forEach(r => r.fill(0));
            tLo = tHi = 0;
        }

        const meansL = new Uint8Array(texel);
        const meansU = new Uint8Array(texel);
        const scales = new Uint8Array(texel);
        const rot = new Uint8Array(texel);
        const velL = new Uint8Array(texel);
        const velU = new Uint8Array(texel);
        const sh0 = new Uint8Array(texel);
        const shLabels = labels ? new Uint8Array(texel) : null;

        for (let i = 0; i < n; i++) {
            const o = i * 4;
            for (let a = 0; a < 3; a++) {
                const q = q16(logTransform(data.mean[o + a]), mins[a], maxs[a]);
                meansL[o + a] = q & 255;
                meansU[o + a] = q >> 8;
            }
            const qt = q16(data.mean[o + 3], tLo, tHi);
            meansL[o + 3] = qt & 255;
            meansU[o + 3] = qt >> 8;

            scales[o] = nearest(scaleBook, data.logScale[o]);
            scales[o + 1] = nearest(scaleBook, data.logScale[o + 1]);
            scales[o + 2] = nearest(scaleBook, data.logScale[o + 2]);
            scales[o + 3] = nearest(timeScaleBook, data.logScale[o + 3]);

            packQuat(data.rot, o, rot, o);

            for (let a = 0; a < 3; a++) {
                const q = q16(logTransform(data.velocity[i * 3 + a]), velMins[a], velMaxs[a]);
                velL[o + a] = q & 255;
                velU[o + a] = q >> 8;
            }
            velL[o + 3] = 255;
            velU[o + 3] = 255;

            sh0[o] = nearest(colourBook, data.sh[i * shStride]);
            sh0[o + 1] = nearest(colourBook, data.sh[i * shStride + 1]);
            sh0[o + 2] = nearest(colourBook, data.sh[i * shStride + 2]);
            sh0[o + 3] = Math.round(255 * sigmoid(data.opacity[i]));

            if (shLabels) {
                const label = labels[labelAt + i];
                shLabels[o] = label & 255;
                shLabels[o + 1] = label >> 8;
                shLabels[o + 3] = 255;
            }
        }
        labelAt += n;

        const encode = (name: string, tex: Uint8Array) => {
            files.push({ name: `${id}/${name}`, data: codec.encodeLosslessRGBA(tex, width, height, width * 4, EFFORT) });
        };
        encode('means_l.webp', meansL);
        encode('means_u.webp', meansU);
        encode('scales.webp', scales);
        encode('rot.webp', rot);
        encode('vel_l.webp', velL);
        encode('vel_u.webp', velU);
        encode('sh0.webp', sh0);
        if (shLabels) encode('shN_labels.webp', shLabels);

        info.set(id, { width, mins, maxs, timeRange: [tLo, tHi], velMins, velMaxs });
    }

    return { files, codebooks, info };
};

type ReadEntry = (name: string) => Promise<Uint8Array>;

/** The SH palette, decoded once for every page. */
const decodePalette = async (read: ReadEntry, codebooks: WebpCodebooks, K: number) => {
    if (K === 0 || !codebooks.shN) return null;
    const codec = await WebPCodec.create();
    const { rgba, width } = codec.decodeRGBA(await read(codebooks.shN.file));
    if (width !== PALETTE_ROW * K) {
        throw new Error(`GSV: SH palette is ${width} texels wide, expected ${PALETTE_ROW * K}`);
    }
    const shBook = Float32Array.from(codebooks.sh);
    const dim = 3 * K;
    const count = codebooks.shN.count;
    const palette = new Float32Array(count * dim);
    for (let c = 0; c < count; c++) {
        const row = Math.floor(c / PALETTE_ROW);
        const col = (c % PALETTE_ROW) * K;
        for (let j = 0; j < K; j++) {
            const o = (row * width + col + j) * 4;
            palette[c * dim + j * 3] = shBook[rgba[o]];
            palette[c * dim + j * 3 + 1] = shBook[rgba[o + 1]];
            palette[c * dim + j * 3 + 2] = shBook[rgba[o + 2]];
        }
    }
    return palette;
};

const decodeWebpPage = async (read: ReadEntry, id: string, count: number, page: WebpPageInfo, codebooks: WebpCodebooks, K: number, palette: Float32Array | null): Promise<MotionPage> => {
    const codec = await WebPCodec.create();
    const tex = async (name: string) => {
        const { rgba, width, height } = codec.decodeRGBA(await read(`${id}/${name}`));
        if (width * height < count) {
            throw new Error(`GSV page ${id}: ${name} holds ${width * height} texels for ${count} primitives`);
        }
        return rgba;
    };

    const meansL = await tex('means_l.webp');
    const meansU = await tex('means_u.webp');
    const scales = await tex('scales.webp');
    const rotTex = await tex('rot.webp');
    const velL = await tex('vel_l.webp');
    const velU = await tex('vel_u.webp');
    const sh0 = await tex('sh0.webp');
    const shLabels = K > 0 ? await tex('shN_labels.webp') : null;

    const scaleBook = Float32Array.from(codebooks.scale);
    const timeScaleBook = Float32Array.from(codebooks.timeScale);
    const colourBook = Float32Array.from(codebooks.colour);
    const shStride = 3 + 3 * K;
    const dim = 3 * K;
    const [tLo, tHi] = page.timeRange;

    const data: MotionPage = {
        mean: new Float32Array(count * 4),
        logScale: new Float32Array(count * 4),
        rot: new Float32Array(count * 4),
        velocity: new Float32Array(count * 3),
        opacity: new Float32Array(count),
        sh: new Float32Array(count * shStride)
    };

    for (let i = 0; i < count; i++) {
        const o = i * 4;
        for (let a = 0; a < 3; a++) {
            const q = meansL[o + a] | (meansU[o + a] << 8);
            data.mean[o + a] = invLogTransform(page.mins[a] + (page.maxs[a] - page.mins[a]) * (q / 65535));
        }
        const qt = meansL[o + 3] | (meansU[o + 3] << 8);
        data.mean[o + 3] = tLo + (tHi - tLo) * (qt / 65535);

        data.logScale[o] = scaleBook[scales[o]];
        data.logScale[o + 1] = scaleBook[scales[o + 1]];
        data.logScale[o + 2] = scaleBook[scales[o + 2]];
        data.logScale[o + 3] = timeScaleBook[scales[o + 3]];

        unpackQuat(rotTex, o, data.rot, o);
        for (let a = 0; a < 3; a++) {
            const q = velL[o + a] | (velU[o + a] << 8);
            data.velocity[i * 3 + a] = invLogTransform(page.velMins[a] + (page.velMaxs[a] - page.velMins[a]) * (q / 65535));
        }

        data.sh[i * shStride] = colourBook[sh0[o]];
        data.sh[i * shStride + 1] = colourBook[sh0[o + 1]];
        data.sh[i * shStride + 2] = colourBook[sh0[o + 2]];
        data.opacity[i] = logit(sh0[o + 3] / 255);

        if (shLabels && palette) {
            const label = shLabels[o] | (shLabels[o + 1] << 8);
            data.sh.set(palette.subarray(label * dim, (label + 1) * dim), i * shStride + 3);
        }
    }
    return data;
};

export { decodePalette, decodeWebpPage, encodeWebpPages, type MotionPage, type WebpCodebooks, type WebpPageInfo };
