import { Container } from '@playcanvas/pcui';

import { i18n } from './localization';
import { resolveDropPayload } from '../drop-handler';
import { DatasetOp } from '../edit-ops';
import { Events } from '../events';
import { isImageSet, listDirectory, looksLikeDataset, packDataset } from '../training/dataset';
import { ensureWrite, ingestImages, ingestImagesInPlace, ingestVideo } from '../training/video-ingest';

/**
 * The dataset import node's face, mounted in the node pane like the colour
 * panel and the train face. This is where a dataset enters or is swapped:
 * folder mode, file mode and file-list mode, by picker or by drop. The
 * train node consuming this one only trains - the pickers live here.
 */

class ImportFace extends Container {
    private events: Events;
    private op: DatasetOp | null = null;

    private sourceLabel: HTMLElement;
    private noticeLine: HTMLElement;

    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'import-face'
        };

        super(args);

        this.events = events;

        // the node pane holds elements, not instances - the binding has to
        // travel with the dom
        (this.dom as any).bindNode = (op: DatasetOp | null) => {
            this.op = op;
            this.refresh();
        };

        const section = document.createElement('div');
        section.className = 'tf-section';
        const head = document.createElement('div');
        head.className = 'tf-heading';
        head.textContent = i18n.t('training.dataset');
        section.appendChild(head);
        this.dom.appendChild(section);

        const pickRow = document.createElement('div');
        pickRow.className = 'tf-row';
        section.appendChild(pickRow);

        const button = (label: string, action: () => void) => {
            const el = document.createElement('button');
            el.className = 'tf-button';
            el.type = 'button';
            el.textContent = label;
            el.addEventListener('click', action);
            pickRow.appendChild(el);
            return el;
        };
        button(i18n.t('training.pick-folder'), () => this.pickFolder());
        button(i18n.t('training.pick-files'), () => this.pickFiles());

        this.sourceLabel = document.createElement('div');
        this.sourceLabel.className = 'tf-source';
        section.appendChild(this.sourceLabel);

        this.noticeLine = document.createElement('div');
        this.noticeLine.className = 'tf-notice';
        this.noticeLine.hidden = true;
        section.appendChild(this.noticeLine);

        // drops aimed at this node stay here rather than falling through to
        // the scene importer - folders, file lists and single files alike
        this.dom.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
        this.dom.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!e.dataTransfer) return;
            // resolve synchronously - the DataTransfer dies after the first await
            resolveDropPayload(e.dataTransfer).then(async (payload) => {
                if (payload.directory) {
                    await this.attachDirectory(payload.directory);
                } else if (payload.files.length > 0) {
                    await this.acceptFiles(payload.files.map(f => f.file), payload.files.map(f => f.filename));
                }
            }).catch(() => {});
        });
    }

    private async pickFolder() {
        try {
            // readwrite so a folder of bare photos can take its COLMAP kit
            const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
            await this.attachDirectory(handle);
        } catch (e) {
            // cancelled
        }
    }

    private pickFiles() {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = '.zip,.ply,.jpg,.jpeg,.png,.csv,.json,.txt,.bin,.mp4,.mov,.webm,.mkv,video/*';
        input.onchange = () => {
            const files = Array.from(input.files ?? []);
            if (files.length > 0) this.acceptFiles(files).catch(() => {});
        };
        input.click();
    }

    /**
     * Folder mode: a dataset folder attaches whole (Brush reads it in
     * place), a folder of bare photos gets the COLMAP kit written beside
     * them, anything else is not a dataset.
     */
    private async attachDirectory(handle: FileSystemDirectoryHandle) {
        const entries = await listDirectory(handle);
        const names = entries.map(e => e.path);

        if (looksLikeDataset(names)) {
            this.setSource({ kind: 'directory', handle }, handle.name);
            return;
        }

        if (names.length > 1 && isImageSet(names)) {
            if (await ensureWrite(handle)) {
                await ingestImagesInPlace(handle, entries, this.events);
                this.markAwaiting();
            } else {
                // the browser refused to write into the dropped folder:
                // fall back to copying the photos out beside a fresh kit
                const files = await Promise.all(entries.map(e => e.handle.getFile()));
                if (await ingestImages(files, this.events)) {
                    this.markAwaiting();
                }
            }
            return;
        }

        this.notice(i18n.t('import.folder-unrecognized'));
    }

    /** File and file-list mode: route whatever was picked or dropped. */
    private async acceptFiles(files: File[], names?: string[]) {
        const filenames = names ?? files.map(f => f.name);
        const lower = filenames.map(f => f.toLowerCase());

        if (files.length === 1) {
            const file = files[0];
            const name = lower[0];
            if (file.type.startsWith('video/') || ['.mp4', '.mov', '.webm', '.mkv'].some(ext => name.endsWith(ext))) {
                if (await ingestVideo(file, this.events)) this.markAwaiting();
            } else if (name.endsWith('.zip') || name.endsWith('.ply')) {
                const bytes = new Uint8Array(await file.arrayBuffer());
                this.setSource({ kind: 'bytes', bytes, name: file.name }, file.name);
            } else if (isImageSet([name])) {
                this.notice(i18n.t('import.single-image'));
            } else {
                this.notice(i18n.t('import.dataset-needs-images'));
            }
            return;
        }

        if (looksLikeDataset(filenames)) {
            // several files forming one dataset: pack them into a zip
            this.events.fire('startSpinner');
            try {
                const { bytes, name } = await packDataset(files.map((f, i) => ({ filename: filenames[i], contents: f })));
                this.setSource({ kind: 'bytes', bytes, name: `${name}.zip` }, name);
            } finally {
                this.events.fire('stopSpinner');
            }
            return;
        }

        if (isImageSet(lower)) {
            // bare photos: copy them out with the COLMAP kit
            if (await ingestImages(files, this.events)) {
                this.markAwaiting();
            }
            return;
        }

        this.notice(i18n.t('import.folder-unrecognized'));
    }

    private setSource(source: unknown, name: string) {
        if (!this.op) return;
        this.op.setSource(source, name);
        this.events.fire('edit.changed');
        this.refresh();
    }

    /** The dataset is out being posed; the node waits for its return. */
    private markAwaiting() {
        if (this.op) {
            this.op.markAwaiting(i18n.t('training.awaiting-poses'));
            this.events.fire('edit.changed');
        }
        this.refresh();
    }

    private notice(text: string) {
        this.noticeLine.textContent = text;
        this.noticeLine.hidden = false;
    }

    private refresh() {
        const op = this.op;
        if (!op) return;
        this.noticeLine.hidden = true;
        this.sourceLabel.textContent = op.source || op.awaitingPoses ?
            op.sourceName :
            i18n.t('training.no-dataset');
    }
}

export { ImportFace };
