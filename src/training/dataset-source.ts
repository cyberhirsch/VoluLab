import { ZipReadFileSystem } from '@playcanvas/splat-transform';

import { BridgeImage } from './bridge-client';
import { TrainSource } from './brush-engine';
import { countFiles, listDirectory } from './dataset';
import { BlobReadSource } from '../io';

/**
 * What an import node can hold.
 *
 * The first three are datasets the trainer reads as they are - posed, or
 * at least claiming to be. The last two are raw captures, still without
 * poses: bare photos and a video. A pose node turns those into the first
 * kind; the trainer never sees them.
 */
type DatasetSource =
    | TrainSource
    | { kind: 'images'; images: BridgeImage[] }
    | { kind: 'video'; file: File };

/** Is this a source the trainer can read as it is? */
const isTrainable = (source: unknown): source is TrainSource => {
    const kind = (source as { kind?: string } | null)?.kind;
    return kind === 'bytes' || kind === 'directory' || kind === 'url';
};

const isRawCapture = (source: unknown): source is { kind: 'images'; images: BridgeImage[] } | { kind: 'video'; file: File } => {
    const kind = (source as { kind?: string } | null)?.kind;
    return kind === 'images' || kind === 'video';
};

/** a byte source as one blob */
const blobOf = async (source: TrainSource): Promise<Blob | null> => {
    if (source.kind === 'bytes') return source.bytes instanceof Blob ? source.bytes : new Blob([source.bytes as BlobPart]);
    if (source.kind === 'url') return await (await fetch(source.url)).blob();
    return null;
};

/**
 * A posed dataset opened for reading single files: a zip, or a folder.
 * `list` gives every file by its path; `read` reads one. A .ply alone is
 * a point cloud and holds no files to list.
 */
type DatasetReader = {
    list: string[];
    read: (path: string) => Promise<Uint8Array>;
    close: () => void;
};

const openDataset = async (source: TrainSource): Promise<DatasetReader | null> => {
    if (source.kind === 'directory') {
        const entries = await listDirectory(source.handle);
        const byPath = new Map(entries.map(e => [e.path, e.handle]));
        return {
            list: entries.map(e => e.path),
            read: async path => new Uint8Array(await (await byPath.get(path).getFile()).arrayBuffer()),
            close: () => {}
        };
    }

    const name = source.kind === 'bytes' ? source.name : source.url;
    if (!/\.zip$/i.test(name ?? '') && source.kind !== 'bytes') return null;
    const blob = await blobOf(source);
    if (!blob) return null;
    // a zip starts with a local header; anything else (a .ply) has no files
    const magic = new DataView(await blob.slice(0, 4).arrayBuffer());
    if (blob.size < 4 || magic.getUint32(0, true) !== 0x04034b50) return null;

    const zip = new ZipReadFileSystem(new BlobReadSource(blob));
    const list = (await zip.list()).filter(n => !n.endsWith('/'));
    return {
        list,
        read: async (path) => {
            const entry = await zip.createSource(path);
            const bytes = await entry.read().readAll();
            entry.close();
            return bytes;
        },
        close: () => zip.close()
    };
};

/** The files an import node holds, by kind; null when that cannot be told. */
const countSource = async (source: unknown) => {
    if (!source) return null;
    const s = source as DatasetSource;
    if (s.kind === 'images') return countFiles(s.images.map(i => i.name));
    if (s.kind === 'video') return countFiles([s.file.name]);
    const reader = await openDataset(s);
    if (reader) {
        const counts = countFiles(reader.list);
        reader.close();
        return counts;
    }
    // a point cloud, or a url that is not a zip: one file
    return { images: 0, videos: 0, poses: 0, other: 1 };
};

export { countSource, isRawCapture, isTrainable, openDataset, type DatasetReader, type DatasetSource };
