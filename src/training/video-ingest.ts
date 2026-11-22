import { DirEntry } from './dataset';
import { Events } from '../events';
import { i18n } from '../ui/localization';

/**
 * Turn a video into a training dataset - as far as the browser honestly can.
 *
 * Training needs posed images, and pose estimation is COLMAP's job, which
 * has no in-browser form. So this extracts frames into a directory the user
 * picks, writes a ready-to-run COLMAP script next to them, and the user
 * returns with the processed folder. One external command, everything else
 * in-app.
 *
 * Extraction is seek-based - step the video element, draw to canvas, encode
 * JPEG. Container-agnostic and dependency-free; a WebCodecs fast path is a
 * later upgrade.
 */

const COLMAP_STEPS = [
    'colmap feature_extractor --database_path colmap.db --image_path images --ImageReader.camera_model OPENCV --ImageReader.single_camera 1',
    'colmap sequential_matcher --database_path colmap.db',
    'colmap mapper --database_path colmap.db --image_path images --output_path sparse',
    'colmap model_converter --input_path sparse/0 --output_path sparse/0 --output_type TXT'
];

const README = `This folder holds video frames ready for pose estimation.

1. Install COLMAP (https://colmap.github.io) so the 'colmap' command works.
2. Run run-colmap.bat (Windows) or run-colmap.sh (Mac/Linux) in this folder.
3. Back in VoluLab's training pane, pick this folder as the dataset.

The training pane reads the COLMAP output (sparse/0) directly.
`;

// frames extracted per second of video, and a hard cap so an hour of video
// does not become ten thousand images
const DEFAULT_FPS = 2;
const MAX_FRAMES = 600;
// how long one seek may take before the video counts as unreadable
const SEEK_TIMEOUT_MS = 15000;

const writeFile = async (dir: FileSystemDirectoryHandle, name: string, data: Blob | string) => {
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
};

/**
 * The kit is only useful if the user knows what to do with it - say so,
 * concretely, the moment it lands.
 */
const explainColmapStep = (events: Events) => {
    return events.invoke('showPopup', {
        type: 'info',
        header: i18n.t('training.dataset'),
        message: i18n.t('import.colmap-howto')
    });
};

/** The run-me scripts and readme that turn an images folder into poses. */
const writeColmapKit = async (dir: FileSystemDirectoryHandle) => {
    const script = COLMAP_STEPS.join('\n');
    await writeFile(dir, 'run-colmap.sh', `#!/usr/bin/env bash\nset -e\ncd "$(dirname "$0")"\nmkdir -p sparse\n${script}\n`);
    await writeFile(dir, 'run-colmap.bat', `@echo off\ncd /d "%~dp0"\nif not exist sparse mkdir sparse\n${COLMAP_STEPS.join('\r\n')}\r\n`);
    await writeFile(dir, 'README.txt', README);
};

/**
 * Ask the browser for write access to a folder we already hold - drops and
 * read-mode pickers hand over read-only handles.
 */
const ensureWrite = async (handle: FileSystemDirectoryHandle): Promise<boolean> => {
    const h = handle as any;
    try {
        if (await h.queryPermission?.({ mode: 'readwrite' }) === 'granted') {
            return true;
        }
        return await h.requestPermission?.({ mode: 'readwrite' }) === 'granted';
    } catch (e) {
        return false;
    }
};

/**
 * Write the COLMAP kit into the folder the photos already live in - folder
 * mode's counterpart of ingestImages, with no second picker. Photos not
 * already under images/ are copied there so the scripts find them.
 * Returns true when the kit was written.
 */
const ingestImagesInPlace = async (dir: FileSystemDirectoryHandle, entries: DirEntry[], events: Events): Promise<boolean> => {
    events.fire('startSpinner');
    try {
        const images = await dir.getDirectoryHandle('images', { create: true });
        for (const entry of entries) {
            if (entry.path.startsWith('images/')) {
                continue; // already where the scripts expect it
            }
            const file = await entry.handle.getFile();
            await writeFile(images, file.name, file);
        }
        await writeColmapKit(dir);
        await explainColmapStep(events);
        return true;
    } finally {
        events.fire('stopSpinner');
    }
};

