import { Mat4, Texture, Vec4 } from 'playcanvas';

import { IndexRanges } from './index-ranges';
import { Splat } from './splat';

/**
 * What a selection meant, kept so it can be run again.
 *
 * A selection used to be stored as the index ranges it resolved to. That is a
 * result, not an intent: a sphere selection knew which gaussians it had caught
 * but no longer knew it was a sphere, so nothing downstream could re-run it
 * when the sphere moved or when an earlier edit changed what was there to
 * catch. These descriptors are the intent, and `resolveHits` turns one back
 * into a hit set on demand.
 *
 * Screen-space queries carry the view-projection matrix they were made under.
 * Without it a lasso means nothing - it is a shape on a particular view. The
 * model matrix is deliberately NOT captured: where the object sits is part of
 * the state the graph computes, so a re-run should see it where it is now.
 *
 * `frozen` is the honest case. A brush stroke or a flood fill is freehand
 * raster work with no parameter to turn, and a ring-mode pick comes off the GPU
 * picker, which would need a re-render to reproduce. For those the hit set is
 * the intent, so it is stored directly. Indices stay valid because deletion is
 * a state flag rather than a removal - nothing renumbers underneath it.
 */

export type SelectQueryKind = 'sphere' | 'box' | 'rect' | 'poly' | 'color' | 'point' | 'frozen';

/** Maps the unit sphere (diameter 1) or unit cube (side 1) to world space. */
export type ShapeQuery = {
    kind: 'sphere' | 'box';
    transform: Mat4;
};

/** Normalized screen rectangle, with the view it was dragged on. */
export type RectQuery = {
    kind: 'rect';
    rect: { x1: number, y1: number, x2: number, y2: number };
    viewProjection: Mat4;
};

/** A closed polygon in canvas pixels - a lasso or a clicked polygon. */
export type PolyQuery = {
    kind: 'poly';
    points: { x: number, y: number }[];
    width: number;
    height: number;
    viewProjection: Mat4;
};

/** Per-channel absolute difference from a reference colour. */
export type ColorQuery = {
    kind: 'color';
    ref: { r: number, g: number, b: number };
    threshold: number;
};

/** A single click, hitting anything drawn within `size` pixels of it. */
export type PointQuery = {
    kind: 'point';
    point: { x: number, y: number };
    size: number;
    viewProjection: Mat4;
};

/**
 * A bucket range over one of the histogram's data channels.
 *
 * Only the numbers are kept. The camera and entity matrices the GPU pass needs
 * are rebuilt at resolve time from wherever things stand then, which is what
 * `onScreenOnly` has to mean for a query that outlives the gesture.
 */
export type RangeQuery = {
    kind: 'range';
    /** propMode dispatch in src/shaders/splat-value-shader.ts */
    mode: number;
    min: number;
    max: number;
    numBins: number;
    rangeStart: number;
    rangeEnd: number;
    onScreenOnly: boolean;
};

/** A hit set with no parameters behind it - see the note above. */
export type FrozenQuery = {
    kind: 'frozen';
    /** what produced it, for the label only */
    source: string;
    hits: IndexRanges;
    /**
     * How many gaussians the object had when this was captured.
     *
     * A frozen set is a list of positions in one particular array. Replayed
     * against a different frame of a sequence those positions mean nothing,
     * and applying them anyway would select arbitrary gaussians rather than
     * fail visibly. So the count is kept and checked.
     */
    numSplats?: number;
};

export type SelectQuery =
    ShapeQuery | RectQuery | PolyQuery | ColorQuery | PointQuery | RangeQuery | FrozenQuery;

/** Can this query be run again, or is it a stored result? */
export const isParametric = (query: SelectQuery) => query.kind !== 'frozen';

/** Short label for the node graph. */
export const describeQuery = (query: SelectQuery): string => {
    switch (query.kind) {
        case 'sphere': return 'sphere';
        case 'box': return 'box';
        case 'rect': return 'rectangle';
        case 'poly': return `lasso · ${query.points.length} points`;
        case 'color': return `colour · ±${query.threshold.toFixed(3)}`;
        case 'point': return 'click';
        case 'range': return `data range · ${query.rangeStart}–${query.rangeEnd}`;
        case 'frozen': return `${query.source} · frozen`;
    }
};

// Colour is stored as a dc coefficient, not as a plain channel; the reference
// and everything compared against it have to be decoded the same way.
const SH_C0 = 0.28209479177387814;
export const decodeColorChannel = (value: number) => Math.min(1, Math.max(0, 0.5 + value * SH_C0));

const mat = new Mat4();
const vec4 = new Vec4();

/** A canvas kept for rasterizing polygon queries, sized on demand. */
let polyCanvas: HTMLCanvasElement = null;
let polyTexture: Texture = null;

