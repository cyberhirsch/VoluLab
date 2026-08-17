import { Column, DataTable, ReadFileSystem, Transform } from '@playcanvas/splat-transform';
import { GSplatData } from 'playcanvas';

/**
 * Point clouds imported as tiny gaussians.
 *
 * A point cloud carries positions and sometimes colour; a gaussian needs
 * rotation, scale, opacity and SH on top. Rather than teach every tool a
 * second element type, the missing properties are synthesised - identity
 * rotation, near-opaque, DC colour from rgb, and a scale sized from the
 * cloud's own point spacing - so a LAS scan selects, crops, grades and
 * exports exactly like a capture does. A slight lie about what the data
 * is, told so that everything true about it keeps working.
 *
 * Formats here are parsed by hand (LAS, PCD, XYZ/PTS); plain point-cloud
 * PLYs never reach this file - splat-transform parses them and the same
 * synthesis runs on the result. LAZ needs LASzip and arrives via the
 * laz-perf wasm, loaded lazily since most sessions never see one.
 */

const POINT_CLOUD_EXTENSIONS = ['.las', '.laz', '.pcd', '.xyz', '.pts'];

const isPointCloudFile = (filename: string) => {
    const lower = filename.toLowerCase();
    return POINT_CLOUD_EXTENSIONS.some(ext => lower.endsWith(ext));
};

const SH_C0 = 0.28209479177387814;

type ParsedPoints = {
    x: Float32Array;
    y: Float32Array;
    z: Float32Array;
    // 0-255 when present
    red?: Uint8Array;
    green?: Uint8Array;
    blue?: Uint8Array;
};

const readAll = async (fileSystem: ReadFileSystem, filename: string): Promise<Uint8Array> => {
    const source = await fileSystem.createSource(filename);
    try {
        const stream = source.read();
        const bytes = await stream.readAll();
        stream.close();
        return bytes;
    } finally {
        source.close();
    }
};

// ---------------------------------------------------------------------- LAS

type LasHeader = {
    versionMinor: number;
    headerSize: number;
    offsetToPoints: number;
    pointFormat: number;
    recordLength: number;
    count: number;
    scale: [number, number, number];
    offset: [number, number, number];
};

const parseLasHeader = (view: DataView): LasHeader => {
    const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (magic !== 'LASF') {
        throw new Error('Not a LAS file');
    }
    const versionMinor = view.getUint8(25);
    const headerSize = view.getUint16(94, true);
    const offsetToPoints = view.getUint32(96, true);
    // the high bits mark LAZ compression; the low bits are the format id
    const pointFormat = view.getUint8(104) & 0x3f;
    const recordLength = view.getUint16(105, true);
    let count = view.getUint32(107, true);
    if (count === 0 && versionMinor >= 4 && headerSize >= 375) {
        count = Number(view.getBigUint64(247, true));
    }
    return {
        versionMinor,
        headerSize,
        offsetToPoints,
        pointFormat,
        recordLength,
        count,
        scale: [view.getFloat64(131, true), view.getFloat64(139, true), view.getFloat64(147, true)],
        offset: [view.getFloat64(155, true), view.getFloat64(163, true), view.getFloat64(171, true)]
    };
};

// byte offset of the 3x-uint16 rgb block within a point record, per format
const LAS_RGB_OFFSET: { [format: number]: number } = {
    2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30
};

/**
 * Decode uncompressed LAS point records. `readRecord(i, out)` abstracts
 * where a record's bytes come from, so the LAZ path can reuse this with
 * records decompressed one at a time.
 */
