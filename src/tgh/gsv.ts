import { ZipReadFileSystem } from '@playcanvas/splat-transform';

import { checkCodebooks, decodePalette, decodeWebpPage, encodeWebpPages, MotionPage, WebpCodebooks, WebpPageInfo } from './gsv-webp';
import { TghModel } from './tgh-model';
import { version } from '../../package.json';
import { BlobReadSource } from '../io';
import { storedZip, ZipEntry } from '../io/write/stored-zip';

/**
 * GSV (Gaussian Splat Video): writing a TGH model out and reading it back,
 * in either encoding. See docs/format-gsv.md.
 *
 * f32 is the lossless encoding, so a model survives the round trip bit for
 * bit; webp (gsv-webp.ts) is the compact one. Rows are written block by block in the order TghModel.activeIndices
 * concatenates them - the global set, then each level's segments in
 * ascending order - so a model read back conditions every frame into the
 * same gaussians in the same order as the one written. The webp encoding
 * stores the motion form (see gsv-webp.ts) and puts each block's rows in
 * Morton order, by default: the same gaussians, in another order.
 *
 * Blocks are grouped into pages by time window: one page for the global
 * set, and one per segment of the coarsest level, holding every finer
 * segment that starts inside it. A player fetching the pages around the
 * playhead then fetches about one window's worth.
 *
 * The static set. A TGH model has none: what stands still in it is a
 * global gaussian that does not move and outlives the sequence. The
 * writer moves those to a static page as plain 3D gaussians (their
 * conditional covariance, which is what was drawn all along), and the
 * reader brings a static page back as exactly such global gaussians,
 * first in the model, so they are first in the active set.
 */

const GLOBAL_LEVEL = -1;

const STATIC_PAGE = 'static';

// the temporal mean and log temporal std a static gaussian is given in the
// model: its lifetime falloff over the sequence is 1 to float precision
const STATIC_T = 0.5;
const STATIC_LOG_STD_T = Math.log(1e4);

// a global gaussian is static when, over the whole sequence, it moves less
// than this fraction of its own thinnest extent (one std) ...
const STATIC_MAX_DRIFT = 1e-3;
// ... and its lifetime falloff never takes more than half an 8-bit opacity step
const STATIC_MIN_FALLOFF = 1 - 1 / 510;

const sigmoid = (v: number) => 1 / (1 + Math.exp(-v));
const logit = (p: number) => Math.log(p / (1 - p));

// the lifetime falloff of a gaussian with temporal mean mu and std sd, at
// its lowest over the sequence and on average over it
const falloffOver = (mu: number, sd: number) => {
    const at = (t: number) => Math.exp(-0.5 * ((t - mu) / sd) ** 2);
    const lowest = Math.min(at(0), at(1));
    let sum = 0;
    for (let i = 0; i <= 16; i++) sum += at(i / 16);
    return { lowest, mean: sum / 17 };
};

/**
 * The rule the static set is picked by, for whoever else has to tell what
 * stands still (the debug view colours by it). `motion` is the gaussian in
 * motion form (TghModel.motionParams), `t` its temporal centre. The writer
 * asks it of global gaussians only.
 */
const standsStill = (motion: Float32Array, t: number) => {
    const drift = Math.hypot(motion[0], motion[1], motion[2]);
    const thinnest = Math.exp(Math.min(motion[3], motion[4], motion[5]));
    return drift <= STATIC_MAX_DRIFT * thinnest && falloffOver(t, Math.exp(motion[10])).lowest >= STATIC_MIN_FALLOFF;
};

// spherical-harmonic rest coefficients per channel, by band count
const REST_COEFFS = [0, 3, 8, 15];

type GsvPage = {
    id: string;
    kind: 'dynamic' | 'static';
    encoding: string;
    count: number;
    tMin?: number;
    tMax?: number;
    // webp encoding: texture width, position and time quantisation ranges
    width?: number;
    mins?: number[];
    maxs?: number[];
    timeRange?: [number, number];
    velMins?: number[];
    velMaxs?: number[];
};

/** A static page's attributes: plain 3D gaussians, rows in file order. */
type StaticPage = {
    mean: Float32Array;         // N x 3
    logScale: Float32Array;     // N x 3
    rot: Float32Array;          // N x 4, wxyz
    opacity: Float32Array;      // N, logit
    sh: Float32Array;           // N x (3 + 3K)
};

