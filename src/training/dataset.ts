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

// crc32, because a zip entry has to carry one and we are writing the
// headers ourselves (see packDataset)
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[i] = c >>> 0;
    }
    return table;
})();

const crc32 = (data: Uint8Array) => {
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
        c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
};

/**
 * Pack a dropped dataset into an in-memory zip, preserving relative paths
 * so the trainer sees the same folder shape the tools wrote.
 *
 * Written by hand rather than with a zip library, and for one reason: the
 * trainer reads the archive as a stream, and rejects entries whose sizes
 * arrive *after* the data in a trailing descriptor - which is what a
 * streaming writer must emit, since it does not know the size until the
 * data is written. Every dataset packed that way failed to load with
 * "stream reading entries with data descriptors & Stored compression
 * mode", which is why training could never start from a dropped set.
 *
 * We hold the whole file in memory anyway, so the size and checksum are
 * known before the header is written and no descriptor is needed. Stored,
 * because a dataset is jpegs and they do not compress.
 */
const packDataset = async (files: DatasetFile[]): Promise<{ bytes: Uint8Array, name: string }> => {
    const encoder = new TextEncoder();

    type Entry = { name: Uint8Array, data: Uint8Array, crc: number, offset: number };
    const entries: Entry[] = [];

    let size = 0;
    for (const file of files) {
        const data = file.contents ?
            new Uint8Array(await file.contents.arrayBuffer()) :
            new Uint8Array(await (await fetch(file.url)).arrayBuffer());
        const name = encoder.encode(file.filename);
        entries.push({ name, data, crc: crc32(data), offset: size });
        size += 30 + name.length + data.length;          // local header + payload
    }

    const centralOffset = size;
    size += entries.reduce((sum, e) => sum + 46 + e.name.length, 0) + 22;

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

    for (const entry of entries) {
        u32(0x04034b50);            // local file header
        u16(20);                    // version needed
        u16(0);                     // flags: no data descriptor
        u16(0);                     // method: stored
        u16(0);                     // time
        u16(0x21);                  // date: a valid 1980-01-01
        u32(entry.crc);
        u32(entry.data.length);     // compressed size
        u32(entry.data.length);     // uncompressed size
        u16(entry.name.length);
        u16(0);                     // extra length
        raw(entry.name);
        raw(entry.data);
    }

    for (const entry of entries) {
        u32(0x02014b50);            // central directory header
        u16(20);                    // version made by
        u16(20);                    // version needed
        u16(0);
        u16(0);
        u16(0);
        u16(0x21);
        u32(entry.crc);
        u32(entry.data.length);
        u32(entry.data.length);
        u16(entry.name.length);
        u16(0);                     // extra
        u16(0);                     // comment
        u16(0);                     // disk number
        u16(0);                     // internal attributes
        u32(0);                     // external attributes
        u32(entry.offset);
        raw(entry.name);
    }

    u32(0x06054b50);                // end of central directory
    u16(0);
    u16(0);
    u16(entries.length);
    u16(entries.length);
    u32(size - 22 - centralOffset);
    u32(centralOffset);
    u16(0);

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

export { isImageSet, listDirectory, looksLikeDataset, packDataset, type DatasetFile, type DirEntry };
