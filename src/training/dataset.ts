import { MemoryFileSystem, ZipFileSystem } from '@playcanvas/splat-transform';

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
 */
const packDataset = async (files: DatasetFile[]): Promise<{ bytes: Uint8Array, name: string }> => {
    const memFs = new MemoryFileSystem();
    const zipName = 'dataset.zip';
    const zipWriter = await memFs.createWriter(zipName);
    const zipFs = new ZipFileSystem(zipWriter);

    for (const file of files) {
        const data = file.contents ?
            new Uint8Array(await file.contents.arrayBuffer()) :
            new Uint8Array(await (await fetch(file.url)).arrayBuffer());
        const writer = await zipFs.createWriter(file.filename);
        await writer.write(data);
        await writer.close();
    }
    await zipFs.close();

    const bytes = memFs.results.get(zipName);

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