type GsvBlock = {
    level: number;
    segment?: number;
    page: string;
    start: number;
    count: number;
};

type GsvMeta = {
    asset: { format: string, version: string, generator?: string };
    time?: { frames?: number, fps?: number, duration?: number };
    space?: { up: 'z' };
    sh: { bands: number };
    codebooks?: WebpCodebooks;
    levels: number[];
    pages: GsvPage[];
    blocks: GsvBlock[];
    extensionsUsed?: string[];
    extensionsRequired?: string[];
};

type GsvTimeline = {
    frames: number | null;
    fps: number | null;
    zUp: boolean;
};

// the f32 buffers are little-endian; the typed arrays are the platform's
const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

const requireLittleEndian = () => {
    if (!littleEndian) {
        throw new Error('GSV f32 needs a little-endian platform');
    }
};

const bytesOf = (a: Float32Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

/** A page's attributes in the checkpoint's form, rows in file order. */
type F32Page = {
    mean: Float32Array;         // N x 4: x, y, z, t
    logScale: Float32Array;     // N x 4: sx, sy, sz, st
    rotL: Float32Array;         // N x 4, wxyz
    rotR: Float32Array;         // N x 4, wxyz
    opacity: Float32Array;      // N, logit
    sh: Float32Array;           // N x (3 + 3K): dc, then each rest coefficient's r, g, b
};

// Morton order of a block's rows: neighbours in space become neighbours in
// the textures, which WebP compresses better and sorting likes
const mortonOrder = (rows: Uint32Array, xyz: Float32Array): Uint32Array => {
    const n = rows.length;
    if (n < 2) return rows;
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++) {
        for (let a = 0; a < 3; a++) {
            const v = xyz[rows[i] * 3 + a];
            if (v < lo[a]) lo[a] = v;
            if (v > hi[a]) hi[a] = v;
        }
    }
    // spread 10 bits two apart, for interleaving three axes into 30
    const part = (v: number) => {
        v &= 0x3ff;
        v = (v | (v << 16)) & 0x30000ff;
        v = (v | (v << 8)) & 0x300f00f;
        v = (v | (v << 4)) & 0x30c30c3;
        v = (v | (v << 2)) & 0x9249249;
        return v;
    };
    const codes = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
        let code = 0;
        for (let a = 0; a < 3; a++) {
            const range = hi[a] - lo[a];
            const q = range > 0 ? Math.min(1023, Math.floor(((xyz[rows[i] * 3 + a] - lo[a]) / range) * 1024)) : 0;
            code |= part(q) << a;
        }
        codes[i] = code >>> 0;
    }
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => codes[a] - codes[b] || a - b);
    return Uint32Array.from(order, i => rows[i]);
};

type WriteOptions = {
    encoding?: 'f32' | 'webp';
    // required for webp: the SH palette is clustered on the GPU
    device?: GPUDevice;
    // webp only: each block's rows in Morton order (the default), or as the model has them
    mortonOrder?: boolean;
    // move global gaussians that stand still for the whole sequence to a
    // static page (the default), or keep every gaussian dynamic
    staticSet?: boolean;
    // Colours to write in the model's place, a row per row of the model: a
    // DC term each, with every band above it zero - a debug view's false
    // colours (see bakeDebugColor) - and the opacity logits that go with
    // them, where those differ from the model's.
    colour?: { dc: Float32Array, opacity: Float32Array | null };
};

