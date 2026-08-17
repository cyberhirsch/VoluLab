import { ZipReadFileSystem } from '@playcanvas/splat-transform';

import { BlobReadSource } from '../io';

/**
 * Minimal NumPy .npz reading for TGH checkpoints.
 *
 * An .npz is a zip archive whose entries are .npy files, one per array.
 * ZipReadFileSystem already handles the archive (stored and deflated
 * entries), so all that is left is the .npy header: a magic string, a
 * version, and a python dict literal giving dtype, byte order and shape.
 */

type NpyData = Float32Array | Float64Array | Int32Array | BigInt64Array;

type NpyArray = {
    dtype: string;
    shape: number[];
    data: NpyData;
};

// \x93NUMPY
const NPY_MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59];

/**
 * Parse a complete .npy file. Little-endian C-order arrays only, which is
 * what numpy writes on every platform this data comes from; anything else
 * is rejected loudly rather than misread.
 */
const parseNpy = (bytes: Uint8Array, name: string): NpyArray => {
    if (bytes.length < 10 || NPY_MAGIC.some((b, i) => bytes[i] !== b)) {
        throw new Error(`Not an npy entry: ${name}`);
    }

    const major = bytes[6];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // v1 stores the header length as u16, v2/v3 as u32
    const headerLen = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
    const headerStart = major === 1 ? 10 : 12;
    const header = new TextDecoder().decode(bytes.subarray(headerStart, headerStart + headerLen));

    const descr = header.match(/'descr'\s*:\s*'([^']+)'/)?.[1];
    const fortran = header.match(/'fortran_order'\s*:\s*(True|False)/)?.[1];
    const shapeText = header.match(/'shape'\s*:\s*\(([^)]*)\)/)?.[1];
    if (!descr || !fortran || shapeText === undefined) {
        throw new Error(`Malformed npy header in ${name}`);
    }
    if (fortran === 'True') {
        throw new Error(`Fortran-order array not supported: ${name}`);
    }

    const shape = shapeText.split(',').map(s => s.trim()).filter(s => s.length).map(Number);
    const count = shape.reduce((a, b) => a * b, 1);

    const ctors: { [descr: string]: new (b: ArrayBuffer, o: number, n: number) => NpyData } = {
        '<f4': Float32Array,
        '<f8': Float64Array,
        '<i4': Int32Array,
        '<i8': BigInt64Array
    };
    const Ctor = ctors[descr];
    if (!Ctor) {
        throw new Error(`Unsupported dtype '${descr}' in ${name} (little-endian f4/f8/i4/i8 only)`);
    }

    const dataStart = headerStart + headerLen;
    const byteOffset = bytes.byteOffset + dataStart;
    const bytesPerElement = Number(descr.slice(2));

    // the npy spec aligns the data start, so a zero-copy view normally works;
    // fall back to a copy when the surrounding buffer breaks the alignment
    const data = (byteOffset % bytesPerElement === 0) ?
        new Ctor(bytes.buffer as ArrayBuffer, byteOffset, count) :
        new Ctor(bytes.slice(dataStart, dataStart + count * bytesPerElement).buffer as ArrayBuffer, 0, count);

    return { dtype: descr, shape, data };
};

/**
 * A readable .npz archive. Keys are the numpy array names, i.e. the zip
 * entry names with their '.npy' suffix removed.
 */
class NpzFile {
    private fs: ZipReadFileSystem;

    private constructor(fs: ZipReadFileSystem) {
        this.fs = fs;
    }

    static open(blob: Blob): NpzFile {
        return new NpzFile(new ZipReadFileSystem(new BlobReadSource(blob)));
    }

    async list(): Promise<string[]> {
        const entries = await this.fs.list();
        return entries.map(e => e.replace(/\.npy$/, ''));
    }

    async read(key: string): Promise<NpyArray> {
        const source = await this.fs.createSource(`${key}.npy`);
        try {
            const stream = source.read();
            const bytes = await stream.readAll();
            stream.close();
            return parseNpy(bytes, key);
        } finally {
            source.close();
        }
    }

    close() {
        this.fs.close();
    }
}

export { NpzFile, type NpyArray, type NpyData };
