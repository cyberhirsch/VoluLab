import {
    ADDRESS_CLAMP_TO_EDGE,
    BindGroupFormat,
    BindStorageBufferFormat,
    BindStorageTextureFormat,
    BindTextureFormat,
    BindUniformBufferFormat,
    BUFFERUSAGE_COPY_DST,
    BUFFERUSAGE_COPY_SRC,
    Compute,
    FILTER_NEAREST,
    GraphicsDevice,
    PIXELFORMAT_RGBA16F,
    SAMPLETYPE_FLOAT,
    SAMPLETYPE_UINT,
    SAMPLETYPE_UNFILTERABLE_FLOAT,
    SHADERLANGUAGE_WGSL,
    SHADERSTAGE_COMPUTE,
    Shader,
    StorageBuffer,
    Texture,
    TEXTUREDIMENSION_2D,
    UniformBufferFormat,
    UniformFormat,
    UNIFORMTYPE_MAT4,
    UNIFORMTYPE_UVEC4,
    UNIFORMTYPE_VEC4,
    Vec2
} from 'playcanvas';

import { addAmbientSH } from './environment';
import { AMBIENT_BASE, DISK_OCTAGON_SCALE, EMITTER_BASE, LIGHT_KIND, MAX_EMITTERS, MAX_LIGHTS, SH_COUNT, delightSource, depositSource, lightingSource, occlusionSource, pullSource, pushSource, resolveSource, WORKGROUP } from './relight-shaders';
import { ElementType } from '../element';
import { Events } from '../events';
import { Scene } from '../scene';
import { SceneLight } from '../scene-light';
import { Splat } from '../splat';

/**
 * Relighting: lights placed in the scene, shadows cast by the scene itself.
 *
 * Three structures and three moments. The density grid holds the scene's
 * extinction, built from every drawn gaussian; each object holds two
 * per-gaussian light textures, one per side of each gaussian's flat axis,
 * which the splat shader multiplies in; and, only while an ambient light
 * is on, two occlusion textures saying how open each side is. The grid is
 * rebuilt when the gaussians change - an edit, a transform, a new frame -
 * occlusion when the grid does, and the light textures when the lights,
 * the occlusion or the grid change. Never when the camera moves: the light
 * is diffuse, so orbiting costs nothing, and moving a light leaves the
 * occlusion alone.
 *
 * De-light adds a second view of each object while it is on: the object
 * alone, as its capture saw it, with a grid of its own, how open each
 * gaussian was in it, and the divisor worked out from that and the lights
 * matched to the capture. De-light against the scene as captured, relight
 * against the scene as edited - so a deleted car's shadow comes out of the
 * road, and a second capture set beside this one shadows it without being
 * taken for part of its baked light. That view barely changes - edits
 * inside the object never touch it - so it is built once and kept, and the
 * divisor reruns only when a matched light or the de-light settings do.
 *
 * WebGPU only. The passes are compute, and the splat shader's lighting
 * branch sits behind a define that is simply never set on WebGL2.
 *
 * Nothing here listens to history. The lights are whatever light elements
 * the scene holds, and the gaussians are compared frame to frame against
 * what the grid was built from - so undo, bypass, a sequence frame and a
 * gizmo drag all reach the lighting the same way, by changing what is
 * there.
 */

type RelightSettings = {
    /** how much of the capture's own lighting is kept, less what de-light divides out */
    capturedLight: number;
    /** finest grid cells along the scene's longest side */
    resolution: number;
    /** how far occlusion looks, as a share of the scene's longest side */
    occlusionRange: number;
    /** 0 ambient light ignores occlusion, 1 it is fully shut out */
    occlusionStrength: number;
    /** 0 the capture's own light stays in, 1 it is divided out in full */
    delight: number;
    /** the least de-light divides by, so no baked shadow is lifted more than 1 / this */
    delightFloor: number;
    /** whether the capture de-light divides out still has the deleted gaussians in it */
    delightSeesDeleted: boolean;
};

const defaultRelightSettings = (): RelightSettings => ({
    capturedLight: 0.4,
    resolution: 128,
    occlusionRange: 0.1,
    occlusionStrength: 1,
    delight: 0.5,
    delightFloor: 0.2,
    delightSeesDeleted: true
});

// A grid's pyramid: eight levels up to 256 cells, and one more for each
// doubling past it - the kernels' gridScale - so the coarsest level is as
// coarse at 1024 as at 256, and nothing at 256 or below changes.
const BASE_LEVELS = 8;
const MAX_LEVELS = 10;

// the finest grid there is to ask for, and the coarsest a grid is cut down
// to when the GPU cannot hold what was asked
const MAX_RESOLUTION = 1024;
const MIN_RESOLUTION = 32;

/** A relight node's settings, each held to what the passes can take. */
const normalizeRelightSettings = (s: Partial<RelightSettings>): RelightSettings => {
    const d = defaultRelightSettings();
    const num = (v: unknown, fallback: number) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : fallback);
    return {
        capturedLight: Math.min(4, Math.max(0, num(s.capturedLight, d.capturedLight))),
        resolution: Math.round(Math.min(MAX_RESOLUTION, Math.max(MIN_RESOLUTION, num(s.resolution, d.resolution)))),
        occlusionRange: Math.min(1, Math.max(0.01, num(s.occlusionRange, d.occlusionRange))),
        occlusionStrength: Math.min(1, Math.max(0, num(s.occlusionStrength, d.occlusionStrength))),
        delight: Math.min(1, Math.max(0, num(s.delight, d.delight))),
        delightFloor: Math.min(1, Math.max(0.02, num(s.delightFloor, d.delightFloor))),
        delightSeesDeleted: s.delightSeesDeleted !== false
    };
};

// what WebGPU guarantees every device, for a device that does not say
const DEFAULT_BINDING_BYTES = 128 * 1024 * 1024;
const DEFAULT_BUFFER_BYTES = 256 * 1024 * 1024;

const LIGHT_FLOATS = 16;

// what the lighting pass depends on besides the lights and each object's
// relight settings, compared ahead of the lights
const SEEN_HEAD = 2;

// the same for the de-light pass, ahead of the matched lights
const DELIGHT_HEAD = 1;

// state bits: hidden - which this app records as locked, and draws as all
// but invisible - and deleted
const STATE_LOCKED = 2;
const STATE_DELETED = 4;

// the light records, the ambient coefficients after them, then the volume
// lights' emitters
const LIGHT_BUFFER_FLOATS = (EMITTER_BASE + MAX_EMITTERS * 2) * 4;
const EMITTER_FLOATS = 8;

// occlusion cones are 60 degrees wide
const OCCLUSION_TAN_HALF = Math.tan(30 * Math.PI / 180);

// wrapped Lambert: how far past 90 degrees light still reaches, which is
// what keeps a fuzzy gaussian's terminator from being a hard line
const WRAP = 0.3;

// shadow rays leave this many finest cells off the lit side, so a surface
// does not shadow itself. A surface deposits into the two cells either side
// of it and a trilinear sample reaches one cell further, so its own density
// can be read up to two cells away - any less and every surface dims itself
// by an amount that depends on where it happens to sit inside its cell
const RAY_OFFSET_CELLS = 2.0;

// How far de-light shrinks a matched light's shadow, in the captured grid's
// finest cells. A hard shadow through the grid comes out about a cell and
// a half wider all round than the one that cast it, at 128 cells and at
// 256; this takes that back out and a cell more, because the division is
// lopsided. Where an edge cannot be placed exactly, calling a half-lit point
// shadowed lifts it nearly twice too bright, and calling a half-shadowed one
// lit leaves it a little dark - so edges err toward lit, and end as a faint
// dark outline rather than a white one.
const DELIGHT_ERODE_CELLS = 2.5;

// a sun at softness 1 is this wide, half-angle; at 0 it is the real sun
const SUN_MAX_HALF_ANGLE = 15 * Math.PI / 180;
const SUN_MIN_HALF_ANGLE = 0.27 * Math.PI / 180;

// the grid is not rebuilt more often than this while something is being
// dragged; lighting alone may update every frame
const GRID_MIN_INTERVAL_MS = 100;

// the fraction of gaussians on each side left out of the grid's bounds, so
// a few floaters far away do not stretch the cells over empty space
const BOUND_TAIL = 0.005;

const tmpDispatch = new Vec2();

/** The seven kernels, compiled once per device. */
class Kernels {
    deposit: Shader;
    resolve: Shader;
    pull: Shader;
    push: Shader;
    occlusion: Shader;
    lighting: Shader;
    delight: Shader;
    noOcclusion: Texture;
    // bound for the grid by an object that never reads it - one with no
    // relight node, while there may be no grid at all
    emptyGrid: StorageBuffer;

