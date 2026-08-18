import { path } from 'playcanvas';

class DroppedFile {
    filename: string;
    file: File;
    handle?: FileSystemFileHandle;

    constructor(filename: string, file: File, handle?: FileSystemFileHandle) {
        this.filename = filename;
        this.file = file;
        this.handle = handle;
    }
}

type DropHandlerFunc = (files: Array<DroppedFile>, resetScene: boolean) => void;

type DropPayload = {
    // present when the drop was a single folder and the browser can hand
    // over its handle - callers that can use the folder itself (the train
    // node) get it without reading a byte
    directory?: FileSystemDirectoryHandle;
    files: Array<DroppedFile>;
};

const resolveDirectories = (entries: Array<FileSystemEntry>): Promise<Array<FileSystemFileEntry>> => {
    const promises: Promise<Array<FileSystemFileEntry>>[] = [];
    const result: Array<FileSystemFileEntry> = [];

    entries.forEach((entry) => {
        if (entry.name === '.DS_Store') {
            return;
        }

        if (entry.isFile) {
            result.push(entry as FileSystemFileEntry);
        } else if (entry.isDirectory) {
            promises.push(
                new Promise<any>((resolve, reject) => {
                    const reader = (entry as FileSystemDirectoryEntry).createReader();

                    const p: Promise<any>[] = [];

                    const read = () => {
                        reader.readEntries((children: Array<FileSystemEntry>) => {
                            if (children.length > 0) {
                                p.push(resolveDirectories(children));
                                read();
                            } else {
                                Promise.all(p).then((children: Array<Array<FileSystemFileEntry>>) => {
                                    resolve(children.flat());
                                });
                            }
                        });
                    };
                    read();
                })
            );
        }
    });

    return Promise.all(promises).then((children: Array<Array<FileSystemFileEntry>>) => {
        return result.concat(...children);
    });
};

const removeCommonPrefix = (urls: Array<DroppedFile>) => {
    const split = (pathname: string) => {
        const parts = pathname.split(path.delimiter);
        const base = parts[0];
        const rest = parts.slice(1).join(path.delimiter);
        return [base, rest];
    };
    while (true) {
        const parts = split(urls[0].filename);
        if (parts[1].length === 0) {
            return;
        }
        for (let i = 1; i < urls.length; ++i) {
            const other = split(urls[i].filename);
            if (parts[0] !== other[0]) {
                return;
            }
        }
        for (let i = 0; i < urls.length; ++i) {
            urls[i].filename = split(urls[i].filename)[1];
        }
    }
};

/**
 * Resolve a DataTransfer into dropped files, folders traversed recursively
 * and the common path prefix removed. Must be called synchronously from the
 * drop event - the DataTransfer's items are dead after the first await.
 */
const resolveDropPayload = async (dataTransfer: DataTransfer): Promise<DropPayload> => {
    const items = Array.from(dataTransfer.items);

    // capture everything the DataTransfer offers before any await invalidates it
    const entries = items
    .map(item => item.webkitGetAsEntry())
    .filter(v => v);
    const handlePromise = (items.length === 1 && items[0].getAsFileSystemHandle) ?
        items[0].getAsFileSystemHandle().catch((): FileSystemHandle => null) :
        null;

    const entriesToFiles = async () => {
        const resolvedEntries = await resolveDirectories(entries);
        const files = await Promise.all(
            resolvedEntries.map((entry) => {
                return new Promise<DroppedFile>((resolve, reject) => {
                    entry.file((entryFile: any) => {
                        resolve(new DroppedFile(entry.fullPath.substring(1), entryFile));
                    });
                });
            })
        );
        if (files.length > 1) {
            // if all files share a common filename prefix, remove it
            removeCommonPrefix(files);
        }
        return files;
    };

    const handle = handlePromise ? await handlePromise : null;

    // a single folder: hand over its handle alongside the traversal
    if (handle?.kind === 'directory') {
        return { directory: handle as FileSystemDirectoryHandle, files: await entriesToFiles() };
    }

    // a single file: propagate the filesystemfilehandle so documents can save in place
    if (handle?.kind === 'file') {
        const fileHandle = handle as FileSystemFileHandle;
        const file = await fileHandle.getFile();
        return { files: [new DroppedFile(file.name, file, fileHandle)] };
    }

    return { files: await entriesToFiles() };
};

// configure drag and drop
const CreateDropHandler = (target: HTMLElement, dropHandler: DropHandlerFunc) => {

    const dragstart = (ev: DragEvent) => {
        ev.preventDefault();
        ev.stopPropagation();
        ev.dataTransfer.effectAllowed = 'all';
    };

    const dragover = (ev: DragEvent) => {
        ev.preventDefault();
        ev.stopPropagation();
        ev.dataTransfer.effectAllowed = 'all';
    };

    const drop = async (ev: DragEvent) => {
        ev.preventDefault();

        const payload = await resolveDropPayload(ev.dataTransfer);
        if (payload.files.length > 0) {
            dropHandler(payload.files, ev.shiftKey);
        }
    };

    target.addEventListener('dragstart', dragstart, true);
    target.addEventListener('dragover', dragover, true);
    target.addEventListener('drop', drop, true);
};

export { CreateDropHandler, resolveDropPayload, DroppedFile, type DropPayload };