/**
 * Copy a set of dropped images into a user-picked directory along with the
 * COLMAP scripts - the same shape ingestVideo produces, minus the
 * extraction. Returns true when the dataset directory was written.
 */
const ingestImages = async (files: File[], events: Events): Promise<boolean> => {
    let dir: FileSystemDirectoryHandle;
    try {
        dir = await window.showDirectoryPicker({ mode: 'readwrite' } as any);
    } catch (e) {
        return false; // cancelled
    }

    events.fire('startSpinner');
    try {
        const images = await dir.getDirectoryHandle('images', { create: true });
        for (const file of files) {
            await writeFile(images, file.name, file);
        }
        await writeColmapKit(dir);
        await explainColmapStep(events);
        return true;
    } finally {
        events.fire('stopSpinner');
    }
};

/**
 * Step through `file` and hand every extracted frame to `onFrame` as a
 * jpeg blob - the caller decides whether frames land on disk (the script
 * kit) or go straight to the bridge. `fps` frames a second are taken,
 * the import node's subset says how many.
 */
const extractVideoFrames = async (file: File, onFrame: (name: string, blob: Blob) => Promise<void>, fps = DEFAULT_FPS) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    const url = URL.createObjectURL(file);
    video.src = url;

    // a video the browser cannot decode may never answer a seek: every wait
    // ends in an error or a timeout rather than hanging the import
    const waitFor = (event: 'loadedmetadata' | 'seeked') => new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(i18n.t('training.video-unreadable')));
        }, SEEK_TIMEOUT_MS);
        const done = () => {
            clearTimeout(timer);
            resolve();
        };
        if (event === 'seeked') {
            video.onseeked = done;
        } else {
            video.onloadedmetadata = done;
        }
        video.onerror = () => {
            clearTimeout(timer);
            reject(new Error(i18n.t('training.video-unreadable')));
        };
    });

    try {
        await waitFor('loadedmetadata');

        const step = 1 / fps;
        const count = Math.min(Math.floor(video.duration * fps), MAX_FRAMES);
        if (!(count > 0) || !video.videoWidth || !video.videoHeight) {
            throw new Error(i18n.t('training.video-unreadable'));
        }

        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');

        for (let i = 0; i < count; i++) {
            const seeked = waitFor('seeked');
            video.currentTime = Math.min(i * step, Math.max(video.duration - 0.05, 0));
            await seeked;
            ctx.drawImage(video, 0, 0);
            const blob = await new Promise<Blob>((resolve, reject) => {
                canvas.toBlob(b => (b ? resolve(b) : reject(new Error(i18n.t('training.video-unreadable')))), 'image/jpeg', 0.95);
            });
            await onFrame(`frame_${String(i).padStart(5, '0')}.jpg`, blob);
        }
    } finally {
        video.removeAttribute('src');
        video.load();
        URL.revokeObjectURL(url);
    }
};

/**
 * Extract frames from `file` into a user-picked directory along with the
 * COLMAP scripts. Returns true when the dataset directory was written.
 */
const ingestVideo = async (file: File, events: Events): Promise<boolean> => {
    let dir: FileSystemDirectoryHandle;
    try {
        dir = await window.showDirectoryPicker({ mode: 'readwrite' } as any);
    } catch (e) {
        return false; // cancelled
    }

    events.fire('startSpinner');
    try {
        const images = await dir.getDirectoryHandle('images', { create: true });

        await extractVideoFrames(file, (name, blob) => writeFile(images, name, blob));

        await writeColmapKit(dir);
        await explainColmapStep(events);

        return true;
    } finally {
        events.fire('stopSpinner');
    }
};

export { ensureWrite, extractVideoFrames, ingestImages, ingestImagesInPlace, ingestVideo };