    constructor(device: GraphicsDevice) {
        const storage = (name: string, readOnly: boolean) => new BindStorageBufferFormat(name, SHADERSTAGE_COMPUTE, readOnly);
        const texture = (name: string, sampleType: number) => new BindTextureFormat(name, SHADERSTAGE_COMPUTE, TEXTUREDIMENSION_2D, sampleType, false);
        const storageTexture = (name: string) => new BindStorageTextureFormat(name, PIXELFORMAT_RGBA16F, TEXTUREDIMENSION_2D, true, false);

        // explicit formats, in the order the WGSL numbers its bindings; the
        // uniform block is always last
        const make = (name: string, source: string, formats: any[], uniforms: UniformFormat[]) => {
            return new Shader(device, {
                name,
                shaderLanguage: SHADERLANGUAGE_WGSL,
                cshader: source,
                computeBindGroupFormat: new BindGroupFormat(device, [
                    ...formats,
                    new BindUniformBufferFormat('uniforms', SHADERSTAGE_COMPUTE)
                ]),
                computeUniformBufferFormats: {
                    uniforms: new UniformBufferFormat(device, uniforms)
                }
            });
        };

        // only mat4 and four-component types, so the block's layout is the
        // same in the engine's packing and in WGSL without any padding rules
        const gaussianUniforms = () => [
            new UniformFormat('matrixModel', UNIFORMTYPE_MAT4),
            new UniformFormat('gridOrigin', UNIFORMTYPE_VEC4),
            new UniformFormat('gridDims', UNIFORMTYPE_UVEC4),
            new UniformFormat('counts', UNIFORMTYPE_UVEC4)
        ];
        const countsOnly = () => [new UniformFormat('counts', UNIFORMTYPE_UVEC4)];

        // the transform palette is RGBA32F, which is only filterable where the
        // adapter says so - read as unfilterable, it binds everywhere
        this.deposit = make('relightDeposit', depositSource, [
            storage('gaussians', true),
            storage('accum', false),
            storage('levels', true),
            texture('splatState', SAMPLETYPE_FLOAT),
            texture('splatTransform', SAMPLETYPE_UINT),
            texture('transformPalette', SAMPLETYPE_UNFILTERABLE_FLOAT)
        ], gaussianUniforms());

        this.resolve = make('relightResolve', resolveSource, [
            storage('accum', true),
            storage('density', false)
        ], countsOnly());

        this.pull = make('relightPull', pullSource, [
            storage('density', false),
            storage('levels', true)
        ], countsOnly());

        this.push = make('relightPush', pushSource, [
            storage('accum', true),
            storage('density', false),
            storage('levels', true)
        ], countsOnly());

        this.occlusion = make('relightOcclusion', occlusionSource, [
            storage('gaussians', true),
            storage('density', true),
            storage('levels', true),
            texture('splatState', SAMPLETYPE_FLOAT),
            texture('splatTransform', SAMPLETYPE_UINT),
            texture('transformPalette', SAMPLETYPE_UNFILTERABLE_FLOAT),
            storageTexture('occlusionPlus'),
            storageTexture('occlusionMinus')
        ], [...gaussianUniforms(), new UniformFormat('params', UNIFORMTYPE_VEC4)]);

        this.lighting = make('relightLighting', lightingSource, [
            storage('gaussians', true),
            storage('density', true),
            storage('levels', true),
            storage('lights', true),
            texture('splatState', SAMPLETYPE_FLOAT),
            texture('splatTransform', SAMPLETYPE_UINT),
            texture('transformPalette', SAMPLETYPE_UNFILTERABLE_FLOAT),
            storageTexture('lightPlus'),
            storageTexture('lightMinus'),
            texture('occlusionPlus', SAMPLETYPE_FLOAT),
            texture('occlusionMinus', SAMPLETYPE_FLOAT),
            texture('delightPlus', SAMPLETYPE_FLOAT),
            texture('delightMinus', SAMPLETYPE_FLOAT)
        ], [
            ...gaussianUniforms(),
            new UniformFormat('params', UNIFORMTYPE_VEC4),
            new UniformFormat('ambient', UNIFORMTYPE_VEC4)
        ]);

        this.delight = make('relightDelight', delightSource, [
            storage('gaussians', true),
            storage('density', true),
            storage('levels', true),
            storage('lights', true),
            texture('splatState', SAMPLETYPE_FLOAT),
            texture('splatTransform', SAMPLETYPE_UINT),
            texture('transformPalette', SAMPLETYPE_UNFILTERABLE_FLOAT),
            texture('capturedPlus', SAMPLETYPE_FLOAT),
            texture('capturedMinus', SAMPLETYPE_FLOAT),
            storageTexture('delightPlus'),
            storageTexture('delightMinus')
        ], [
            ...gaussianUniforms(),
            new UniformFormat('params', UNIFORMTYPE_VEC4),
            new UniformFormat('scale', UNIFORMTYPE_VEC4)
        ]);

        // bound in place of the occlusion textures while there is no ambient
        // light to need them, and of the de-light ones while de-light is off
        // - the kernel never reads it
        this.noOcclusion = new Texture(device, {
            name: 'relightNoOcclusion',
            width: 1,
            height: 1,
            format: PIXELFORMAT_RGBA16F,
            mipmaps: false,
            minFilter: FILTER_NEAREST,
            magFilter: FILTER_NEAREST
        });
        this.emptyGrid = new StorageBuffer(device, 16, BUFFERUSAGE_COPY_DST);
    }

    destroy() {
        this.deposit.destroy();
        this.resolve.destroy();
        this.pull.destroy();
        this.push.destroy();
        this.occlusion.destroy();
        this.lighting.destroy();
        this.delight.destroy();
        this.noOcclusion.destroy();
    }
}

const dispatchFor = (device: GraphicsDevice, compute: Compute, count: number) => {
    const groups = Math.max(1, Math.ceil(count / WORKGROUP));
    const max = (device as any).limits?.maxComputeWorkgroupsPerDimension || 65535;
    Compute.calcDispatchSize(groups, tmpDispatch, max);
    compute.setupDispatch(tmpDispatch.x, tmpDispatch.y, 1);
};

type Box = { min: number[], max: number[] };

type GridPlan = { cell: number, dims: number[], levels: number[][], totalCells: number };

/** Cubic cells over an extent, one cell of margin all round, and the levels above them. */
const planGrid = (extent: number[], resolution: number): GridPlan => {
    const longest = Math.max(extent[0], extent[1], extent[2], 1e-6);
    const cell = longest / Math.max(8, resolution);
    const dims = extent.map(e => Math.max(1, Math.ceil(e / cell)) + 2);

    // levels halve until the coarsest is a couple of cells across
    const scale = Math.max(1, Math.floor((Math.max(dims[0], dims[1], dims[2]) + 128) / 256));
    const levelCap = Math.min(MAX_LEVELS, BASE_LEVELS + Math.floor(Math.log2(scale)));
    const levels: number[][] = [];
    let d = dims.slice();
    let offset = 0;
    for (let l = 0; l < levelCap; ++l) {
        levels.push([d[0], d[1], d[2], offset]);
        offset += d[0] * d[1] * d[2];
        if (Math.max(d[0], d[1], d[2]) <= 2) break;
        d = d.map(v => Math.max(1, Math.ceil(v / 2)));
    }
    return { cell, dims, levels, totalCells: offset };
};

/**
 * The finest resolution up to the one asked for whose grid holds no more
 * than maxCells. For a given box the cells go with the cube of the
 * resolution, so a guess from that lands close and a step or two finishes.
 */
const fitResolution = (extent: number[], resolution: number, maxCells: number) => {
    let used = resolution;
    let plan = planGrid(extent, used);
    while (plan.totalCells > maxCells && used > MIN_RESOLUTION) {
        const guess = Math.floor(used * Math.cbrt(maxCells / plan.totalCells));
        used = Math.max(MIN_RESOLUTION, Math.min(used - 1, guess));
        plan = planGrid(extent, used);
    }
    return { used, plan };
};

/**
 * The density grid: a pyramid of levels in two flat buffers, the fixed-point
 * accumulator the deposits land in and the float densities everything reads.
 * Levels are laid end to end; `levels` holds each one's dims and offset.
 *
 * As fine as asked unless the GPU cannot hold it. Each buffer has to fit the
 * device's limit on one buffer - 128 MiB is all WebGPU guarantees, which a
 * grid of any shape fits at 256 cells but a cube-shaped one at 1024 needs
 * over thirty times - and both have to fit in the memory that is left. The
 * limit is known up front; running out of memory is only found out after
 * the fact. Either way the grid is laid out coarser, and `resolution` says
 * what it came to.
 */
class DensityGrid {
    device: GraphicsDevice;
    origin = [0, 0, 0];
    cell = 1;
    dims = [1, 1, 1];
    levels: number[][] = [];
    totalCells = 0;
    capacity = 0;

    /** what the layout asked for, and what it got */
    requested = 0;
    resolution = 0;