const decodeLasPoints = (header: LasHeader, readRecord: (index: number, out: Uint8Array) => void): ParsedPoints => {
    const { count, pointFormat, recordLength, scale, offset } = header;
    const record = new Uint8Array(recordLength);
    const view = new DataView(record.buffer);
    const rgbOffset = LAS_RGB_OFFSET[pointFormat];

    const x = new Float32Array(count);
    const y = new Float32Array(count);
    const z = new Float32Array(count);
    const hasRgb = rgbOffset !== undefined && rgbOffset + 6 <= recordLength;
    const rawR = hasRgb ? new Uint16Array(count) : null;
    const rawG = hasRgb ? new Uint16Array(count) : null;
    const rawB = hasRgb ? new Uint16Array(count) : null;

    for (let i = 0; i < count; i++) {
        readRecord(i, record);
        x[i] = view.getInt32(0, true) * scale[0] + offset[0];
        y[i] = view.getInt32(4, true) * scale[1] + offset[1];
        z[i] = view.getInt32(8, true) * scale[2] + offset[2];
        if (hasRgb) {
            rawR[i] = view.getUint16(rgbOffset, true);
            rawG[i] = view.getUint16(rgbOffset + 2, true);
            rawB[i] = view.getUint16(rgbOffset + 4, true);
        }
    }

    const result: ParsedPoints = { x, y, z };
    if (hasRgb) {
        // the spec says 16-bit, but 8-bit-in-a-16-bit-field files are
        // everywhere; scale by what the data actually uses
        let max = 0;
        for (let i = 0; i < count; i++) {
            if (rawR[i] > max) max = rawR[i];
            if (rawG[i] > max) max = rawG[i];
            if (rawB[i] > max) max = rawB[i];
        }
        const shift = max > 255 ? 8 : 0;
        const red = new Uint8Array(count);
        const green = new Uint8Array(count);
        const blue = new Uint8Array(count);
        for (let i = 0; i < count; i++) {
            red[i] = rawR[i] >> shift;
            green[i] = rawG[i] >> shift;
            blue[i] = rawB[i] >> shift;
        }
        result.red = red;
        result.green = green;
        result.blue = blue;
    }
    return result;
};

const parseLas = (bytes: Uint8Array): ParsedPoints => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const header = parseLasHeader(view);
    return decodeLasPoints(header, (i, out) => {
        const start = header.offsetToPoints + i * header.recordLength;
        out.set(bytes.subarray(start, start + header.recordLength));
    });
};

const parseLaz = async (bytes: Uint8Array): Promise<ParsedPoints> => {
    // laz-perf is ~1.2MB of wasm most sessions never need - load on demand
    let createLazPerf;
    try {
        ({ createLazPerf } = await import('laz-perf'));
    } catch (e) {
        throw new Error('LAZ support failed to load - convert to .las and import that');
    }
    const lazPerf = await createLazPerf({
        locateFile: (file: string) => new URL(`static/lib/laz-perf/${file}`, document.baseURI).toString()
    });

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const header = parseLasHeader(view);

    const laszip = new lazPerf.LASZip();
    const filePtr = lazPerf._malloc(bytes.byteLength);
    const recordPtr = lazPerf._malloc(header.recordLength);
    try {
        lazPerf.HEAPU8.set(bytes, filePtr);
        laszip.open(filePtr, bytes.byteLength);
        return decodeLasPoints(header, (i, out) => {
            laszip.getPoint(recordPtr);
            out.set(lazPerf.HEAPU8.subarray(recordPtr, recordPtr + header.recordLength));
        });
    } finally {
        laszip.delete();
        lazPerf._free(recordPtr);
        lazPerf._free(filePtr);
    }
};

// ---------------------------------------------------------------------- PCD

const parsePcd = (bytes: Uint8Array): ParsedPoints => {
    // the header is ascii lines up to and including DATA
    const headerEnd = (() => {
        const probe = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
        const match = probe.match(/^DATA\s+\S+\r?\n/m);
        if (!match) throw new Error('Malformed PCD header');
        return probe.indexOf(match[0]) + match[0].length;
    })();

    const header = new TextDecoder().decode(bytes.subarray(0, headerEnd));
    const line = (key: string) => header.match(new RegExp(`^${key}\\s+(.*)$`, 'm'))?.[1]?.trim();

    const fields = line('FIELDS')?.split(/\s+/) ?? [];
    const sizes = (line('SIZE')?.split(/\s+/) ?? []).map(Number);
    const types = line('TYPE')?.split(/\s+/) ?? [];
    const counts = (line('COUNT')?.split(/\s+/) ?? fields.map(() => '1')).map(Number);
    const points = Number(line('POINTS') ?? line('WIDTH') ?? 0);
    const data = line('DATA');

    if (data === 'binary_compressed') {
        throw new Error('Compressed PCD is not supported - save as ascii or binary PCD');
    }

    const fieldIndex = (name: string) => fields.indexOf(name);
    const xi = fieldIndex('x'), yi = fieldIndex('y'), zi = fieldIndex('z');
    if (xi < 0 || yi < 0 || zi < 0) {
        throw new Error('PCD file has no x/y/z fields');
    }
    const rgbI = fieldIndex('rgb') !== -1 ? fieldIndex('rgb') : fieldIndex('rgba');

    const x = new Float32Array(points);
    const y = new Float32Array(points);
    const z = new Float32Array(points);
    const red = rgbI >= 0 ? new Uint8Array(points) : null;
    const green = rgbI >= 0 ? new Uint8Array(points) : null;
    const blue = rgbI >= 0 ? new Uint8Array(points) : null;

    const setRgb = (i: number, packed: number) => {
        red[i] = (packed >> 16) & 0xff;
        green[i] = (packed >> 8) & 0xff;
        blue[i] = packed & 0xff;
    };

    if (data === 'ascii') {
        const text = new TextDecoder().decode(bytes.subarray(headerEnd));
        const lines = text.split('\n');
        let row = 0;
        for (const l of lines) {
            if (row >= points) break;
            const tokens = l.trim().split(/\s+/);
            if (tokens.length < fields.length) continue;
            x[row] = parseFloat(tokens[xi]);
            y[row] = parseFloat(tokens[yi]);
            z[row] = parseFloat(tokens[zi]);
            if (rgbI >= 0) {
                // ascii rgb is the packed float's numeric value
                const value = parseFloat(tokens[rgbI]);
                const packed = types[rgbI] === 'F' ?
                    new Uint32Array(new Float32Array([value]).buffer)[0] :
                    value >>> 0;
                setRgb(row, packed);
            }
            row++;
        }
    } else {
        // binary: tightly packed records in field order
        const strides: number[] = [];
        let recordLength = 0;
        for (let f = 0; f < fields.length; f++) {
            strides.push(recordLength);
            recordLength += sizes[f] * (counts[f] ?? 1);
        }
        const view = new DataView(bytes.buffer, bytes.byteOffset + headerEnd);
        for (let i = 0; i < points; i++) {
            const base = i * recordLength;
            x[i] = view.getFloat32(base + strides[xi], true);
            y[i] = view.getFloat32(base + strides[yi], true);
            z[i] = view.getFloat32(base + strides[zi], true);
            if (rgbI >= 0) {
                setRgb(i, view.getUint32(base + strides[rgbI], true));
            }
        }
    }

    const result: ParsedPoints = { x, y, z };
    if (red) {
        result.red = red;
        result.green = green;
        result.blue = blue;
    }
    return result;
};

