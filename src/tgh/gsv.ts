import { ZipReadFileSystem } from '@playcanvas/splat-transform';

import { TghModel } from './tgh-model';
import { version } from '../../package.json';
import { BlobReadSource } from '../io';
import { storedZip, ZipEntry } from '../io/write/stored-zip';

/**
 * GSV (Gaussian Splat Video), the f32 encoding: writing a TGH model out and
 * reading it back. See docs/format-gsv.md.
 *
 * f32 is the lossless encoding, so a model survives the round trip bit for
 * bit. Rows are written block by block in the order TghModel.activeIndices
 * concatenates them - the global set, then each level's segments in
 * ascending order - so a model read back conditions every frame into the
 * same gaussians in the same order as the one written.
 *
 * Blocks are grouped into pages by time window: one page for the global
 * set, and one per segment of the coarsest level, holding every finer
 * segment that starts inside it. A player fetching the pages around the
 * playhead then fetches about one window's worth.
 */

const GLOBAL_LEVEL = -1;

// spherical-harmonic rest coefficients per channel, by band count
const REST_COEFFS = [0, 3, 8, 15];

type GsvPage = {
    id: string;
    kind: 'dynamic' | 'static';
    encoding: string;
    count: number;
    tMin?: number;
    tMax?: number;
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
    sh: { bands: number };
    levels: number[];
    pages: GsvPage[];
    blocks: GsvBlock[];
    extensionsUsed?: string[];
    extensionsRequired?: string[];
};

type GsvTimeline = {
    frames: number | null;
    fps: number | null;
};

// the f32 buffers are little-endian; the typed arrays are the platform's
const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

const requireLittleEndian = () => {
    if (!littleEndian) {
        throw new Error('GSV f32 needs a little-endian platform');
    }
};