    /** the most cells an allocation has been found to survive, once one has not */
    private memoryCap = Infinity;

    /** set when an allocation ran out of memory; the relighter rebuilds the grid and clears it */
    outOfMemory = false;

    accum: StorageBuffer = null;
    density: StorageBuffer = null;
    levelBuffer: StorageBuffer;

    resolve: Compute;
    pulls: Compute[] = [];
    push: Compute;

    constructor(device: GraphicsDevice, private kernels: Kernels) {
        this.device = device;
        this.levelBuffer = new StorageBuffer(device, MAX_LEVELS * 16, BUFFERUSAGE_COPY_DST);
        this.resolve = new Compute(device, kernels.resolve, 'RelightResolve');
        this.push = new Compute(device, kernels.push, 'RelightPush');
    }

    /** the most cells one of the grid's buffers may hold here */
    get cellLimit() {
        const limits = (this.device as any).wgpu?.limits;
        const bytes = Math.min(limits?.maxStorageBufferBindingSize ?? DEFAULT_BINDING_BYTES, limits?.maxBufferSize ?? DEFAULT_BUFFER_BYTES);
        return Math.min(Math.floor(bytes / 4), this.memoryCap);
    }

    /** Lay the grid over a box: cubic cells, one cell of margin all round. */
    layout(box: Box, resolution: number) {
        const extent = [0, 1, 2].map(a => Math.max(0, box.max[a] - box.min[a]));
        const limit = this.cellLimit;
        const { used, plan } = fitResolution(extent, resolution, limit);

        this.requested = resolution;
        this.resolution = used;
        this.cell = plan.cell;
        this.dims = plan.dims;
        this.origin = box.min.map(v => v - plan.cell);
        this.levels = plan.levels;
        this.totalCells = plan.totalCells;

        // buffers grow but never shrink, so a drag that nudges the bounds
        // every frame does not reallocate every frame - with room to spare,
        // though never past what the device takes
        if (this.totalCells > this.capacity) {
            this.allocate(Math.max(this.totalCells, Math.min(Math.ceil(this.totalCells * 1.25), limit)));
        }

        const levelData = new Uint32Array(MAX_LEVELS * 4);
        this.levels.forEach((level, i) => levelData.set(level, i * 4));
        this.levelBuffer.write(0, levelData, 0, levelData.length);

        // one pull per level above the finest, each its own compute so each
        // keeps its own uniform block through the frame
        while (this.pulls.length < this.levels.length - 1) {
            this.pulls.push(new Compute(this.device, this.kernels.pull, 'RelightPull'));
        }
    }

    /**
     * Both buffers, for this many cells. WebGPU reports running out of
     * memory only asynchronously, so a grid that did is used broken for a
     * frame or two, then marked; the relighter rebuilds it, and the next
     * layout keeps to half the cells that failed.
     */
    private allocate(cells: number) {
        const wgpu = (this.device as any).wgpu;
        const { resolution } = this;
        this.accum?.destroy();
        this.density?.destroy();
        this.capacity = cells;

        wgpu?.pushErrorScope('out-of-memory');
        this.accum = new StorageBuffer(this.device, cells * 4, BUFFERUSAGE_COPY_DST);
        this.density = new StorageBuffer(this.device, cells * 4, BUFFERUSAGE_COPY_SRC | BUFFERUSAGE_COPY_DST);
        wgpu?.popErrorScope().then((error: unknown) => {
            if (!error) return;
            console.warn(`Relighting: out of GPU memory for a grid at ${resolution} (${cells} cells); making it coarser`);
            this.memoryCap = Math.min(this.memoryCap, Math.floor(cells / 2));
            this.capacity = 0;
            this.outOfMemory = true;
        });
    }

    /** Give the buffers back while no relight node needs the grid; a layout makes them again. */
    release() {
        this.accum?.destroy();
        this.density?.destroy();
        this.accum = null;
        this.density = null;
        this.capacity = 0;
        this.resolution = 0;
    }

    get levelCount() {
        return this.levels.length;
    }

    /** the grid's longest side, in world units */
    get longest() {
        return Math.max(this.dims[0], this.dims[1], this.dims[2]) * this.cell;
    }

    /** the uniforms every gaussian kernel shares */
    get gridOrigin() {
        return [this.origin[0], this.origin[1], this.origin[2], this.cell];
    }

    get gridDims() {
        return [this.dims[0], this.dims[1], this.dims[2], this.levelCount];
    }

    clear() {
        this.accum.clear(0, this.totalCells * 4);
    }

    /** After the deposits: resolve, pull up level by level, push down. */
    finish() {
        const { device } = this;

        this.resolve.setParameter('accum', this.accum);
        this.resolve.setParameter('density', this.density);
        this.resolve.setParameter('counts', [this.totalCells, 0, 0, 0]);
        dispatchFor(device, this.resolve, this.totalCells);
        device.computeDispatch([this.resolve], 'RelightResolve');

        for (let l = 1; l < this.levelCount; ++l) {
            const pull = this.pulls[l - 1];
            const [x, y, z] = this.levels[l];
            pull.setParameter('density', this.density);
            pull.setParameter('levels', this.levelBuffer);
            pull.setParameter('counts', [l, 0, 0, 0]);
            dispatchFor(device, pull, x * y * z);
            device.computeDispatch([pull], 'RelightPull');
        }

        if (this.levelCount > 1) {
            const pushCells = this.levels[this.levelCount - 1][3];
            this.push.setParameter('accum', this.accum);
            this.push.setParameter('density', this.density);
            this.push.setParameter('levels', this.levelBuffer);
            this.push.setParameter('counts', [pushCells, this.levelCount, 0, 0]);
            dispatchFor(device, this.push, pushCells);
            device.computeDispatch([this.push], 'RelightPush');
        }
    }

    destroy() {
        this.accum?.destroy();
        this.density?.destroy();
        this.levelBuffer.destroy();
        this.resolve.destroy();
        this.push.destroy();
        this.pulls.forEach(p => p.destroy());
    }
}

/**
 * Three vec4s per gaussian, in its own space:
 *   centre and optical depth; rotation (x, y, z, w); linear scale.
 *
 * Optical depth rather than opacity because depths add along a ray and
 * opacities do not. It is capped so an opaque gaussian stays finite.
 */
const packGaussians = (data: any, count: number) => {
    const out = new Float32Array(Math.max(1, count) * 12);
    const prop = (name: string) => data.getProp(name) as Float32Array;
    const x = prop('x');
    const y = prop('y');
    const z = prop('z');
    const opacity = prop('opacity');
    const r0 = prop('rot_0');
    const r1 = prop('rot_1');
    const r2 = prop('rot_2');
    const r3 = prop('rot_3');
    const s0 = prop('scale_0');
    const s1 = prop('scale_1');
    const s2 = prop('scale_2');

    for (let i = 0; i < count; ++i) {
        const o = i * 12;
        out[o] = x[i];
        out[o + 1] = y[i];
        out[o + 2] = z[i];

        const alpha = 1 / (1 + Math.exp(-opacity[i]));
        out[o + 3] = alpha < 1 / 255 ? 0 : -Math.log(1 - Math.min(alpha, 0.995));

        // the file stores w first; the kernels want it last
        let qw = r0 ? r0[i] : 1;
        let qx = r1 ? r1[i] : 0;
        let qy = r2 ? r2[i] : 0;
        let qz = r3 ? r3[i] : 0;
        const len = Math.hypot(qw, qx, qy, qz);
        if (len > 1e-12) {
            qw /= len;
            qx /= len;
            qy /= len;
            qz /= len;
        } else {
            qw = 1;
            qx = qy = qz = 0;
        }
        out[o + 4] = qx;
        out[o + 5] = qy;
        out[o + 6] = qz;
        out[o + 7] = qw;

        // stored as logs
        out[o + 8] = Math.exp(s0 ? s0[i] : 0);
        out[o + 9] = Math.exp(s1 ? s1[i] : 0);
        out[o + 10] = Math.exp(s2 ? s2[i] : 0);
    }
    return out;
};

/** A per-gaussian RGBA16F texture the kernels write and the shaders read. */
const perGaussianTexture = (device: GraphicsDevice, name: string, width: number, height: number) => new Texture(device, {
    name,
    width,
    height,
    format: PIXELFORMAT_RGBA16F,
    mipmaps: false,
    storage: true,
    minFilter: FILTER_NEAREST,
    magFilter: FILTER_NEAREST,
    addressU: ADDRESS_CLAMP_TO_EDGE,
    addressV: ADDRESS_CLAMP_TO_EDGE
});

const sameMatrix = (a: ArrayLike<number>, b: ArrayLike<number>) => {
    for (let i = 0; i < 16; ++i) {
        if (a[i] !== b[i]) return false;
    }
    return true;
};

/**
 * Per object: its gaussians packed for the kernels, its two light textures,
 * and what the grid was last built from, to tell when it has changed.
 */