// ------------------------------------------------------------------ XYZ/PTS

const parseXyz = (bytes: Uint8Array): ParsedPoints => {
    const text = new TextDecoder().decode(bytes);
    const lines = text.split('\n');

    const xs: number[] = [];
    const ys: number[] = [];
    const zs: number[] = [];
    let rs: number[] | null = null;
    let gs: number[] | null = null;
    let bs: number[] | null = null;

    let first = true;
    for (const l of lines) {
        const trimmed = l.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
        const tokens = trimmed.split(/[\s,;]+/);

        // a PTS file leads with a bare point count
        if (first && tokens.length === 1 && Number.isInteger(parseFloat(tokens[0]))) {
            first = false;
            continue;
        }
        first = false;

        if (tokens.length < 3) continue;
        const values = tokens.map(parseFloat);
        if (values.slice(0, 3).some(Number.isNaN)) continue;

        xs.push(values[0]);
        ys.push(values[1]);
        zs.push(values[2]);

        // x y z r g b, or x y z intensity r g b - colour is whatever
        // trailing triple looks like bytes
        const tail = values.slice(3);
        let rgb: number[] | null = null;
        if (tail.length >= 3) {
            const candidate = tail.slice(-3);
            if (candidate.every(v => Number.isInteger(v) && v >= 0 && v <= 255)) {
                rgb = candidate;
            }
        }
        if (rgb) {
            if (!rs) {
                rs = [];
                gs = [];
                bs = [];
            }
            rs.push(rgb[0]);
            gs.push(rgb[1]);
            bs.push(rgb[2]);
        }
    }

    const result: ParsedPoints = {
        x: Float32Array.from(xs),
        y: Float32Array.from(ys),
        z: Float32Array.from(zs)
    };
    if (rs && rs.length === xs.length) {
        result.red = Uint8Array.from(rs);
        result.green = Uint8Array.from(gs);
        result.blue = Uint8Array.from(bs);
    }
    return result;
};

// ------------------------------------------------------------------- entry

/**
 * Parse a point-cloud file into the same DataTable shape splat-transform
 * produces for a plain point-cloud PLY: x/y/z float32 plus red/green/blue
 * when the format carries colour, with the PLY coordinate convention so
 * every import lands in one orientation.
 */
const readPointCloud = async (filename: string, fileSystem: ReadFileSystem): Promise<DataTable> => {
    const lower = filename.toLowerCase();
    const bytes = await readAll(fileSystem, filename);

    let points: ParsedPoints;
    if (lower.endsWith('.las')) {
        points = parseLas(bytes);
    } else if (lower.endsWith('.laz')) {
        points = await parseLaz(bytes);
    } else if (lower.endsWith('.pcd')) {
        points = parsePcd(bytes);
    } else {
        points = parseXyz(bytes);
    }

    const columns = [
        new Column('x', points.x),
        new Column('y', points.y),
        new Column('z', points.z)
    ];
    if (points.red) {
        columns.push(new Column('red', points.red));
        columns.push(new Column('green', points.green));
        columns.push(new Column('blue', points.blue));
    }
    return new DataTable(columns, Transform.PLY.clone());
};