const bytesOf = (a: Float32Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

/** A TGH model as a GSV file, f32 encoding. */
const writeGsv = (model: TghModel, timeline: GsvTimeline): Uint8Array => {
    requireLittleEndian();

    const src = model.tensors;
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

    // lay the blocks out, page by page, keeping the block order
    const blocks = model.blocks();
    const pageRows = new Map<string, Uint32Array[]>();
    const metaBlocks: GsvBlock[] = [];
    for (const block of blocks) {
        const page = pageOf(block.level, block.segment);
        const rows = pageRows.get(page) ?? [];
        const start = rows.reduce((sum, r) => sum + r.length, 0);
        rows.push(block.rows);
        pageRows.set(page, rows);
        metaBlocks.push({
            level: block.level,
            ...(block.level === GLOBAL_LEVEL ? {} : { segment: block.segment }),
            page,
            start,
            count: block.rows.length
        });
    }

    const files: ZipEntry[] = [];
    const pages: GsvPage[] = [];
    for (const [id, parts] of pageRows) {
        const count = parts.reduce((sum, r) => sum + r.length, 0);
        const mean = new Float32Array(count * 4);
        const logScale = new Float32Array(count * 4);
        const rotL = new Float32Array(count * 4);
        const rotR = new Float32Array(count * 4);
        const opacity = new Float32Array(count);
        const sh = new Float32Array(count * shStride);

        let o = 0;
        for (const rows of parts) {
            for (let i = 0; i < rows.length; i++, o++) {
                const n = rows[i];
                mean[o * 4] = src.xyz[n * 3];
                mean[o * 4 + 1] = src.xyz[n * 3 + 1];
                mean[o * 4 + 2] = src.xyz[n * 3 + 2];
                mean[o * 4 + 3] = src.t[n];
                logScale[o * 4] = src.scaling[n * 3];
                logScale[o * 4 + 1] = src.scaling[n * 3 + 1];
                logScale[o * 4 + 2] = src.scaling[n * 3 + 2];
                logScale[o * 4 + 3] = src.scalingT[n];
                rotL.set(src.rotL.subarray(n * 4, n * 4 + 4), o * 4);
                rotR.set(src.rotR.subarray(n * 4, n * 4 + 4), o * 4);
                opacity[o] = src.opacity[n];
                // dc, then each rest coefficient's r, g, b: the checkpoint's
                // own coefficient-major layout
                sh.set(src.featuresDc.subarray(n * 3, n * 3 + 3), o * shStride);
                sh.set(src.featuresRest.subarray(n * K * 3, (n + 1) * K * 3), o * shStride + 3);
            }
        }

        files.push(
            { name: `${id}/mean.bin`, data: bytesOf(mean) },
            { name: `${id}/logScale.bin`, data: bytesOf(logScale) },
            { name: `${id}/rotL.bin`, data: bytesOf(rotL) },
            { name: `${id}/rotR.bin`, data: bytesOf(rotR) },
            { name: `${id}/opacity.bin`, data: bytesOf(opacity) },
            { name: `${id}/sh.bin`, data: bytesOf(sh) }
        );

        const w = id === 'global' ? null : parseInt(id.slice(1), 10);
        pages.push({
            id,
            kind: 'dynamic',
            encoding: 'f32',
            count,
            tMin: w === null ? 0 : w * window,
            tMax: w === null ? 1 : Math.min(1, (w + 1) * window)
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
        sh: { bands },
        levels,
        pages,
        blocks: metaBlocks,
        extensionsUsed: [],
        extensionsRequired: []
    };

    // meta.json first, so a streaming reader can start before the
    // central directory arrives
    files.unshift({ name: 'meta.json', data: new TextEncoder().encode(JSON.stringify(meta, null, 2)) });
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

/** A GSV file (f32 encoding, dynamic pages) as a TGH model. */
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
            if (page.encoding !== 'f32') {
                throw new Error(`GSV page ${page.id}: the ${page.encoding} encoding is not supported yet`);
            }
            if (page.kind !== 'dynamic') {
                throw new Error(`GSV page ${page.id}: static pages are not supported yet`);
            }
        }

        const K = REST_COEFFS[meta.sh.bands];
        if (K === undefined) {
            throw new Error(`GSV: ${meta.sh.bands} SH bands`);
        }
        const shStride = 3 + 3 * K;
        const N = meta.blocks.reduce((sum, b) => sum + b.count, 0);

        const xyz = new Float32Array(N * 3);
        const t = new Float32Array(N);
        const scaling = new Float32Array(N * 3);
        const scalingT = new Float32Array(N);
        const rotL = new Float32Array(N * 4);
        const rotR = new Float32Array(N * 4);
        const opacity = new Float32Array(N);
        const featuresDc = new Float32Array(N * 3);
        const featuresRest = new Float32Array(N * K * 3);
        const level = new Int32Array(N);
        const segment = new Int32Array(N);

        // a page is read once, whichever block asks first
        type PageData = { mean: Float32Array, logScale: Float32Array, rotL: Float32Array, rotR: Float32Array, opacity: Float32Array, sh: Float32Array };
        const loaded = new Map<string, PageData>();
        const pageData = async (id: string) => {
            let data = loaded.get(id);
            if (!data) {
                const page = pages.get(id);
                if (!page) {
                    throw new Error(`GSV: a block names page ${id}, which does not exist`);
                }
                const c = page.count;
                data = {
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

        let n = 0;
        for (const block of meta.blocks) {
            const page = pages.get(block.page);
            if (!page || block.start < 0 || block.start + block.count > page.count) {
                throw new Error(`GSV: a block lies outside page ${block.page}`);
            }
            if (block.level !== GLOBAL_LEVEL && !(block.level >= 0 && block.level < meta.levels.length)) {
                throw new Error(`GSV: a block names level ${block.level}, of ${meta.levels.length}`);
            }
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
                rotL.set(d.rotL.subarray(i * 4, i * 4 + 4), n * 4);
                rotR.set(d.rotR.subarray(i * 4, i * 4 + 4), n * 4);
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
            opacity,
            featuresDc,
            featuresRest,
            level,
            segment,
            segLen: Float64Array.from(meta.levels),
            meta: {
                frames: meta.time?.frames ?? null,
                fps: meta.time?.fps ?? null
            }
        });
    } finally {
        fs.close();
    }
};

export { readGsv, writeGsv, type GsvMeta };