class SplatLighting {
    splat: Splat;
    data: any;
    count: number;
    width: number;
    height: number;

    gaussians: StorageBuffer;
    lightPlus: Texture;
    lightMinus: Texture;
    deposit: Compute;
    lighting: Compute;

    // this object's relight node's settings, or null: without one, lights
    // only add to its captured light, unshadowed
    settings: RelightSettings | null = null;
    // the same as last seen, to tell what changed
    seenSettings: number[] = [];

    // how open each side of each gaussian is - only while an ambient light
    // is on, since nothing else reads them
    occlusionPlus: Texture = null;
    occlusionMinus: Texture = null;
    occlusion: Compute = null;

    // what the grid last saw of this object
    seenDeleted = -1;
    seenLocked = -1;
    seenPositions = -1;
    seenMatrix = new Float32Array(16);

    // De-light's view of this object: the object alone, as its capture saw
    // it, in a grid of its own; how open each side of each gaussian was
    // there; and what the de-light pass made of that and the matched lights,
    // for lighting to divide by. Only while de-light is on.
    captured: DensityGrid = null;
    capturedPlus: Texture = null;
    capturedMinus: Texture = null;
    delightPlus: Texture = null;
    delightMinus: Texture = null;
    capturedDeposit: Compute = null;
    capturedOcclusion: Compute = null;
    delighting: Compute = null;
    capturedDirty = true;
    capturedSkyDirty = true;
    delightDirty = true;

    // what the captured grid and its occlusion were last built from; the
    // deleted count is -1 while deleted gaussians are counted in
    capturedMatrix = new Float32Array(16);
    capturedDeleted = -1;
    capturedResolution = 0;
    capturedRange = 0;

    constructor(device: GraphicsDevice, kernels: Kernels, splat: Splat) {
        this.splat = splat;
        this.data = splat.splatData;
        this.count = splat.splatData.numSplats;
        this.width = splat.stateTexture.width;
        this.height = splat.stateTexture.height;

        this.gaussians = new StorageBuffer(device, Math.max(1, this.count) * 48, BUFFERUSAGE_COPY_DST);
        const packed = packGaussians(splat.splatData, this.count);
        this.gaussians.write(0, packed, 0, packed.length);

        const lightTexture = (name: string) => perGaussianTexture(device, name, this.width, this.height);
        this.lightPlus = lightTexture('splatLightPlus');
        this.lightMinus = lightTexture('splatLightMinus');

        this.deposit = new Compute(device, kernels.deposit, 'RelightDeposit');
        this.lighting = new Compute(device, kernels.lighting, 'RelightLighting');
    }

    /** true when the textures had to be made, and so hold nothing yet */
    ensureOcclusion(device: GraphicsDevice, kernels: Kernels) {
        if (this.occlusion) return false;
        this.occlusionPlus = perGaussianTexture(device, 'splatOcclusionPlus', this.width, this.height);
        this.occlusionMinus = perGaussianTexture(device, 'splatOcclusionMinus', this.width, this.height);
        this.occlusion = new Compute(device, kernels.occlusion, 'RelightOcclusion');
        return true;
    }

    releaseOcclusion() {
        this.occlusionPlus?.destroy();
        this.occlusionMinus?.destroy();
        this.occlusion?.destroy();
        this.occlusionPlus = null;
        this.occlusionMinus = null;
        this.occlusion = null;
    }

    ensureDelight(device: GraphicsDevice, kernels: Kernels) {
        if (this.captured) return;
        this.captured = new DensityGrid(device, kernels);
        this.capturedPlus = perGaussianTexture(device, 'splatCapturedPlus', this.width, this.height);
        this.capturedMinus = perGaussianTexture(device, 'splatCapturedMinus', this.width, this.height);
        this.delightPlus = perGaussianTexture(device, 'splatDelightPlus', this.width, this.height);
        this.delightMinus = perGaussianTexture(device, 'splatDelightMinus', this.width, this.height);
        this.capturedDeposit = new Compute(device, kernels.deposit, 'RelightCapturedDeposit');
        this.capturedOcclusion = new Compute(device, kernels.occlusion, 'RelightCapturedOcclusion');
        this.delighting = new Compute(device, kernels.delight, 'RelightDelight');
        this.capturedDirty = true;
        this.capturedSkyDirty = true;
        this.delightDirty = true;
    }

    releaseDelight() {
        this.captured?.destroy();
        this.capturedPlus?.destroy();
        this.capturedMinus?.destroy();
        this.delightPlus?.destroy();
        this.delightMinus?.destroy();
        this.capturedDeposit?.destroy();
        this.capturedOcclusion?.destroy();
        this.delighting?.destroy();
        this.captured = null;
        this.capturedPlus = null;
        this.capturedMinus = null;
        this.delightPlus = null;
        this.delightMinus = null;
        this.capturedDeposit = null;
        this.capturedOcclusion = null;
        this.delighting = null;
    }

    destroy() {
        this.gaussians.destroy();
        this.lightPlus.destroy();
        this.lightMinus.destroy();
        this.deposit.destroy();
        this.lighting.destroy();
        this.releaseOcclusion();
        this.releaseDelight();
    }
}

/**
 * The box the grid covers: every drawn gaussian's centre, trimmed of the
 * farthest half percent on each side of each axis and then padded a little.
 * A capture's bounds are set by its worst floater, and a grid stretched over
 * that spends its cells on nothing. Gaussians outside the box cast no shadow
 * and are lit as if unoccluded.
 *
 * `skip` is the state bits that leave a gaussian out. `captured` takes each
 * one where the capture put it, not where the transform palette has since
 * moved it - the box of a captured grid.
 */
const robustBox = (entries: SplatLighting[], skip: number, captured: boolean): Box | null => {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    let total = 0;

    const visit = (fn: (wx: number, wy: number, wz: number) => void) => {
        for (const entry of entries) {
            const { splat } = entry;
            const centers = captured ? null : (splat.entity.gsplat?.instance as any)?.sorter?.centers as Float32Array;
            const state = splat.splatData.getProp('state') as Uint8Array;
            const m = splat.entity.getWorldTransform().data;
            const x = splat.splatData.getProp('x') as Float32Array;
            const y = splat.splatData.getProp('y') as Float32Array;
            const z = splat.splatData.getProp('z') as Float32Array;
            for (let i = 0; i < entry.count; ++i) {
                if (state && (state[i] & skip)) continue;
                // the sorter's centres follow the transform palette; the
                // raw positions are where the capture put each gaussian
                const px = centers ? centers[i * 3] : x[i];
                const py = centers ? centers[i * 3 + 1] : y[i];
                const pz = centers ? centers[i * 3 + 2] : z[i];
                fn(
                    m[0] * px + m[4] * py + m[8] * pz + m[12],
                    m[1] * px + m[5] * py + m[9] * pz + m[13],
                    m[2] * px + m[6] * py + m[10] * pz + m[14]
                );
            }
        }
    };

    visit((wx, wy, wz) => {
        if (wx < lo[0]) lo[0] = wx;
        if (wy < lo[1]) lo[1] = wy;
        if (wz < lo[2]) lo[2] = wz;
        if (wx > hi[0]) hi[0] = wx;
        if (wy > hi[1]) hi[1] = wy;
        if (wz > hi[2]) hi[2] = wz;
        total++;
    });

    if (total === 0) return null;

    // quantiles from a histogram per axis - exact enough, and linear time
    const BINS = 1024;
    const hist = [new Uint32Array(BINS), new Uint32Array(BINS), new Uint32Array(BINS)];
    const span = [0, 1, 2].map(a => Math.max(hi[a] - lo[a], 1e-9));
    const bin = (v: number, a: number) => Math.min(BINS - 1, Math.floor((v - lo[a]) / span[a] * BINS));
    visit((wx, wy, wz) => {
        hist[0][bin(wx, 0)]++;
        hist[1][bin(wy, 1)]++;
        hist[2][bin(wz, 2)]++;
    });

    const tail = Math.floor(total * BOUND_TAIL);
    const min = [0, 0, 0];
    const max = [0, 0, 0];
    for (let a = 0; a < 3; ++a) {
        let acc = 0;
        let first = 0;
        while (first < BINS - 1 && acc + hist[a][first] <= tail) acc += hist[a][first++];
        acc = 0;
        let last = BINS - 1;
        while (last > 0 && acc + hist[a][last] <= tail) acc += hist[a][last--];
        min[a] = lo[a] + first / BINS * span[a];
        max[a] = lo[a] + (last + 1) / BINS * span[a];
    }

    // pad by a twentieth of the largest extent, but never past the real bounds
    const pad = 0.05 * Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1e-6);
    for (let a = 0; a < 3; ++a) {
        min[a] = Math.max(lo[a], min[a] - pad);
        max[a] = Math.min(hi[a], max[a] + pad);
    }
    return { min, max };
};

