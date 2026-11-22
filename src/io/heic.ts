/**
 * HEIC / HEIF photos (iPhones, many Android phones) turned into JPEG on
 * import, so the rest of the app sees ordinary photos.
 *
 * Browsers on Windows and Linux cannot decode HEIC, so the decoding is done
 * by libheif (LGPL-3.0), loaded on demand from static/libheif as a file of
 * its own (not bundled into the app), in workers so a phone's worth of
 * photos does not stop the page. libheif applies the image's rotation and
 * mirroring; the JPEG carries no EXIF.
 */

const isHeic = (filename: string) => /\.(?:heic|heif)$/i.test(filename);

const jpegName = (filename: string) => filename.replace(/\.(?:heic|heif)$/i, '.jpg');

// the worker: loads libheif once, then turns each file it is sent into a JPEG
const workerSource = (libUrl: string, quality: number) => `
importScripts(${JSON.stringify(`${libUrl}libheif.js`)});
const ready = new Promise((resolve, reject) => {
    try {
        // the object passed in becomes the module; it can be ready before
        // the call returns
        const settings = {
            locateFile: (file) => ${JSON.stringify(libUrl)} + file,
            onRuntimeInitialized: () => resolve(settings)
        };
        libheif(settings);
    } catch (e) {
        reject(e);
    }
});
onmessage = async (e) => {
    const { id, bytes } = e.data;
    try {
        const mod = await ready;
        const decoder = new mod.HeifDecoder();
        const images = decoder.decode(new Uint8Array(bytes));
        if (!images || !images.length) throw new Error('no image in the file');
        // the primary image is listed first
        const image = images[0];
        const width = image.get_width();
        const height = image.get_height();
        const pixels = new ImageData(width, height);
        await new Promise((resolve, reject) => {
            image.display(pixels, d => (d ? resolve(d) : reject(new Error('could not decode the image'))));
        });
        for (const img of images) img.free?.();
        const canvas = new OffscreenCanvas(width, height);
        canvas.getContext('2d').putImageData(pixels, 0, 0);
        const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: ${quality} });
        postMessage({ id, blob });
    } catch (error) {
        postMessage({ id, error: String((error && error.message) || error) });
    }
};`;

let pool: Worker[] | null = null;
let next = 0;
let ids = 0;
type Waiting = { resolve: (b: Blob) => void, reject: (e: Error) => void };
const pending: Map<number, Waiting> = new Map();

const workers = () => {
    if (pool) return pool;
    const libUrl = new URL('static/libheif/', document.baseURI).toString();
    const url = URL.createObjectURL(new Blob([workerSource(libUrl, 0.95)], { type: 'text/javascript' }));
    // each worker holds a whole decoded photo; two keep memory modest
    const count = Math.max(1, Math.min(2, (navigator.hardwareConcurrency || 2) - 1));
    pool = Array.from({ length: count }, () => {
        const worker = new Worker(url);
        worker.onmessage = (e) => {
            const { id, blob, error } = e.data;
            const p = pending.get(id);
            if (!p) return;
            pending.delete(id);
            if (error) p.reject(new Error(error));
            else p.resolve(blob);
        };
        worker.onerror = (e) => {
            // a worker that fails to start fails everything sent to it
            for (const [id, p] of pending) {
                p.reject(new Error(e.message || 'the HEIC decoder failed to load'));
                pending.delete(id);
            }
        };
        return worker;
    });
    URL.revokeObjectURL(url);
    return pool;
};

/** One HEIC / HEIF file as a JPEG file of the same name, ending in .jpg. */
const heicToJpeg = async (file: Blob, filename: string): Promise<File> => {
    const bytes = await file.arrayBuffer();
    const all = workers();
    const worker = all[next++ % all.length];
    const id = ++ids;
    const blob = await new Promise<Blob>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, bytes }, [bytes]);
    });
    return new File([blob], jpegName(filename), { type: 'image/jpeg' });
};

/**
 * The same list with every HEIC / HEIF file turned into a JPEG, renamed to
 * .jpg; `names` (paths in a dropped folder) follow along. Others untouched.
 */
const withHeicAsJpeg = async (files: File[], names: string[] = files.map(f => f.name)) => {
    if (!names.some(isHeic)) return { files, names };
    const out = await Promise.all(files.map((f, i) => (isHeic(names[i]) ? heicToJpeg(f, f.name) : f)));
    return { files: out, names: names.map(n => (isHeic(n) ? jpegName(n) : n)) };
};

export { isHeic, heicToJpeg, jpegName, withHeicAsJpeg };