/** A TGH model as a GSV file. */
const writeGsv = async (model: TghModel, timeline: GsvTimeline, options: WriteOptions = {}): Promise<Uint8Array> => {
    requireLittleEndian();
    const encoding = options.encoding ?? 'f32';
    if (encoding === 'webp' && !options.device) {
        throw new Error('the compact GSV encoding needs WebGPU');
    }
    const morton = encoding === 'webp' && (options.mortonOrder ?? true);
    if (encoding === 'f32' && model.isMotionForm) {
        // its 4D rotations were not kept; the compact encoding is all it has
        throw new Error('a model read from a compact GSV can only be written compact again');
    }

    const src = model.tensors;
    // the colour written: the model's, or the one handed in with no rest
    const srcDc = options.colour?.dc ?? src.featuresDc;
    const srcOpacity = options.colour?.opacity ?? src.opacity;
    const writeRest = !options.colour;
    const levels = Array.from(model.levels);
    const K = model.restCoeffs;
    const bands = REST_COEFFS.indexOf(K);
    if (bands < 0) {
        throw new Error(`a model with ${K} SH rest coefficients per channel has no band count`);
    }
    const shStride = 3 + 3 * K;

    // the window a block's page covers: a segment of the coarsest level
    const window = levels.length > 0 ? Math.max(...levels) : 1;
    const pageOf = (level: number, segment: number) => {
        if (level === GLOBAL_LEVEL) return 'global';
        const w = Math.floor((segment * levels[level]) / window);
        return `p${String(w).padStart(4, '0')}`;
    };

    const motion = new Float32Array(11);

    // the global gaussians that stand still, and what their falloff
    // averaged to: it is folded into the opacity they are written with
    const staticFalloff = new Map<number, number>();
    const splitStatic = (rows: Uint32Array) => {
        const moving: number[] = [];
        const still: number[] = [];
        for (let i = 0; i < rows.length; i++) {
            const n = rows[i];
            model.motionParams(n, motion);
            const drift = Math.hypot(motion[0], motion[1], motion[2]);
            const thinnest = Math.exp(Math.min(motion[3], motion[4], motion[5]));
            const falloff = falloffOver(src.t[n], Math.exp(motion[10]));
            if (drift <= STATIC_MAX_DRIFT * thinnest && falloff.lowest >= STATIC_MIN_FALLOFF) {
                still.push(n);
                staticFalloff.set(n, falloff.mean);
            } else {
                moving.push(n);
            }
        }
        return { moving: Uint32Array.from(moving), still: Uint32Array.from(still) };
    };

    // lay the blocks out, page by page, keeping the block order
    const pageRows = new Map<string, Uint32Array[]>();
    const metaBlocks: GsvBlock[] = [];
    let staticRows: Uint32Array = new Uint32Array(0);
    for (const block of model.blocks()) {
        let blockRows = block.rows;
        if (block.level === GLOBAL_LEVEL && (options.staticSet ?? true)) {
            const split = splitStatic(blockRows);
            staticRows = morton ? mortonOrder(split.still, src.xyz) : split.still;
            blockRows = split.moving;
            if (blockRows.length === 0) continue;
        }
        const page = pageOf(block.level, block.segment);
        const rows = pageRows.get(page) ?? [];
        const start = rows.reduce((sum, r) => sum + r.length, 0);
        rows.push(morton ? mortonOrder(blockRows, src.xyz) : blockRows);
        pageRows.set(page, rows);
        metaBlocks.push({
            level: block.level,
            ...(block.level === GLOBAL_LEVEL ? {} : { segment: block.segment }),
            page,
            start,
            count: blockRows.length
        });
    }

    // the static page: each gaussian as it is drawn - the conditional 3D
    // covariance at its own place - with its average falloff in the opacity
    let staticPage: StaticPage | null = null;
    if (staticRows.length > 0) {
        const count = staticRows.length;
        staticPage = {
            mean: new Float32Array(count * 3),
            logScale: new Float32Array(count * 3),
            rot: new Float32Array(count * 4),
            opacity: new Float32Array(count),
            sh: new Float32Array(count * shStride)
        };
        for (let o = 0; o < count; o++) {
            const n = staticRows[o];
            model.motionParams(n, motion);
            staticPage.mean.set(src.xyz.subarray(n * 3, n * 3 + 3), o * 3);
            staticPage.logScale.set(motion.subarray(3, 6), o * 3);
            staticPage.rot.set(motion.subarray(6, 10), o * 4);
            const falloff = staticFalloff.get(n);
            // untouched when there is nothing to fold in, so a static set
            // read back and written again keeps its opacities bit for bit
            staticPage.opacity[o] = falloff === 1 ? srcOpacity[n] : logit(Math.min(sigmoid(srcOpacity[n]) * falloff, 1 - 1e-7));
            staticPage.sh.set(srcDc.subarray(n * 3, n * 3 + 3), o * shStride);
            if (writeRest) {
                staticPage.sh.set(src.featuresRest.subarray(n * K * 3, (n + 1) * K * 3), o * shStride + 3);
            }
        }
    }

    // every page's attributes as floats, rows in file order
    const f32Pages: { id: string, data: F32Page }[] = [];
    const motionPages: { id: string, data: MotionPage, isStatic?: boolean }[] = [];
    if (staticPage && encoding === 'webp') {
        // the webp encoder takes every page in motion form; a static
        // page's t, temporal scale and velocity are ignored there
        const count = staticRows.length;
        const mean = new Float32Array(count * 4);
        const logScale = new Float32Array(count * 4);
        for (let o = 0; o < count; o++) {
            mean.set(staticPage.mean.subarray(o * 3, o * 3 + 3), o * 4);
            logScale.set(staticPage.logScale.subarray(o * 3, o * 3 + 3), o * 4);
        }
        motionPages.push({
            id: STATIC_PAGE,
            isStatic: true,
            data: { mean, logScale, rot: staticPage.rot, velocity: new Float32Array(0), opacity: staticPage.opacity, sh: staticPage.sh }
        });
    }
    for (const [id, parts] of pageRows) {
        const count = parts.reduce((sum, r) => sum + r.length, 0);
        const mean = new Float32Array(count * 4);
        const logScale = new Float32Array(count * 4);
        const opacity = new Float32Array(count);
        const sh = new Float32Array(count * shStride);
        const rotL = encoding === 'f32' ? new Float32Array(count * 4) : null;
        const rotR = encoding === 'f32' ? new Float32Array(count * 4) : null;
        const rot = encoding === 'webp' ? new Float32Array(count * 4) : null;
        const velocity = encoding === 'webp' ? new Float32Array(count * 3) : null;

        let o = 0;
        for (const rows of parts) {
            for (let i = 0; i < rows.length; i++, o++) {
                const n = rows[i];
                mean[o * 4] = src.xyz[n * 3];
                mean[o * 4 + 1] = src.xyz[n * 3 + 1];
                mean[o * 4 + 2] = src.xyz[n * 3 + 2];
                mean[o * 4 + 3] = src.t[n];
                if (rotL) {
                    logScale[o * 4] = src.scaling[n * 3];
                    logScale[o * 4 + 1] = src.scaling[n * 3 + 1];
                    logScale[o * 4 + 2] = src.scaling[n * 3 + 2];
                    logScale[o * 4 + 3] = src.scalingT[n];
                    rotL.set(src.rotL.subarray(n * 4, n * 4 + 4), o * 4);
                    rotR.set(src.rotR.subarray(n * 4, n * 4 + 4), o * 4);
                } else {
                    model.motionParams(n, motion);
                    velocity.set(motion.subarray(0, 3), o * 3);
                    logScale.set(motion.subarray(3, 6), o * 4);
                    logScale[o * 4 + 3] = motion[10];
                    rot.set(motion.subarray(6, 10), o * 4);
                }
                opacity[o] = srcOpacity[n];
                // dc, then each rest coefficient's r, g, b: the checkpoint's
                // own coefficient-major layout
                sh.set(srcDc.subarray(n * 3, n * 3 + 3), o * shStride);
                if (writeRest) {
                    sh.set(src.featuresRest.subarray(n * K * 3, (n + 1) * K * 3), o * shStride + 3);
                }
            }
        }
        if (rotL) {
            f32Pages.push({ id, data: { mean, logScale, rotL, rotR, opacity, sh } });
        } else {
            motionPages.push({ id, data: { mean, logScale, rot, velocity, opacity, sh } });
        }
    }

    const files: ZipEntry[] = [];
    let codebooks: WebpCodebooks | undefined;
    let webpInfo: Map<string, WebpPageInfo> | undefined;
    if (encoding === 'webp') {
        const encoded = await encodeWebpPages(motionPages, K, { device: options.device });
        files.push(...encoded.files);
        codebooks = encoded.codebooks;
        webpInfo = encoded.info;
    } else {
        if (staticPage) {
            files.push(
                { name: `${STATIC_PAGE}/mean.bin`, data: bytesOf(staticPage.mean) },
                { name: `${STATIC_PAGE}/logScale.bin`, data: bytesOf(staticPage.logScale) },
                { name: `${STATIC_PAGE}/rot.bin`, data: bytesOf(staticPage.rot) },
                { name: `${STATIC_PAGE}/opacity.bin`, data: bytesOf(staticPage.opacity) },
                { name: `${STATIC_PAGE}/sh.bin`, data: bytesOf(staticPage.sh) }
            );
        }
        for (const { id, data } of f32Pages) {
            files.push(
                { name: `${id}/mean.bin`, data: bytesOf(data.mean) },
                { name: `${id}/logScale.bin`, data: bytesOf(data.logScale) },
                { name: `${id}/rotL.bin`, data: bytesOf(data.rotL) },
                { name: `${id}/rotR.bin`, data: bytesOf(data.rotR) },
                { name: `${id}/opacity.bin`, data: bytesOf(data.opacity) },
                { name: `${id}/sh.bin`, data: bytesOf(data.sh) }
            );
        }
    }

    const pages: GsvPage[] = staticPage ? [{
        id: STATIC_PAGE,
        kind: 'static',
        encoding,
        count: staticRows.length,
        ...(webpInfo?.get(STATIC_PAGE) ?? {})
    }] : [];
    for (const { id, data } of [...f32Pages, ...motionPages.filter(p => !p.isStatic)]) {
        const w = id === 'global' ? null : parseInt(id.slice(1), 10);
        pages.push({
            id,
            kind: 'dynamic',
            encoding,
            count: data.opacity.length,
            tMin: w === null ? 0 : w * window,
            tMax: w === null ? 1 : Math.min(1, (w + 1) * window),
            ...(webpInfo?.get(id) ?? {})
        });
    }

    const meta: GsvMeta = {
        asset: { format: 'gsv', version: '1.0', generator: `VoluLab ${version}` },
        ...(timeline.frames || timeline.fps ? {
            time: {
                ...(timeline.frames ? { frames: timeline.frames } : {}),
                ...(timeline.fps ? { fps: timeline.fps } : {})
            }
        } : {}),
        ...(timeline.zUp ? { space: { up: 'z' as const } } : {}),
        sh: { bands },
        ...(codebooks ? { codebooks } : {}),
        levels,
        pages,
        blocks: metaBlocks,
        extensionsUsed: [],
        extensionsRequired: []
    };

    // meta.json first, so a streaming reader can start before the
    // central directory arrives
    files.unshift({ name: 'meta.json', data: new TextEncoder().encode(JSON.stringify(meta)) });
    return storedZip(files);
};

