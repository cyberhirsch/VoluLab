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
 * all images must be the same size; matching needs WebGPU.
 */

import type { BridgeImage } from './bridge-client';

type ColmapWasm = typeof import('colmap-wasm');

/** stage keys the ui maps to text: features, matching, mapping, convert */
type StageFn = (stage: string, detail?: string) => void;

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
 * Estimate poses for the images and return the sparse model files
 * (sparse/0/cameras.bin, images.bin, points3D.bin). Throws when the
 * reconstruction registers fewer than two images.
 */
const estimatePosesInBrowser = async (images: BridgeImage[], matcher: 'sequential' | 'exhaustive', onStage: StageFn): Promise<{ path: string, data: Uint8Array }[]> => {
    onStage('features', '');
    const colmap = await loadPackage();

    const pairs = matcher === 'sequential' ?
        colmap.sequentialPairs(images.length, { window: 10 }) :
        colmap.exhaustivePairs(images.length);

    const { reconstruction, features } = await colmap.estimatePoses(images, {
        pairs,
        onProgress: ({ stage, done, total }) => onStage(stage, total > 0 ? `${done}/${total}` : '')
    });

    const registered = reconstruction.images.filter(i => i.registered).length;
    if (registered < 2) {
        throw new Error(`only ${registered} of ${images.length} images registered`);
    }

    onStage('convert');
    const files = colmap.toColmapBinary(reconstruction, features);
    return Object.entries(files).map(([name, data]) => ({ path: `sparse/0/${name}`, data }));
};

export { browserPosesReady, estimatePosesInBrowser };
