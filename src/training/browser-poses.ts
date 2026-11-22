/**
 * Camera poses in the browser: COLMAP's own SIFT, geometric verification,
 * view-graph calibration and global mapper, compiled to WebAssembly by the
 * colmap-wasm package (BSD-3), with SIFT matching on WebGPU. No helper.
 *
 * Like Brush, the package is not bundled: rollup copies it to
 * static/colmap-wasm and it is imported from a computed URL, so its worker
 * and wasm resolve next to it through import.meta.url.
 *
 * Limits of the package: every image shares one SIMPLE_PINHOLE camera, so
 * all images must be the same size; matching needs WebGPU. Of a pose
 * node's options it takes the feature cap and the sequential overlap.
 */

import type { BridgeImage } from './bridge-client';
import type { PoseOptions, PoseReport } from '../edit-ops';

type ColmapWasm = typeof import('colmap-wasm');
type Features = import('colmap-wasm').Features;
type PairMatches = import('colmap-wasm').PairMatches;

/**
 * stage keys the ui maps to text (features, matching, mapping, convert),
 * with how far the stage is, or the bridge's own detail
 */
type StageFn = (stage: string, detail?: string | { done: number, total: number }) => void;

type PoseRun = { files: { path: string, data: Uint8Array }[], report: PoseReport };

let pkg: Promise<ColmapWasm> | null = null;

const loadPackage = () => {
    if (!pkg) {
        const url = new URL('static/colmap-wasm/dist/index.js', document.baseURI).toString();
        pkg = import(url) as Promise<ColmapWasm>;
        pkg.catch(() => {
            pkg = null;
        });
    }
    return pkg;
};

/** Can this browser estimate poses itself? Needs a WebGPU adapter. */
const browserPosesReady = async (): Promise<boolean> => {
    try {
        return !!(await navigator.gpu?.requestAdapter());
    } catch (e) {
        return false;
    }
};

/**
 * Every image the same size, as decoded - the one shared camera needs
 * it. Checked up front: the package only finds out after extracting
 * features from every image, minutes in. Decoded the way the package
 * decodes (EXIF orientation applied), a few at a time.
 */
const checkSameSize = async (images: BridgeImage[], signal?: AbortSignal) => {
    let size: string | null = null;
    for (let i = 0; i < images.length; i += 4) {
        signal?.throwIfAborted();
        const sizes = await Promise.all(images.slice(i, i + 4).map(async (image) => {
            const bmp = await createImageBitmap(image.data);
            const s = `${bmp.width}x${bmp.height}`;
            bmp.close();
            return s;
        }));
        for (const s of sizes) {
            size ??= s;
            if (s !== size) {
                throw new Error(`the images differ in size (${size}, ${s}); in-browser poses need one size`);
            }
        }
    }
};

/**
 * The SIFT features of one image, cut to the `max` of largest scale, in
 * their order: COLMAP's max_num_features likewise drops the finest
 * octaves first. The scale of a keypoint is the root of its affine
 * shape's determinant.
 */
const capFeatures = (f: Features, max: number): Features => {
    if (f.count <= max) return f;
    const scale = new Float32Array(f.count);
    for (let i = 0; i < f.count; i++) {
        const k = 6 * i;
        scale[i] = Math.abs(f.keypoints[k + 2] * f.keypoints[k + 5] - f.keypoints[k + 3] * f.keypoints[k + 4]);
    }
    const order = Array.from({ length: f.count }, (_, i) => i).sort((a, b) => scale[b] - scale[a]);
    const keep = order.slice(0, max).sort((a, b) => a - b);
    const keypoints = new Float32Array(keep.length * 6);
    const descriptors = new Uint8Array(keep.length * 128);
    const colors = new Uint8Array(keep.length * 3);
    keep.forEach((i, k) => {
        keypoints.set(f.keypoints.subarray(6 * i, 6 * i + 6), 6 * k);
        descriptors.set(f.descriptors.subarray(128 * i, 128 * i + 128), 128 * k);
        colors.set(f.colors.subarray(3 * i, 3 * i + 3), 3 * k);
    });
    return { width: f.width, height: f.height, count: keep.length, keypoints, descriptors, colors };
};

/**
 * Estimate poses for the images and return the sparse model files
 * (sparse/0/cameras.bin, images.bin, points3D.bin) and what the run came
 * to. Throws when the images differ in size, or when the reconstruction
 * registers fewer than two images. Aborting `signal` stops the run.
 *
 * The package's estimatePoses is done here step by step, so the features
 * can be capped between extraction and matching. Of the options only the
 * feature cap and the sequential overlap apply: the camera is one shared
 * SIMPLE_PINHOLE whatever the node says. The mapper is one global solve
 * that reports no progress of its own; its log lines go to `onLog`.
 */
const estimatePosesInBrowser = async (
    images: BridgeImage[],
    matcher: 'sequential' | 'exhaustive',
    onStage: StageFn,
    signal: AbortSignal | undefined,
    options: PoseOptions,
    onLog?: (line: string) => void
): Promise<PoseRun> => {
    onStage('features');
    await checkSameSize(images, signal);
    const colmap = await loadPackage();
    signal?.throwIfAborted();

    const extracted = await colmap.extractFeatures(images, {
        signal,
        onProgress: (done, total) => onStage('features', { done, total })
    });
    const features = extracted.map(f => capFeatures(f, options.maxFeatures));
    signal?.throwIfAborted();

    const pairs = matcher === 'sequential' ?
        colmap.sequentialPairs(images.length, { window: options.overlap }) :
        colmap.exhaustivePairs(images.length);
    onStage('matching', { done: 0, total: pairs.length });
    const sift = await colmap.SiftMatcher.create();
    let matches: PairMatches[];
    try {
        matches = await sift.match(features.map(f => f.descriptors), pairs, {
            onProgress: (done, total) => onStage('matching', { done, total })
        });
    } finally {
        sift.destroy();
    }
    signal?.throwIfAborted();

    onStage('mapping');
    const reconstruction = await colmap.reconstruct(images.map(i => i.name), features, matches, { signal, onLog });

    const registered = reconstruction.images.filter(i => i.registered).length;
    if (registered < 2) {
        throw new Error(`only ${registered} of ${images.length} images registered`);
    }
    const points = reconstruction.points;
    const report: PoseReport = {
        registered,
        total: images.length,
        meanError: points.length ? points.reduce((sum, p) => sum + p.error, 0) / points.length : undefined,
        unregistered: reconstruction.images.filter(i => !i.registered).map(i => i.name)
    };

    onStage('convert');
    const files = colmap.toColmapBinary(reconstruction, features);
    return { files: Object.entries(files).map(([name, data]) => ({ path: `sparse/0/${name}`, data })), report };
};

export { browserPosesReady, estimatePosesInBrowser, type PoseRun, type StageFn };