// --------------------------------------------------------------- synthesis

/**
 * Give a bare point cloud the properties a gaussian needs. Runs on any
 * loaded data that has positions but no gaussian fields - which covers the
 * parsers above and plain point-cloud PLYs alike.
 */
const synthesizeGaussianProps = (gsplatData: GSplatData) => {
    const x = gsplatData.getProp('x') as Float32Array;
    const y = gsplatData.getProp('y') as Float32Array;
    const z = gsplatData.getProp('z') as Float32Array;
    if (!x || !y || !z) return;
    if (gsplatData.getProp('scale_0') || gsplatData.getProp('rot_0') ||
        gsplatData.getProp('f_dc_0') || gsplatData.getProp('opacity')) return;

    const n = gsplatData.numSplats;

    // bounding box, for both the scale clamp and the grid hash
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
        if (x[i] < minX) minX = x[i];
        if (y[i] < minY) minY = y[i];
        if (z[i] < minZ) minZ = z[i];
        if (x[i] > maxX) maxX = x[i];
        if (y[i] > maxY) maxY = y[i];
        if (z[i] > maxZ) maxZ = z[i];
    }
    const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;

    // point size from the cloud's own spacing: median nearest-neighbour
    // distance over a sample, found through a uniform grid hash
    let size = 0.01 * diag;
    if (n >= 2) {
        const sampleCount = Math.min(50000, n);
        const stride = Math.max(1, Math.floor(n / sampleCount));
        const cell = diag / Math.cbrt(sampleCount);
        const grid = new Map<string, number[]>();
        const keyOf = (i: number) => `${Math.floor(x[i] / cell)},${Math.floor(y[i] / cell)},${Math.floor(z[i] / cell)}`;
        for (let i = 0; i < n; i += stride) {
            const key = keyOf(i);
            let bucket = grid.get(key);
            if (!bucket) {
                bucket = [];
                grid.set(key, bucket);
            }
            bucket.push(i);
        }
        const distances: number[] = [];
        for (let i = 0; i < n && distances.length < sampleCount; i += stride) {
            const cx = Math.floor(x[i] / cell);
            const cy = Math.floor(y[i] / cell);
            const cz = Math.floor(z[i] / cell);
            let best = Infinity;
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dz = -1; dz <= 1; dz++) {
                        const bucket = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
                        if (!bucket) continue;
                        for (const j of bucket) {
                            if (j === i) continue;
                            const d = Math.hypot(x[j] - x[i], y[j] - y[i], z[j] - z[i]);
                            if (d < best) best = d;
                        }
                    }
                }
            }
            if (Number.isFinite(best)) distances.push(best);
        }
        if (distances.length) {
            distances.sort((a, b) => a - b);
            const median = distances[Math.floor(distances.length / 2)];
            size = Math.min(Math.max(median * 0.6, 1e-6), 0.05 * diag);
        }
    }

    const logScale = Math.log(size);
    gsplatData.addProp('scale_0', new Float32Array(n).fill(logScale));
    gsplatData.addProp('scale_1', new Float32Array(n).fill(logScale));
    gsplatData.addProp('scale_2', new Float32Array(n).fill(logScale));

    gsplatData.addProp('rot_0', new Float32Array(n).fill(1));
    gsplatData.addProp('rot_1', new Float32Array(n));
    gsplatData.addProp('rot_2', new Float32Array(n));
    gsplatData.addProp('rot_3', new Float32Array(n));

    // near-opaque: these are surface samples, not volumetric fuzz
    gsplatData.addProp('opacity', new Float32Array(n).fill(9));

    const red = gsplatData.getProp('red');
    const green = gsplatData.getProp('green');
    const blue = gsplatData.getProp('blue');
    const dc = (channel: ArrayLike<number> | null) => {
        const out = new Float32Array(n);
        if (channel) {
            for (let i = 0; i < n; i++) {
                out[i] = (channel[i] / 255 - 0.5) / SH_C0;
            }
        }
        return out;
    };
    gsplatData.addProp('f_dc_0', dc(red));
    gsplatData.addProp('f_dc_1', dc(green));
    gsplatData.addProp('f_dc_2', dc(blue));
};

export { isPointCloudFile, POINT_CLOUD_EXTENSIONS, readPointCloud, synthesizeGaussianProps };