/**
 * A flat polygon's form factor seen squarely from its axis, at a distance -
 * Lambert's formula over its edges, as the lighting kernel works it, so an
 * area light's aim point gets exactly its intensity. Corners are in the
 * polygon's own plane, round its centre.
 */
const formFactorOnAxis = (points: number[][], distance: number) => {
    const corners = points.map(([x, y]) => {
        const l = Math.hypot(x, y, distance);
        return [x / l, y / l, distance / l];
    });
    let sum = 0;
    for (let i = 0; i < corners.length; ++i) {
        const a = corners[i];
        const b = corners[(i + 1) % corners.length];
        const cx = a[1] * b[2] - a[2] * b[1];
        const cy = a[2] * b[0] - a[0] * b[2];
        const cz = a[0] * b[1] - a[1] * b[0];
        const cl = Math.hypot(cx, cy, cz);
        if (cl < 1e-12) continue;
        sum += cz / cl * Math.atan2(cl, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
    }
    return Math.abs(sum) / (2 * Math.PI);
};

/** where the next volume light's emitters go in the buffer */
type EmitterCursor = { next: number };

/**
 * One light record per point, spot, sun, area or volume light - see the
 * lighting kernel for the layout - from record `first` on. A volume
 * light's emitters go after the ambient coefficients, from the cursor on.
 * Returns how many records were written.
 */
const packLights = (lights: SceneLight[], out: Float32Array, first: number, cursor: EmitterCursor) => {
    let n = 0;
    for (const light of lights) {
        if (first + n >= MAX_LIGHTS) break;
        const s = light.settings;
        // a volume light with no emitters, or none left room, lights nothing
        const emitters = s.kind === 'volume' ? (s.emitters ?? []).slice(0, MAX_EMITTERS - cursor.next) : [];
        if (s.kind === 'volume' && emitters.length === 0) continue;

        const o = (first + n) * LIGHT_FLOATS;
        const { forward, up, distance: dist } = light.frame();
        const intensity = Math.max(0, s.intensity);
        const softness = Math.min(1, Math.max(0, s.softness));
        const color = s.color;

        out[o + 4] = color[0] * intensity;
        out[o + 5] = color[1] * intensity;
        out[o + 6] = color[2] * intensity;

        if (s.kind === 'sun') {
            // toward the sun: against the direction it shines
            out[o] = -forward.x;
            out[o + 1] = -forward.y;
            out[o + 2] = -forward.z;
            out[o + 3] = LIGHT_KIND.sun;
            out[o + 7] = Math.tan(SUN_MIN_HALF_ANGLE + softness * (SUN_MAX_HALF_ANGLE - SUN_MIN_HALF_ANGLE));
        } else if (s.kind === 'rect' || s.kind === 'disk' || s.kind === 'sphere') {
            // centred on the light, facing its aim point, sized by it
            const width = Math.max(0.01, Number(s.size) || 0.5) * dist;
            const height = Math.max(0.01, Number(s.height) || 0.5) * dist;
            out[o] = light.position.x;
            out[o + 1] = light.position.y;
            out[o + 2] = light.position.z;
            out[o + 3] = LIGHT_KIND[s.kind];
            out[o + 8] = forward.x;
            out[o + 9] = forward.y;
            out[o + 10] = forward.z;
            out[o + 11] = width * 0.5;
            out[o + 12] = up.x;
            out[o + 13] = up.y;
            out[o + 14] = up.z;
            out[o + 15] = height * 0.5;

            // what a surface at the aim point, facing the light, sees of it -
            // a disk being the kernel's octagon of the same area
            const r = width * 0.5;
            let aim: number;
            if (s.kind === 'sphere') {
                out[o + 7] = r;
                aim = Math.min(1, r * r / (dist * dist));
            } else if (s.kind === 'disk') {
                const corner = r * DISK_OCTAGON_SCALE;
                aim = formFactorOnAxis([0, 1, 2, 3, 4, 5, 6, 7].map(k => [corner * Math.cos(k * Math.PI / 4), corner * Math.sin(k * Math.PI / 4)]), dist);
            } else {
                const hw = width * 0.5;
                const hh = height * 0.5;
                aim = formFactorOnAxis([[hw, hh], [-hw, hh], [-hw, -hh], [hw, -hh]], dist);
            }
            const scale = 1 / Math.max(aim, 1e-9);
            out[o + 4] *= scale;
            out[o + 5] *= scale;
            out[o + 6] *= scale;
        } else if (s.kind === 'volume') {
            out[o] = light.position.x;
            out[o + 1] = light.position.y;
            out[o + 2] = light.position.z;
            out[o + 3] = LIGHT_KIND.volume;
            out[o + 8] = cursor.next;
            out[o + 9] = emitters.length;
            // intensity is measured at the aim point
            out[o + 13] = dist * dist;

            // how widely they spread sets the shadow's softness; how far the
            // farthest reaches is where its shadow ray stops
            let spread = 0;
            let total = 0;
            let reach = 0;
            for (const e of emitters) {
                const e0 = (EMITTER_BASE + cursor.next * 2) * 4;
                const ox = e.offset[0];
                const oy = e.offset[1];
                const oz = e.offset[2];
                out[e0] = light.position.x + ox;
                out[e0 + 1] = light.position.y + oy;
                out[e0 + 2] = light.position.z + oz;
                out[e0 + 3] = e.radius;
                out[e0 + 4] = e.color[0] * e.weight;
                out[e0 + 5] = e.color[1] * e.weight;
                out[e0 + 6] = e.color[2] * e.weight;
                const d2 = ox * ox + oy * oy + oz * oz;
                spread += e.weight * (d2 + e.radius * e.radius);
                total += e.weight;
                // a cluster's radius is its members' root-mean-square
                // distance; twice that takes in nearly all of them
                reach = Math.max(reach, Math.sqrt(d2) + 2 * e.radius);
                cursor.next++;
            }
            out[o + 7] = Math.sqrt(spread / Math.max(total, 1e-9));
            out[o + 12] = reach;
        } else {
            out[o] = light.position.x;
            out[o + 1] = light.position.y;
            out[o + 2] = light.position.z;
            out[o + 3] = s.kind === 'spot' ? LIGHT_KIND.spot : LIGHT_KIND.point;
            // the emitter's radius, as a share of its distance to the aim point
            out[o + 7] = softness * 0.5 * dist;

            const outer = Math.min(179, Math.max(1, s.spotAngle)) * 0.5 * Math.PI / 180;
            const inner = outer * (1 - Math.min(1, Math.max(0, s.spotBlend)));
            const cosOuter = Math.cos(outer);
            out[o + 8] = forward.x;
            out[o + 9] = forward.y;
            out[o + 10] = forward.z;
            out[o + 11] = cosOuter;
            // smoothstep needs its edges apart
            out[o + 12] = Math.max(Math.cos(inner), cosOuter + 1e-4);
            // intensity is measured at the aim point
            out[o + 13] = dist * dist;
        }

        n++;
    }
    return n;
};

/**
 * What de-light scales its estimate of the capture's light by: one over
 * what an open surface squarely facing every matched light had - the sky's
 * 1, plus each matched light's colour times intensity, which is what any
 * kind of light delivers at its aim point. Per channel, so a warm sun in
 * the capture is taken out of the shadows' colour as well as their depth.
 */
const delightScaleOf = (matched: SceneLight[]) => {
    const sum = [1, 1, 1];
    for (const light of matched) {
        const intensity = Math.max(0, light.settings.intensity);
        sum[0] += light.settings.color[0] * intensity;
        sum[1] += light.settings.color[1] * intensity;
        sum[2] += light.settings.color[2] * intensity;
    }
    return [1 / sum[0], 1 / sum[1], 1 / sum[2]];
};

/**
 * Every visible ambient light, summed into the one set of irradiance
 * coefficients the kernel reads - so ambient lights cost the same however
 * many there are. Returns whether there was any. An ambient light always
 * adds light: the capture's own sky is what de-light's occlusion stands for.
 */
const packAmbient = (lights: SceneLight[], out: Float32Array) => {
    const offset = AMBIENT_BASE * 4;
    out.fill(0, offset, offset + SH_COUNT * 4);
    let any = false;
    for (const light of lights) {
        const s = light.settings;
        if (s.kind !== 'ambient') continue;
        addAmbientSH(out, offset, s.color, Math.max(0, s.intensity), s.environment ?? null, s.rotation ?? 0);
        any = true;
    }
    return any;
};

class Relighter {
    scene: Scene;
    events: Events;
    device: GraphicsDevice;

    readonly supported: boolean;

    private kernels: Kernels = null;
    private grid: DensityGrid = null;
    private entries = new Map<Splat, SplatLighting>();
    private lightBuffer: StorageBuffer = null;
    private lightData = new Float32Array(LIGHT_BUFFER_FLOATS);
    // doubles, so the settings are compared exactly - a float copy of 0.2 is
    // never equal to 0.2, and the lighting would rerun forever
    private seenLights = new Float64Array(LIGHT_BUFFER_FLOATS + SEEN_HEAD);
    private seenDelight = new Float64Array(MAX_LIGHTS * LIGHT_FLOATS + MAX_EMITTERS * EMITTER_FLOATS + DELIGHT_HEAD);
    private lightsUploaded = false;
    private delightScale = [1, 1, 1];

    private active = false;
    private gridDirty = true;
    private occlusionDirty = true;
    private lightingDirty = true;
    private lastGridBuild = -Infinity;
    private gridResolution = 0;
    private reportedResolution = '';
    private positionsVersion = new Map<Splat, number>();
    private failed = false;

    /** for the curious and for tests: what the last build did */
    stats = {
        gridBuilds: 0,
        occlusionPasses: 0,
        lightingPasses: 0,
        capturedBuilds: 0,
        capturedOcclusionPasses: 0,
        delightPasses: 0,
        lastGridMs: 0,
        lastOcclusionMs: 0,
        lastLightingMs: 0,
        lastCapturedMs: 0
    };

    constructor(scene: Scene) {
        this.scene = scene;
        this.events = scene.events;
        this.device = scene.graphicsDevice;
        this.supported = !!(this.device.isWebGPU && (this.device as any).supportsCompute);

        const { events } = this;

        // palette transforms move gaussians without changing any count or
        // matrix the grid could compare, so they are counted here
        events.on('splat.positionsChanged', (splat: Splat) => {
            this.positionsVersion.set(splat, (this.positionsVersion.get(splat) ?? 0) + 1);
        });

        events.on('scene.elementRemoved', (element: any) => {
            if (element?.type === ElementType.splat) {
                this.release(element as Splat);
            }
        });

        events.on('update', () => this.update());
    }

    private visibleLights() {
        return (this.scene.getElementsByType(ElementType.light) as SceneLight[])
        .filter(light => light instanceof SceneLight && light.visible);
    }

    private visibleSplats() {
        return (this.scene.getElementsByType(ElementType.splat) as Splat[])
        .filter(splat => splat.visible && splat.entity?.gsplat?.instance);
    }

    /** turn a splat material's lighting on or off, and keep it bound */
    private bindMaterial(splat: Splat, entry: SplatLighting | null) {
        const material = splat.entity?.gsplat?.instance?.material;
        if (!material) return;
        const on = !!entry;
        if (on) {
            material.setParameter('splatLightPlus', entry.lightPlus);
            material.setParameter('splatLightMinus', entry.lightMinus);
        }
        if (material.getDefine('SPLAT_LIGHTING') !== on) {
            material.setDefine('SPLAT_LIGHTING', on);
            material.update();
        }
    }

    private release(splat: Splat) {
        const entry = this.entries.get(splat);
        if (entry) {
            entry.destroy();
            this.entries.delete(splat);
            this.gridDirty = true;
        }
        this.positionsVersion.delete(splat);
    }

    /** Lighting off: every material back to captured colour, memory freed. */
    private deactivate() {
        for (const splat of this.scene.getElementsByType(ElementType.splat) as Splat[]) {
            this.bindMaterial(splat, null);
        }
        this.entries.forEach(entry => entry.destroy());
        this.entries.clear();
        this.grid?.destroy();
        this.grid = null;
        this.lightBuffer?.destroy();
        this.lightBuffer = null;
        this.active = false;
        this.scene.forceRender = true;
    }

    private update() {
        if (!this.supported || this.failed) return;

        const lights = this.visibleLights();
        if (lights.length === 0) {
            if (this.active) this.deactivate();
            return;
        }

        try {
            this.relight(lights);
        } catch (err) {
            // a failure here must not take the viewport down with it
            console.error('relighting failed', err);
            this.failed = true;
            this.deactivate();
        }
    }

    private relight(lights: SceneLight[]) {
        const { device } = this;

        if (!this.active) {
            this.kernels ??= new Kernels(device);
            this.grid = new DensityGrid(device, this.kernels);
            this.lightBuffer = new StorageBuffer(device, LIGHT_BUFFER_FLOATS * 4, BUFFERUSAGE_COPY_DST);
            this.lightsUploaded = false;
            this.active = true;
            this.gridDirty = true;
            this.occlusionDirty = true;
            this.lightingDirty = true;
        }

        // a grid the GPU could not hold is laid out again, coarser
        if (this.grid.outOfMemory) {
            this.grid.outOfMemory = false;
            this.gridDirty = true;
        }

        // bring the per-object resources in line with what is drawn
        const splats = this.visibleSplats();
        for (const [splat] of this.entries) {
            if (!splats.includes(splat)) {
                this.bindMaterial(splat, null);
                this.release(splat);
            }
        }
        for (const splat of splats) {
            let entry = this.entries.get(splat);
            // a sequence frame swaps the data under the same object
            if (entry && entry.data !== splat.splatData) {
                this.release(splat);
                entry = null;
            }
            if (!entry) {
                entry = new SplatLighting(device, this.kernels, splat);
                this.entries.set(splat, entry);
                this.gridDirty = true;
                this.lightingDirty = true;
            }

            // what would make the grid stale: deletions, hiding, the object's
            // transform, a palette transform
            const matrix = splat.entity.getWorldTransform().data;
            const positions = this.positionsVersion.get(splat) ?? 0;
            if (!sameMatrix(matrix, entry.seenMatrix) || entry.seenDeleted !== splat.numDeleted || entry.seenLocked !== splat.numLocked || entry.seenPositions !== positions) {
                this.gridDirty = true;
            }

            // The object's relight node, if it has one. Without one, lights
            // only add to its captured light: no shadows, no occlusion and no
            // de-light, since those are what the node asks for.
            const settings = splat.relight ? normalizeRelightSettings(splat.relight) : null;
            const seenSettings = settings ? [
                1, settings.capturedLight, settings.resolution, settings.occlusionRange,
                settings.occlusionStrength, settings.delight, settings.delightFloor, settings.delightSeesDeleted ? 1 : 0
            ] : [0];
            const changed = (i: number) => entry.seenSettings[i] !== seenSettings[i];
            if (changed(0)) {
                // relit or not decides whether the grid is needed at all
                this.gridDirty = true;
                this.lightingDirty = true;
            } else if (settings) {
                if (changed(2)) this.gridDirty = true;
                if (changed(3)) this.occlusionDirty = true;
                if (changed(1) || changed(4)) this.lightingDirty = true;
                if (changed(5) || changed(6)) {
                    entry.delightDirty = true;
                    this.lightingDirty = true;
                }
            }
            entry.settings = settings;
            entry.seenSettings = seenSettings;

            // De-light's grid sees the object as it was captured, so far less
            // makes it stale: the object's own transform - its captured light
            // moved with it - the resolution, and deletions only when it is
            // told to leave deleted gaussians out. Never the palette or hiding.
            if (settings && settings.delight > 0) {
                entry.ensureDelight(device, this.kernels);
                const deleted = settings.delightSeesDeleted ? -1 : splat.numDeleted;
                if (!sameMatrix(matrix, entry.capturedMatrix) || entry.capturedDeleted !== deleted || entry.capturedResolution !== settings.resolution) {
                    entry.capturedDirty = true;
                }
                if (entry.captured.outOfMemory) {
                    entry.captured.outOfMemory = false;
                    entry.capturedDirty = true;
                }
                if (entry.capturedRange !== settings.occlusionRange) {
                    entry.capturedSkyDirty = true;
                }
            } else {
                entry.releaseDelight();
            }
        }

        // what would make the lighting stale: the lights - those that add
        // light first, then those matched to the capture - the ambient light,
        // and the settings the lighting pass reads
        const direct = lights.filter(light => light.settings.kind !== 'ambient');
        const adding = direct.filter(light => light.settings.role !== 'match');
        const matched = direct.filter(light => light.settings.role === 'match');
        this.lightData.fill(0, 0, MAX_LIGHTS * LIGHT_FLOATS);
        this.lightData.fill(0, EMITTER_BASE * 4);
        const cursor = { next: 0 };
        const count = packLights(adding, this.lightData, 0, cursor);
        const firstMatchedEmitter = cursor.next;
        const matchedCount = packLights(matched, this.lightData, count, cursor);
        const ambient = packAmbient(lights, this.lightData);
        this.delightScale = delightScaleOf(matched.slice(0, matchedCount));

        const seen = this.seenLights;
        const head = [count, ambient ? 1 : 0];
        let lightsChanged = false;
        for (let i = 0; i < SEEN_HEAD && !lightsChanged; ++i) {
            lightsChanged = seen[i] !== head[i];
        }
        for (let i = 0; i < LIGHT_BUFFER_FLOATS && !lightsChanged; ++i) {
            lightsChanged = seen[i + SEEN_HEAD] !== this.lightData[i];
        }
        if (lightsChanged) {
            seen.set(head, 0);
            seen.set(this.lightData, SEEN_HEAD);
            this.lightingDirty = true;
        }
        if (lightsChanged || !this.lightsUploaded) {
            this.lightBuffer.write(0, this.lightData, 0, this.lightData.length);
            this.lightsUploaded = true;
        }

        // what would make de-light stale: the matched lights and their
        // emitters - wherever they sit in the buffer - and its own settings.
        // Lights that add light do not, so moving one reruns the lighting alone
        const matchedRecords = this.lightData.subarray(count * LIGHT_FLOATS, (count + matchedCount) * LIGHT_FLOATS);
        const matchedEmitters = this.lightData.subarray((EMITTER_BASE + firstMatchedEmitter * 2) * 4, (EMITTER_BASE + cursor.next * 2) * 4);
        const matchedData = new Float32Array(matchedRecords.length + matchedEmitters.length);
        matchedData.set(matchedRecords, 0);
        matchedData.set(matchedEmitters, matchedRecords.length);
        const seenDelight = this.seenDelight;
        const delightHead = [matchedCount];
        let delightChanged = false;
        for (let i = 0; i < DELIGHT_HEAD && !delightChanged; ++i) {
            delightChanged = seenDelight[i] !== delightHead[i];
        }
        for (let i = 0; i < matchedData.length && !delightChanged; ++i) {
            delightChanged = seenDelight[i + DELIGHT_HEAD] !== matchedData[i];
        }
        if (delightChanged) {
            seenDelight.set(delightHead, 0);
            seenDelight.set(matchedData, DELIGHT_HEAD);
            this.entries.forEach((entry) => {
                entry.delightDirty = true;
            });
        }

        // occlusion exists only while something reads it: an ambient light,
        // on an object with a relight node
        for (const splat of splats) {
            const entry = this.entries.get(splat);
            if (ambient && entry.settings) {
                if (entry.ensureOcclusion(device, this.kernels)) {
                    this.occlusionDirty = true;
                }
            } else {
                entry.releaseOcclusion();
            }
        }

        const entries = splats.map(s => this.entries.get(s));

        // The scene's grid is for shadows and occlusion, which only an object
        // with a relight node gets - but every object casts them, so every
        // one goes in. It is as fine as the finest any relight node asks for,
        // and it is not kept while none asks for it.
        const relit = entries.filter(entry => entry.settings);
        const resolution = relit.reduce((r, entry) => Math.max(r, entry.settings.resolution), 0);
        if (resolution !== this.gridResolution) {
            this.gridResolution = resolution;
            this.gridDirty = true;
        }
        const needGrid = relit.length > 0;
        if (!needGrid && this.grid.capacity > 0) {
            this.grid.release();
        }

        // grids are rebuilt together, and no more often than the interval
        const stale = entries.filter(entry => entry.captured && entry.capturedDirty);
        if ((needGrid && this.gridDirty) || stale.length > 0) {
            const now = performance.now();
            if (now - this.lastGridBuild >= GRID_MIN_INTERVAL_MS) {
                if (needGrid && this.gridDirty) {
                    this.buildGrid(entries, resolution);
                    this.gridDirty = false;
                    this.occlusionDirty = true;
                }
                for (const entry of stale) {
                    this.buildCaptured(entry);
                    entry.capturedDirty = false;
                    entry.capturedSkyDirty = true;
                }
                this.lastGridBuild = now;
                this.lightingDirty = true;
            }
        }

        const occluded = relit.filter(entry => entry.occlusion);
        if (occluded.length > 0 && this.occlusionDirty && !this.gridDirty) {
            this.occlude(occluded);
            this.occlusionDirty = false;
            this.lightingDirty = true;
        }

        for (const entry of entries) {
            if (!entry.captured || entry.capturedDirty) continue;
            if (entry.capturedSkyDirty) {
                this.occludeCaptured(entry);
                entry.capturedSkyDirty = false;
                entry.delightDirty = true;
            }
            if (entry.delightDirty) {
                this.delightPass(entry, count, matchedCount);
                entry.delightDirty = false;
                this.lightingDirty = true;
            }
        }

        // lighting waits for everything it reads
        const ready = (!needGrid || !this.gridDirty) && entries.every(entry => !entry.captured || !entry.capturedDirty);
        if (this.lightingDirty && ready) {
            this.light(entries, count, ambient);
            this.lightingDirty = false;
            this.scene.forceRender = true;
        }

        for (const splat of splats) {
            this.bindMaterial(splat, this.entries.get(splat));
        }

        const used = splats.map(splat => this.usedResolution(splat)).join();
        if (used !== this.reportedResolution) {
            this.reportedResolution = used;
            this.events.fire('relight.resolutionUsed');
        }
    }

    /**
     * The resolution an object's grids actually came to: what its relight
     * node asks for, unless the GPU could not hold a grid that fine - the
     * scene's, which serves every object, or the object's own for de-light.
     * Null for an object with no relight node.
     */
    usedResolution(splat: Splat) {
        const entry = this.entries.get(splat);
        const settings = entry?.settings;
        if (!settings) return null;
        let used = settings.resolution;
        if (this.grid?.resolution) used = Math.min(used, this.grid.resolution);
        if (entry.captured?.resolution) used = Math.min(used, entry.captured.resolution);
        return used;
    }

    private buildGrid(entries: SplatLighting[], resolution: number) {
        const start = performance.now();
        const { device, grid } = this;

        // every drawn gaussian, where it is now: hidden and deleted ones cast
        // no shadow
        const skip = STATE_LOCKED | STATE_DELETED;
        const box = robustBox(entries, skip, false) ?? { min: [-1, -1, -1], max: [1, 1, 1] };
        grid.layout(box, resolution);
        grid.clear();

        for (const entry of entries) {
            const { splat, deposit } = entry;
            deposit.setParameter('gaussians', entry.gaussians);
            deposit.setParameter('accum', grid.accum);
            deposit.setParameter('levels', grid.levelBuffer);
            deposit.setParameter('splatState', splat.stateTexture);
            deposit.setParameter('splatTransform', splat.transformTexture);
            deposit.setParameter('transformPalette', splat.transformPalette.texture);
            deposit.setParameter('matrixModel', splat.entity.getWorldTransform().data);
            deposit.setParameter('gridOrigin', grid.gridOrigin);
            deposit.setParameter('gridDims', grid.gridDims);
            deposit.setParameter('counts', [entry.count, entry.width, skip, 0]);
            dispatchFor(device, deposit, entry.count);
            device.computeDispatch([deposit], 'RelightDeposit');

            // remember what this grid was built from
            entry.seenMatrix.set(splat.entity.getWorldTransform().data);
            entry.seenDeleted = splat.numDeleted;
            entry.seenLocked = splat.numLocked;
            entry.seenPositions = this.positionsVersion.get(splat) ?? 0;
        }

        grid.finish();

        this.stats.gridBuilds++;
        this.stats.lastGridMs = performance.now() - start;
    }

    /**
     * One object as its capture saw it, for de-light: its own gaussians and
     * nothing else in the scene - another object was not there when this one
     * was shot, and shadows nothing baked into it - where the capture put
     * them, before any palette transform, and deleted ones too unless the
     * settings say otherwise. A deleted car still shadowed the road it was
     * captured on. The object's own transform does apply: the light it was
     * captured under moved with it.
     */
    private buildCaptured(entry: SplatLighting) {
        const start = performance.now();
        const { device } = this;
        const { splat, captured, capturedDeposit: deposit } = entry;
        const { settings } = entry;
        const skip = settings.delightSeesDeleted ? 0 : STATE_DELETED;
        const matrix = splat.entity.getWorldTransform().data;

        const box = robustBox([entry], skip, true) ?? { min: [-1, -1, -1], max: [1, 1, 1] };
        captured.layout(box, settings.resolution);
        captured.clear();

        deposit.setParameter('gaussians', entry.gaussians);
        deposit.setParameter('accum', captured.accum);
        deposit.setParameter('levels', captured.levelBuffer);
        deposit.setParameter('splatState', splat.stateTexture);
        deposit.setParameter('splatTransform', splat.transformTexture);
        deposit.setParameter('transformPalette', splat.transformPalette.texture);
        deposit.setParameter('matrixModel', matrix);
        deposit.setParameter('gridOrigin', captured.gridOrigin);
        deposit.setParameter('gridDims', captured.gridDims);
        deposit.setParameter('counts', [entry.count, entry.width, skip, 1]);
        dispatchFor(device, deposit, entry.count);
        device.computeDispatch([deposit], 'RelightCapturedDeposit');

        captured.finish();

        entry.capturedMatrix.set(matrix);
        entry.capturedDeleted = settings.delightSeesDeleted ? -1 : splat.numDeleted;
        entry.capturedResolution = settings.resolution;

        this.stats.capturedBuilds++;
        this.stats.lastCapturedMs = performance.now() - start;
    }

    private occlude(entries: SplatLighting[]) {
        const start = performance.now();
        const { device, grid } = this;

        for (const entry of entries) {
            const { splat, occlusion } = entry;
            // the range is a share of the grid's longest side, so it means
            // the same on a capture of any scale
            const range = entry.settings.occlusionRange * grid.longest;
            occlusion.setParameter('gaussians', entry.gaussians);
            occlusion.setParameter('density', grid.density);
            occlusion.setParameter('levels', grid.levelBuffer);
            occlusion.setParameter('splatState', splat.stateTexture);
            occlusion.setParameter('splatTransform', splat.transformTexture);
            occlusion.setParameter('transformPalette', splat.transformPalette.texture);
            occlusion.setParameter('occlusionPlus', entry.occlusionPlus);
            occlusion.setParameter('occlusionMinus', entry.occlusionMinus);
            occlusion.setParameter('matrixModel', splat.entity.getWorldTransform().data);
            occlusion.setParameter('gridOrigin', grid.gridOrigin);
            occlusion.setParameter('gridDims', grid.gridDims);
            occlusion.setParameter('counts', [entry.count, entry.width, 0, 0]);
            occlusion.setParameter('params', [range, RAY_OFFSET_CELLS, OCCLUSION_TAN_HALF, 0]);
            dispatchFor(device, occlusion, entry.count);
            device.computeDispatch([occlusion], 'RelightOcclusion');
        }

        this.stats.occlusionPasses++;
        this.stats.lastOcclusionMs = performance.now() - start;
    }

    /**
     * How open each gaussian was where the capture put it - how much of the
     * capture's sky reached it. Traced through the object's captured grid,
     * with the range taken from that grid, so on an unedited capture it is
     * the very occlusion the ambient light is dimmed by, and the two cancel.
     */
    private occludeCaptured(entry: SplatLighting) {
        const { device } = this;
        const { splat, captured, capturedOcclusion: occlusion } = entry;
        const range = entry.settings.occlusionRange * captured.longest;

        occlusion.setParameter('gaussians', entry.gaussians);
        occlusion.setParameter('density', captured.density);
        occlusion.setParameter('levels', captured.levelBuffer);
        occlusion.setParameter('splatState', splat.stateTexture);
        occlusion.setParameter('splatTransform', splat.transformTexture);
        occlusion.setParameter('transformPalette', splat.transformPalette.texture);
        occlusion.setParameter('occlusionPlus', entry.capturedPlus);
        occlusion.setParameter('occlusionMinus', entry.capturedMinus);
        occlusion.setParameter('matrixModel', splat.entity.getWorldTransform().data);
        occlusion.setParameter('gridOrigin', captured.gridOrigin);
        occlusion.setParameter('gridDims', captured.gridDims);
        occlusion.setParameter('counts', [entry.count, entry.width, 0, 1]);
        occlusion.setParameter('params', [range, RAY_OFFSET_CELLS, OCCLUSION_TAN_HALF, 0]);
        dispatchFor(device, occlusion, entry.count);
        device.computeDispatch([occlusion], 'RelightCapturedOcclusion');

        entry.capturedRange = entry.settings.occlusionRange;
        this.stats.capturedOcclusionPasses++;
    }

    /** What the capture's own light was, for lighting to divide by. */
    private delightPass(entry: SplatLighting, firstMatched: number, matchedCount: number) {
        const { device } = this;
        const { splat, captured, delighting, settings } = entry;

        delighting.setParameter('gaussians', entry.gaussians);
        delighting.setParameter('density', captured.density);
        delighting.setParameter('levels', captured.levelBuffer);
        delighting.setParameter('lights', this.lightBuffer);
        delighting.setParameter('splatState', splat.stateTexture);
        delighting.setParameter('splatTransform', splat.transformTexture);
        delighting.setParameter('transformPalette', splat.transformPalette.texture);
        delighting.setParameter('capturedPlus', entry.capturedPlus);
        delighting.setParameter('capturedMinus', entry.capturedMinus);
        delighting.setParameter('delightPlus', entry.delightPlus);
        delighting.setParameter('delightMinus', entry.delightMinus);
        delighting.setParameter('matrixModel', splat.entity.getWorldTransform().data);
        delighting.setParameter('gridOrigin', captured.gridOrigin);
        delighting.setParameter('gridDims', captured.gridDims);
        delighting.setParameter('counts', [entry.count, entry.width, firstMatched, matchedCount]);
        delighting.setParameter('params', [settings.delight, WRAP, RAY_OFFSET_CELLS, settings.delightFloor]);
        delighting.setParameter('scale', [...this.delightScale, DELIGHT_ERODE_CELLS]);
        dispatchFor(device, delighting, entry.count);
        device.computeDispatch([delighting], 'RelightDelight');

        this.stats.delightPasses++;
    }

    private light(entries: SplatLighting[], lightCount: number, ambient: boolean) {
        const start = performance.now();
        const { device, grid, kernels } = this;

        for (const entry of entries) {
            const { splat, lighting, settings } = entry;
            lighting.setParameter('gaussians', entry.gaussians);
            // an object with no relight node reads no grid, and there may be none
            lighting.setParameter('density', grid.density ?? kernels.emptyGrid);
            lighting.setParameter('levels', grid.levelBuffer);
            lighting.setParameter('lights', this.lightBuffer);
            lighting.setParameter('splatState', splat.stateTexture);
            lighting.setParameter('splatTransform', splat.transformTexture);
            lighting.setParameter('transformPalette', splat.transformPalette.texture);
            lighting.setParameter('lightPlus', entry.lightPlus);
            lighting.setParameter('lightMinus', entry.lightMinus);
            lighting.setParameter('occlusionPlus', entry.occlusionPlus ?? kernels.noOcclusion);
            lighting.setParameter('occlusionMinus', entry.occlusionMinus ?? kernels.noOcclusion);
            lighting.setParameter('matrixModel', splat.entity.getWorldTransform().data);
            lighting.setParameter('gridOrigin', grid.gridOrigin);
            lighting.setParameter('gridDims', grid.gridDims);
            lighting.setParameter('delightPlus', entry.delightPlus ?? kernels.noOcclusion);
            lighting.setParameter('delightMinus', entry.delightMinus ?? kernels.noOcclusion);
            lighting.setParameter('counts', [entry.count, entry.width, lightCount, 0]);
            // without a relight node: all of the captured light, and the
            // lights added to it unshadowed
            lighting.setParameter('params', settings ? [settings.capturedLight, WRAP, RAY_OFFSET_CELLS, 0] : [1, WRAP, RAY_OFFSET_CELLS, 1]);
            lighting.setParameter('ambient', [ambient ? 1 : 0, settings?.occlusionStrength ?? 0, entry.delightPlus ? 1 : 0, entry.occlusion ? 1 : 0]);
            dispatchFor(device, lighting, entry.count);
            device.computeDispatch([lighting], 'RelightLighting');
        }

        this.stats.lightingPasses++;
        this.stats.lastLightingMs = performance.now() - start;
    }

    /** grid and per-object state, for tests and debugging */
    debugState() {
        const grid = this.grid;
        return {
            active: this.active,
            supported: this.supported,
            failed: this.failed,
            grid: grid ? {
                origin: grid.origin.slice(),
                cell: grid.cell,
                dims: grid.dims.slice(),
                requested: grid.requested,
                resolution: grid.resolution,
                capacity: grid.capacity,
                cellLimit: grid.cellLimit,
                levels: grid.levels.map(l => l.slice()),
                density: grid.density
            } : null,
            entries: [...this.entries.values()].map(e => ({
                splat: e.splat,
                lightPlus: e.lightPlus,
                lightMinus: e.lightMinus,
                occlusionPlus: e.occlusionPlus,
                occlusionMinus: e.occlusionMinus,
                capturedPlus: e.capturedPlus,
                capturedMinus: e.capturedMinus,
                delightPlus: e.delightPlus,
                delightMinus: e.delightMinus,
                captured: e.captured ? {
                    origin: e.captured.origin.slice(),
                    cell: e.captured.cell,
                    dims: e.captured.dims.slice(),
                    resolution: e.captured.resolution,
                    levels: e.captured.levels.length
                } : null,
                settings: e.settings ? { ...e.settings } : null,
                width: e.width,
                height: e.height,
                count: e.count
            })),
            stats: { ...this.stats }
        };
    }
}

const registerRelighting = (events: Events, scene: Scene) => {
    const relighter = new Relighter(scene);

    events.function('relight.supported', () => relighter.supported);
    events.function('relight.debug', () => relighter.debugState());
    events.function('relight.resolutionUsed', (splat: Splat) => relighter.usedResolution(splat));

    return relighter;
};

export { registerRelighting, Relighter, defaultRelightSettings, normalizeRelightSettings, type RelightSettings };