const readEntry = async (fs: ZipReadFileSystem, name: string) => {
    const source = await fs.createSource(name);
    try {
        const stream = source.read();
        const bytes = await stream.readAll();
        stream.close();
        return bytes;
    } finally {
        source.close();
    }
};

const readFloats = async (fs: ZipReadFileSystem, name: string, length: number) => {
    const bytes = await readEntry(fs, name);
    if (bytes.byteLength !== length * 4) {
        throw new Error(`${name}: expected ${length} floats, found ${bytes.byteLength / 4}`);
    }
    // copy: the entry's bytes need not be 4-byte aligned
    return new Float32Array(bytes.slice().buffer);
};

/** A GSV file as a TGH model. */
const readGsv = async (blob: Blob): Promise<TghModel> => {
    requireLittleEndian();

    const fs = new ZipReadFileSystem(new BlobReadSource(blob));
    try {
        const meta = JSON.parse(new TextDecoder().decode(await readEntry(fs, 'meta.json'))) as GsvMeta;
        if (meta.asset?.format !== 'gsv') {
            throw new Error('not a GSV file');
        }
        if (!meta.asset.version?.startsWith('1.')) {
            throw new Error(`GSV version ${meta.asset.version} is not supported`);
        }
        if (meta.extensionsRequired?.length) {
            throw new Error(`GSV extensions not supported: ${meta.extensionsRequired.join(', ')}`);
        }

        const pages = new Map(meta.pages.map(p => [p.id, p]));
        for (const page of meta.pages) {
            if (page.encoding !== 'f32' && page.encoding !== 'webp') {
                throw new Error(`GSV page ${page.id}: the ${page.encoding} encoding is not supported yet`);
            }
            if (page.kind !== 'dynamic' && page.kind !== 'static') {
                throw new Error(`GSV page ${page.id}: kind ${page.kind}`);
            }
        }
        const staticPages = meta.pages.filter(p => p.kind === 'static');

        const K = REST_COEFFS[meta.sh.bands];
        if (K === undefined) {
            throw new Error(`GSV: ${meta.sh.bands} SH bands`);
        }
        const shStride = 3 + 3 * K;
        const read = (name: string) => readEntry(fs, name);
        const usesWebp = meta.pages.some(p => p.encoding === 'webp');
        if (usesWebp && meta.pages.some(p => p.encoding !== 'webp')) {
            // the two encodings hold different forms of the primitive
            throw new Error('GSV: pages of both encodings in one file are not supported');
        }
        if (usesWebp && !meta.codebooks) {
            throw new Error('GSV: webp pages but no codebooks');
        }
        if (usesWebp) {
            checkCodebooks(meta.codebooks, K);
        }

        // the hierarchy and the blocks, before anything is decoded: a block
        // that is not a whole run of rows inside its page would read garbage
        if (!Array.isArray(meta.levels) || !meta.levels.every(len => Number.isFinite(len) && len > 0)) {
            throw new Error('GSV: levels must be positive segment lengths');
        }
        for (const page of meta.pages) {
            if (!Number.isInteger(page.count) || page.count < 0) {
                throw new Error(`GSV page ${page.id}: count ${page.count}`);
            }
        }
        for (const block of meta.blocks) {
            const page = pages.get(block.page);
            if (!page) {
                throw new Error(`GSV: a block names page ${block.page}, which does not exist`);
            }
            if (page.kind === 'static') {
                throw new Error(`GSV: a block names the static page ${block.page}`);
            }
            if ('tiers' in block) {
                throw new Error(`GSV: tiered blocks (page ${block.page}) are not supported yet`);
            }
            if (!Number.isInteger(block.start) || !Number.isInteger(block.count) ||
                block.start < 0 || block.count < 0 || block.start + block.count > page.count) {
                throw new Error(`GSV: a block lies outside page ${block.page}`);
            }
            if (block.level !== GLOBAL_LEVEL && !(Number.isInteger(block.level) && block.level >= 0 && block.level < meta.levels.length)) {
                throw new Error(`GSV: a block names level ${block.level}, of ${meta.levels.length}`);
            }
            if (block.segment !== undefined && !(Number.isInteger(block.segment) && block.segment >= 0)) {
                throw new Error(`GSV: a block names segment ${block.segment}`);
            }
        }

        const palette = usesWebp ? await decodePalette(read, meta.codebooks, K) : null;

        const numStatic = staticPages.reduce((sum, p) => sum + p.count, 0);
        const N = numStatic + meta.blocks.reduce((sum, b) => sum + b.count, 0);

        const xyz = new Float32Array(N * 3);
        const t = new Float32Array(N);
        const scaling = new Float32Array(N * 3);
        const scalingT = new Float32Array(N);
        const rotL = new Float32Array(usesWebp ? 0 : N * 4);
        const rotR = new Float32Array(usesWebp ? 0 : N * 4);
        const rot3 = usesWebp ? new Float32Array(N * 4) : undefined;
        const velocity = usesWebp ? new Float32Array(N * 3) : undefined;
        const opacity = new Float32Array(N);
        const featuresDc = new Float32Array(N * 3);
        const featuresRest = new Float32Array(N * K * 3);
        const level = new Int32Array(N);
        const segment = new Int32Array(N);

        // a page is read once, whichever block asks first
        const loaded = new Map<string, F32Page | MotionPage>();
        const pageData = async (id: string) => {
            let data = loaded.get(id);
            if (!data) {
                const page = pages.get(id);
                if (!page) {
                    throw new Error(`GSV: a block names page ${id}, which does not exist`);
                }
                const c = page.count;
                data = page.encoding === 'webp' ? await decodeWebpPage(read, id, c, page as WebpPageInfo, meta.codebooks, K, palette) : {
                    mean: await readFloats(fs, `${id}/mean.bin`, c * 4),
                    logScale: await readFloats(fs, `${id}/logScale.bin`, c * 4),
                    rotL: await readFloats(fs, `${id}/rotL.bin`, c * 4),
                    rotR: await readFloats(fs, `${id}/rotR.bin`, c * 4),
                    opacity: await readFloats(fs, `${id}/opacity.bin`, c),
                    sh: await readFloats(fs, `${id}/sh.bin`, c * shStride)
                };
                loaded.set(id, data);
            }
            return data;
        };

        // the static set first: global gaussians that neither move nor fade
        let n = 0;
        for (const page of staticPages) {
            const { id, count: c } = page;
            let d: StaticPage;
            if (page.encoding === 'webp') {
                const m = await decodeWebpPage(read, id, c, page as WebpPageInfo, meta.codebooks, K, palette, true);
                d = { mean: m.mean, logScale: m.logScale, rot: m.rot, opacity: m.opacity, sh: m.sh };
            } else {
                d = {
                    mean: await readFloats(fs, `${id}/mean.bin`, c * 3),
                    logScale: await readFloats(fs, `${id}/logScale.bin`, c * 3),
                    rot: await readFloats(fs, `${id}/rot.bin`, c * 4),
                    opacity: await readFloats(fs, `${id}/opacity.bin`, c),
                    sh: await readFloats(fs, `${id}/sh.bin`, c * shStride)
                };
            }
            // webp pages decode four wide (the fourth unused), f32 ones three
            const stride = page.encoding === 'webp' ? 4 : 3;
            for (let i = 0; i < c; i++, n++) {
                xyz.set(d.mean.subarray(i * stride, i * stride + 3), n * 3);
                scaling.set(d.logScale.subarray(i * stride, i * stride + 3), n * 3);
                t[n] = STATIC_T;
                scalingT[n] = STATIC_LOG_STD_T;
                const w = d.rot[i * 4], x = d.rot[i * 4 + 1], y = d.rot[i * 4 + 2], z = d.rot[i * 4 + 3];
                if (rot3) {
                    rot3.set(d.rot.subarray(i * 4, i * 4 + 4), n * 4);
                    // velocity stays zero
                } else {
                    // the quaternion pair whose 4D rotation L(l) R(r) is this
                    // 3D rotation with the time axis left alone
                    rotL[n * 4] = w; rotL[n * 4 + 1] = z; rotL[n * 4 + 2] = -y; rotL[n * 4 + 3] = x;
                    rotR[n * 4] = w; rotR[n * 4 + 1] = z; rotR[n * 4 + 2] = -y; rotR[n * 4 + 3] = -x;
                }
                opacity[n] = d.opacity[i];
                featuresDc.set(d.sh.subarray(i * shStride, i * shStride + 3), n * 3);
                featuresRest.set(d.sh.subarray(i * shStride + 3, (i + 1) * shStride), n * K * 3);
                level[n] = GLOBAL_LEVEL;
                segment[n] = 0;
            }
        }

        for (const block of meta.blocks) {
            const d = await pageData(block.page);
            for (let i = block.start; i < block.start + block.count; i++, n++) {
                xyz[n * 3] = d.mean[i * 4];
                xyz[n * 3 + 1] = d.mean[i * 4 + 1];
                xyz[n * 3 + 2] = d.mean[i * 4 + 2];
                t[n] = d.mean[i * 4 + 3];
                scaling[n * 3] = d.logScale[i * 4];
                scaling[n * 3 + 1] = d.logScale[i * 4 + 1];
                scaling[n * 3 + 2] = d.logScale[i * 4 + 2];
                scalingT[n] = d.logScale[i * 4 + 3];
                if ('rotL' in d) {
                    rotL.set(d.rotL.subarray(i * 4, i * 4 + 4), n * 4);
                    rotR.set(d.rotR.subarray(i * 4, i * 4 + 4), n * 4);
                } else {
                    rot3.set(d.rot.subarray(i * 4, i * 4 + 4), n * 4);
                    velocity.set(d.velocity.subarray(i * 3, i * 3 + 3), n * 3);
                }
                opacity[n] = d.opacity[i];
                featuresDc.set(d.sh.subarray(i * shStride, i * shStride + 3), n * 3);
                featuresRest.set(d.sh.subarray(i * shStride + 3, (i + 1) * shStride), n * K * 3);
                level[n] = block.level;
                segment[n] = block.segment ?? 0;
            }
        }

        return TghModel.fromTensors({
            xyz,
            t,
            scaling,
            scalingT,
            rotL,
            rotR,
            velocity,
            rot3,
            opacity,
            featuresDc,
            featuresRest,
            level,
            segment,
            segLen: Float64Array.from(meta.levels),
            meta: {
                frames: meta.time?.frames ?? null,
                fps: meta.time?.fps ?? null,
                zUp: meta.space?.up === 'z'
            }
        });
    } finally {
        fs.close();
    }
};

export { readGsv, writeGsv, standsStill, type GsvMeta };
