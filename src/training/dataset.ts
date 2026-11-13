import { BlobZipEntry, centralHeader, crc32, endRecord, localHeader, storedZipBlob } from '../io/write/stored-zip';

/**
 * Recognising and packaging capture datasets on their way to a train node.
 *
 * A dataset is a set of files - posed cameras plus images - and the
 * trainer wants it as one thing. Dropped sets are packed into a zip
 * (Brush detects zips on its own), so a nerfstudio folder, a COLMAP
 * export or a RealityCapture csv with its photos all arrive the same way:
 * a blob with a name. The blob is built from the files' own blobs, so
 * packing does not copy the images; they are read into memory only when
 * training starts.
 */

type DatasetFile = {
    filename: string;
    contents?: Blob;
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

// what operating systems leave in folders, and what the COLMAP script kit
// writes beside the photos: none of it is part of a dataset, and a single
// one would stop a folder of photos from reading as a set of photos
const IGNORED_FILES = new Set([
    '.ds_store', 'thumbs.db', 'desktop.ini',
    'run-colmap.sh', 'run-colmap.bat', 'readme.txt', 'colmap.db', 'colmap.db-shm', 'colmap.db-wal'
]);

/** Is this file (a name or a folder-relative path) noise rather than data? */
const isIgnoredFile = (path: string): boolean => {
    const name = path.split('/').pop().toLowerCase();
    return IGNORED_FILES.has(name) || name.startsWith('._');
};

/**
 * Flatten a picked directory into file handles with folder-relative paths,
 * the same shape a folder drop produces - so folder mode and drop mode
 * route through the same classifiers.
 */
const listDirectory = async (dir: FileSystemDirectoryHandle, prefix = ''): Promise<DirEntry[]> => {
    const out: DirEntry[] = [];
    for await (const value of dir.values()) {
        if (value.kind === 'file' && isIgnoredFile(value.name)) {
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
 * Pack a dropped dataset into a zip, preserving relative paths so the
 * trainer sees the same folder shape the tools wrote.
 *
 * Every local header is complete, with no data descriptors (see
 * storedZip): the trainer reads the archive as a stream and rejects
 * entries whose sizes arrive after the data. Every dataset packed by a
 * streaming zip writer failed to load with "stream reading entries with
 * data descriptors & Stored compression mode", which is why training
 * could never start from a dropped set.
 *
 * The archive is a Blob over the files' own blobs (storedZipBlob): the
 * image bytes are not copied, and are read once each for a checksum.
 */
const packDataset = async (files: DatasetFile[], signal?: AbortSignal): Promise<{ zip: Blob, name: string }> => {
    const entries: BlobZipEntry[] = [];
    for (const file of files) {
        signal?.throwIfAborted();
        entries.push({
            name: file.filename,
            data: file.contents ?? await (await fetch(file.url, { signal })).blob()
        });
    }
    const zip = await storedZipBlob(entries, signal);

    // name the dataset after the pose file that defines it
    const poseFile = files.find((f) => {
        const lower = f.filename.toLowerCase();
        return lower.endsWith('transforms.json') || lower.endsWith('.csv') ||
            lower.endsWith('cameras.txt') || lower.endsWith('cameras.bin');
    });
    const name = poseFile ?
        (poseFile.filename.split('/')[0] || 'dataset') :
        'dataset';

    return { zip, name: name === poseFile?.filename ? 'dataset' : name };
};

/** The size of a dataset held as bytes or as a blob. */
const datasetSize = (data: Uint8Array | Blob) => (data instanceof Blob ? data.size : data.length);

/**
 * Add one stored file to an existing zip, without unpacking it.
 *
 * The new entry goes between the last entry and the central directory,
 * so every existing entry keeps its offset and its central record is
 * copied through as it is - whatever compression it used. Only the end
 * record changes. Used to put a seed `init.ply` into a dataset that is
 * already packed.
 *
 * Only the end of the archive is read; the result is a Blob over slices
 * of the original, so the entries already in it are not copied.
 */
const addToZip = async (zip: Uint8Array | Blob, filename: string, data: Uint8Array): Promise<Blob> => {
    const blob = zip instanceof Blob ? zip : new Blob([zip as BlobPart]);

    // the end record sits at the very end, unless a comment follows it
    const tailStart = Math.max(0, blob.size - 22 - 0xffff);
    const tail = new Uint8Array(await blob.slice(tailStart).arrayBuffer());
    const src = new DataView(tail.buffer);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
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
    const header = localHeader(name, crc, data.length);
    const localSize = header.length + data.length;
    if (centralOffset + localSize + centralSize + 46 + name.length + 22 > 0xffffffff) {
        throw new Error('archive too large: more than 4 GB');
    }

    return new Blob([
        blob.slice(0, centralOffset),
        header,
        data as BlobPart,
        blob.slice(centralOffset, centralOffset + centralSize),
        centralHeader(name, crc, data.length, centralOffset),
        endRecord(count + 1, centralSize + 46 + name.length, centralOffset + localSize)
    ], { type: 'application/zip' });
};

export { addToZip, datasetSize, isIgnoredFile, isImageSet, listDirectory, looksLikeDataset, packDataset, type DatasetFile, type DirEntry };