const rasterizePoly = (query: PolyQuery, splat: Splat): Texture => {
    if (!polyCanvas) {
        polyCanvas = document.createElement('canvas');
    }
    if (polyCanvas.width !== query.width || polyCanvas.height !== query.height) {
        polyCanvas.width = query.width;
        polyCanvas.height = query.height;
    }

    const context = polyCanvas.getContext('2d');
    context.clearRect(0, 0, polyCanvas.width, polyCanvas.height);
    context.fillStyle = '#f60';
    context.beginPath();
    query.points.forEach((p, i) => {
        if (i === 0) {
            context.moveTo(p.x, p.y);
        } else {
            context.lineTo(p.x, p.y);
        }
    });
    context.closePath();
    context.fill();

    if (!polyTexture) {
        polyTexture = new Texture(splat.scene.graphicsDevice);
    }
    polyTexture.setSource(polyCanvas);
    return polyTexture;
};

/**
 * Run a query and hand back a membership test over splat indices.
 *
 * The test must be called with strictly increasing i, which is what
 * IndexRanges.fromPredicate does.
 */
export const resolveHits = async (splat: Splat, query: SelectQuery): Promise<(i: number) => boolean> => {
    const { scene, splatData } = splat;
    const numSplats = splatData.numSplats;

    if (query.kind === 'frozen') {
        // a stored set belongs to the data it was taken from
        if (query.numSplats !== undefined && query.numSplats !== numSplats) {
            return () => false;
        }
        return query.hits.predicate();
    }

    if (query.kind === 'color') {
        const reds = splatData.getProp('f_dc_0') as Float32Array;
        const greens = splatData.getProp('f_dc_1') as Float32Array;
        const blues = splatData.getProp('f_dc_2') as Float32Array;
        if (!reds || !greens || !blues) {
            return () => false;
        }
        const { ref, threshold } = query;
        return (i: number) => {
            return Math.abs(decodeColorChannel(reds[i]) - ref.r) <= threshold &&
                Math.abs(decodeColorChannel(greens[i]) - ref.g) <= threshold &&
                Math.abs(decodeColorChannel(blues[i]) - ref.b) <= threshold;
        };
    }

    if (query.kind === 'point') {
        // a click tests the projected centre against a pixel radius, so it is
        // done on the cpu rather than through the intersection shader
        const x = splatData.getProp('x') as Float32Array;
        const y = splatData.getProp('y') as Float32Array;
        const z = splatData.getProp('z') as Float32Array;
        const { width, height } = scene.targetSize;
        const sx = query.point.x * width;
        const sy = query.point.y * height;

        mat.mul2(query.viewProjection, splat.worldTransform);

        const hits = new Uint8Array(numSplats);
        for (let i = 0; i < numSplats; i++) {
            vec4.set(x[i], y[i], z[i], 1.0);
            mat.transformVec4(vec4, vec4);
            const px = (vec4.x / vec4.w * 0.5 + 0.5) * width;
            const py = (-vec4.y / vec4.w * 0.5 + 0.5) * height;
            if (Math.abs(px - sx) < query.size && Math.abs(py - sy) < query.size) {
                hits[i] = 255;
            }
        }
        return (i: number) => hits[i] === 255;
    }

    if (query.kind === 'range') {
        scene.forceRender = true;
        const cam = scene.camera.camera;
        const options: any = {
            entityMatrix: splat.entity.getWorldTransform(),
            viewMatrix: cam.viewMatrix,
            cameraPos: scene.camera.position,
            min: query.min,
            max: query.max,
            numBins: query.numBins,
            rangeStart: query.rangeStart,
            rangeEnd: query.rangeEnd
        };
        if (query.onScreenOnly) {
            options.viewProjection = new Mat4().mul2(cam.projectionMatrix, cam.viewMatrix);
            options.onScreenOnly = true;
        }
        const data = await scene.dataProcessor.selectByRange(splat, query.mode, options);
        const hits = IndexRanges.fromPredicate(numSplats, i => data[i] === 255);
        scene.dataProcessor.releaseMask(data);
        return hits.predicate();
    }

    // the rest go through the intersection shader on the gpu
    const options: any = {};
    switch (query.kind) {
        case 'sphere':
            options.sphere = { transform: query.transform };
            break;
        case 'box':
            options.box = { transform: query.transform };
            break;
        case 'rect':
            options.rect = query.rect;
            options.viewProjection = query.viewProjection;
            break;
        case 'poly':
            options.mask = rasterizePoly(query, splat);
            options.viewProjection = query.viewProjection;
            break;
    }

    // The readback completes on a rendered frame. A selection node resolves
    // several queries in a row, and without asking for a frame each time the
    // second one waits on a render that nothing is going to schedule.
    scene.forceRender = true;

    const data = await scene.dataProcessor.intersect(options, splat);
    // the buffer is pooled, so copy what we need out of it before releasing.
    // reading it lazily through the returned closure would hand the caller a
    // buffer that has already gone back to the pool.
    const hits = IndexRanges.fromPredicate(numSplats, i => data[i] === 255);
    scene.dataProcessor.releaseMask(data);
    return hits.predicate();
};
