import { crc32, storedZip } from '../io/write/stored-zip';

/**
 * Recognising and packaging capture datasets on their way to a train node.
 *
 * A dataset is a set of files - posed cameras plus images - and the
 * trainer wants it as one thing. Dropped sets are packed into an
 * in-memory zip (Brush detects zips on its own), so a nerfstudio folder,
 * a COLMAP export or a RealityCapture csv with its photos all arrive the
 * same way: bytes with a name.
 */

type DatasetFile = {
    filename: string;
    contents?: File;
    url?: string;
};

const IMAGE_RE = /\.(?:jpg|jpeg|png)$/;

/** Every file is a photo: a dataset still waiting for its poses. */
const isImageSet = (filenames: string[]): boolean => {
    return filenames.length > 0 && filenames.every(f => IMAGE_RE.test(f.toLowerCase()));
};

type DirEntry = {
    path: string;
    handle: FileSystemFileHandle;
};

/**
 * Flatten a picked directory into file handles with folder-relative paths,
 * the same shape a folder drop produces - so folder mode and drop mode
 * route through the same classifiers.
 */
const listDirectory = async (dir: FileSystemDirectoryHandle, prefix = ''): Promise<DirEntry[]> => {
    const out: DirEntry[] = [];
    for await (const value of dir.values()) {
        if (value.name === '.DS_Store') {
            continue;
        }
        if (value.kind === 'file') {
            out.push({ path: `${prefix}${value.name}`, handle: value as FileSystemFileHandle });
        } else {
            out.push(...await listDirectory(value as FileSystemDirectoryHandle, `${prefix}${value.name}/`));
        }
    }
    return out;
};

/**
 * Does this set of filenames look like a capture dataset rather than a
 * pile of unrelated imports? Pose files alone are not enough for the
 * photo-based formats - training needs the images beside them.
 */
const looksLikeDataset = (filenames: string[]): boolean => {
    const lower = filenames.map(f => f.toLowerCase());
    const has = (suffix: string) => lower.some(f => f.endsWith(suffix));
    const hasImages = lower.some(f => IMAGE_RE.test(f));

    // nerfstudio: transforms.json + its images
    if (has('transforms.json') && hasImages) return true;

    // RealityCapture: a csv of registered cameras + its images
    if (has('.csv') && hasImages) return true;

    // COLMAP: the sparse model pair; images usually ride along but the
    // pair alone is unambiguous
    const cameras = has('cameras.txt') || has('cameras.bin');
    const colmapImages = has('images.txt') || has('images.bin');
    return cameras && colmapImages;
};

/**
 * Pack a dropped dataset into an in-memory zip, preserving relative paths
 * so the trainer sees the same folder shape the tools wrote.
 *
 * Written whole, with no data descriptors (see storedZip): the trainer
 * reads the archive as a stream and rejects entries whose sizes arrive
 * after the data. Every dataset packed by a streaming zip writer failed to
 * load with "stream reading entries with data descriptors & Stored
 * compression mode", which is why training could never start from a
 * dropped set.
 */
const packDataset = async (files: DatasetFile[]): Promise<{ bytes: Uint8Array, name: string }> => {
    const entries = await Promise.all(files.map(async file => ({
        name: file.filename,
        data: file.contents ?
            new Uint8Array(await file.contents.arrayBuffer()) :
            new Uint8Array(await (await fetch(file.url)).arrayBuffer())
    })));
    const bytes = storedZip(entries);

    // name the dataset after the pose file that defines it
    const poseFile = files.find((f) => {
        const lower = f.filename.toLowerCase();
        return lower.endsWith('transforms.json') || lower.endsWith('.csv') ||
            lower.endsWith('cameras.txt') || lower.endsWith('cameras.bin');
    });
    const name = poseFile ?
        (poseFile.filename.split('/')[0] || 'dataset') :
        'dataset';

    return { bytes, name: name === poseFile?.filename ? 'dataset' : name };
};

/**
 * Add one stored file to an existing zip, without unpacking it.
 *
 * The new entry goes between the last entry and the central directory,
 * so every existing entry keeps its offset and its central record is
 * copied through as it is - whatever compression it used. Only the end
 * record changes. Used to put a seed `init.ply` into a dataset that is
 * already packed.
 */
const addToZip = (zip: Uint8Array, filename: string, data: Uint8Array): Uint8Array => {
    const src = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);

    // the end record sits at the very end, unless a comment follows it
    let eocd = -1;
    for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
        if (src.getUint32(i, true) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) {
        throw new Error('the dataset is not a zip');
    }

    const count = src.getUint16(eocd + 10, true);
    const centralSize = src.getUint32(eocd + 12, true);
    const centralOffset = src.getUint32(eocd + 16, true);
    if (count === 0xffff || centralOffset === 0xffffffff) {
        throw new Error('the dataset is a zip64 archive, which a seed cannot be added to');
    }

    const name = new TextEncoder().encode(filename);
    const crc = crc32(data);
    const localSize = 30 + name.length + data.length;
    const size = centralOffset + localSize + centralSize + 46 + name.length + 22;

    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    let at = 0;

    const u32 = (value: number) => {
        view.setUint32(at, value, true);
        at += 4;
    };
    const u16 = (value: number) => {
        view.setUint16(at, value, true);
        at += 2;
    };
    const raw = (value: Uint8Array) => {
        bytes.set(value, at);
        at += value.length;
    };

    raw(zip.subarray(0, centralOffset));

    u32(0x04034b50);                // local file header, as packDataset writes it
    u16(20);
    u16(0);
    u16(0);
    u16(0);
    u16(0x21);
    u32(crc);
    u32(data.length);
    u32(data.length);
    u16(name.length);
    u16(0);
    raw(name);
    raw(data);

    raw(zip.subarray(centralOffset, centralOffset + centralSize));

    u32(0x02014b50);                // its central record
    u16(20);
    u16(20);
    u16(0);
    u16(0);
    u16(0);
    u16(0x21);
    u32(crc);
    u32(data.length);
    u32(data.length);
    u16(name.length);
    u16(0);
    u16(0);
    u16(0);
    u16(0);
    u32(0);
    u32(centralOffset);
    raw(name);

    u32(0x06054b50);                // end of central directory, one entry more
    u16(0);
    u16(0);
    u16(count + 1);
    u16(count + 1);
    u32(centralSize + 46 + name.length);
    u32(centralOffset + localSize);
    u16(0);

    return bytes;
};

export { addToZip, isImageSet, listDirectory, looksLikeDataset, packDataset, type DatasetFile, type DirEntry };
