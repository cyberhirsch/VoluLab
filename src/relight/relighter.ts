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
import { AMBIENT_BASE, MAX_LIGHTS, SH_COUNT, depositSource, lightingSource, occlusionSource, pullSource, pushSource, resolveSource, WORKGROUP } from './relight-shaders';
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
    /** how much of the lighting baked into the capture is kept */
    capturedLight: number;
    /** finest grid cells along the scene's longest side */
    resolution: number;
    /** how far occlusion looks, as a share of the scene's longest side */
    occlusionRange: number;
    /** 0 ambient light ignores occlusion, 1 it is fully shut out */
    occlusionStrength: number;
};

const defaultRelightSettings = (): RelightSettings => ({
    capturedLight: 0.4,
    resolution: 128,
    occlusionRange: 0.1,
    occlusionStrength: 1
});

const MAX_LEVELS = 8;
const LIGHT_FLOATS = 16;

// the light records, then the ambient coefficients after them
const LIGHT_BUFFER_FLOATS = (AMBIENT_BASE + SH_COUNT) * 4;

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

/** The six kernels, compiled once per device. */
class Kernels {
    deposit: Shader;
    resolve: Shader;
    pull: Shader;
    push: Shader;
    occlusion: Shader;
    lighting: Shader;
    noOcclusion: Texture;

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
            texture('occlusionMinus', SAMPLETYPE_FLOAT)
        ], [
            ...gaussianUniforms(),
            new UniformFormat('params', UNIFORMTYPE_VEC4),
            new UniformFormat('ambient', UNIFORMTYPE_VEC4)
        ]);

        // bound in place of the occlusion textures while there is no ambient
        // light to need them - the kernel never reads it
        this.noOcclusion = new Texture(device, {
            name: 'relightNoOcclusion',
            width: 1,
            height: 1,
            format: PIXELFORMAT_RGBA16F,
            mipmaps: false,
            minFilter: FILTER_NEAREST,
            magFilter: FILTER_NEAREST
        });
    }

    destroy() {
        this.deposit.destroy();
        this.resolve.destroy();
        this.pull.destroy();
        this.push.destroy();
        this.occlusion.destroy();
        this.lighting.destroy();
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

/**
 * The density grid: a pyramid of levels in two flat buffers, the fixed-point
 * accumulator the deposits land in and the float densities everything reads.
 * Levels are laid end to end; `levels` holds each one's dims and offset.
 */
class DensityGrid {
    device: GraphicsDevice;
    origin = [0, 0, 0];
    cell = 1;
    dims = [1, 1, 1];
    levels: number[][] = [];
    totalCells = 0;
    capacity = 0;

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

    /** Lay the grid over a box: cubic cells, one cell of margin all round. */
    layout(box: Box, resolution: number) {
        const extent = [0, 1, 2].map(a => Math.max(0, box.max[a] - box.min[a]));
        const longest = Math.max(extent[0], extent[1], extent[2], 1e-6);
        const cell = longest / Math.max(8, resolution);

        this.cell = cell;
        this.dims = extent.map(e => Math.max(1, Math.ceil(e / cell)) + 2);
        this.origin = box.min.map(v => v - cell);

        // levels halve until the coarsest is a couple of cells across
        this.levels = [];
        let dims = this.dims.slice();
        let offset = 0;
        for (let l = 0; l < MAX_LEVELS; ++l) {
            this.levels.push([dims[0], dims[1], dims[2], offset]);
            offset += dims[0] * dims[1] * dims[2];
            if (Math.max(dims[0], dims[1], dims[2]) <= 2) break;
            dims = dims.map(d => Math.max(1, Math.ceil(d / 2)));
        }
        this.totalCells = offset;

        // buffers grow but never shrink, so a drag that nudges the bounds
        // every frame does not reallocate every frame
        if (this.totalCells > this.capacity) {
            this.accum?.destroy();
            this.density?.destroy();
            this.capacity = Math.ceil(this.totalCells * 1.25);
            this.accum = new StorageBuffer(this.device, this.capacity * 4, BUFFERUSAGE_COPY_DST);
            this.density = new StorageBuffer(this.device, this.capacity * 4, BUFFERUSAGE_COPY_SRC | BUFFERUSAGE_COPY_DST);
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

    get levelCount() {
        return this.levels.length;
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

    destroy() {
        this.gaussians.destroy();
        this.lightPlus.destroy();
        this.lightMinus.destroy();
        this.deposit.destroy();
        this.lighting.destroy();
        this.releaseOcclusion();
    }
}

/**
 * The box the grid covers: every drawn gaussian's centre, trimmed of the
 * farthest half percent on each side of each axis and then padded a little.
 * A capture's bounds are set by its worst floater, and a grid stretched over
 * that spends its cells on nothing. Gaussians outside the box cast no shadow
 * and are lit as if unoccluded.
 */
const robustBox = (entries: SplatLighting[]): Box | null => {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    let total = 0;

    const visit = (fn: (wx: number, wy: number, wz: number) => void) => {
        for (const entry of entries) {
            const { splat } = entry;
            const centers = (splat.entity.gsplat?.instance as any)?.sorter?.centers as Float32Array;
            const state = splat.splatData.getProp('state') as Uint8Array;
            const m = splat.entity.getWorldTransform().data;
            const x = splat.splatData.getProp('x') as Float32Array;
            const y = splat.splatData.getProp('y') as Float32Array;
            const z = splat.splatData.getProp('z') as Float32Array;
            for (let i = 0; i < entry.count; ++i) {
                if (state && (state[i] & 6)) continue;
                // the sorter's centres follow the transform palette; the
                // raw positions are the fallback
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
 * One light record per light - see the lighting kernel for the layout.
 * Returns how many were written.
 */
const packLights = (lights: SceneLight[], out: Float32Array) => {
    out.fill(0, 0, MAX_LIGHTS * LIGHT_FLOATS);
    let n = 0;
    for (const light of lights) {
        if (n >= MAX_LIGHTS) break;
        if (light.settings.kind === 'ambient') continue;
        const s = light.settings;
        const o = n * LIGHT_FLOATS;

        const dx = light.target.x - light.position.x;
        const dy = light.target.y - light.position.y;
        const dz = light.target.z - light.position.z;
        const dist = Math.max(Math.hypot(dx, dy, dz), 1e-4);
        const ax = dx / dist;
        const ay = dy / dist;
        const az = dz / dist;

        const intensity = Math.max(0, s.intensity);
        const softness = Math.min(1, Math.max(0, s.softness));

        if (s.kind === 'sun') {
            // toward the sun: against the direction it shines
            out[o] = -ax;
            out[o + 1] = -ay;
            out[o + 2] = -az;
            out[o + 3] = 2;
            out[o + 7] = Math.tan(SUN_MIN_HALF_ANGLE + softness * (SUN_MAX_HALF_ANGLE - SUN_MIN_HALF_ANGLE));
        } else {
            out[o] = light.position.x;
            out[o + 1] = light.position.y;
            out[o + 2] = light.position.z;
            out[o + 3] = s.kind === 'spot' ? 1 : 0;
            // the emitter's radius, as a share of its distance to the aim point
            out[o + 7] = softness * 0.5 * dist;
        }

        out[o + 4] = s.color[0] * intensity;
        out[o + 5] = s.color[1] * intensity;
        out[o + 6] = s.color[2] * intensity;

        const outer = Math.min(179, Math.max(1, s.spotAngle)) * 0.5 * Math.PI / 180;
        const inner = outer * (1 - Math.min(1, Math.max(0, s.spotBlend)));
        const cosOuter = Math.cos(outer);
        out[o + 8] = ax;
        out[o + 9] = ay;
        out[o + 10] = az;
        out[o + 11] = cosOuter;
        // smoothstep needs its edges apart
        out[o + 12] = Math.max(Math.cos(inner), cosOuter + 1e-4);
        // intensity is measured at the aim point
        out[o + 13] = dist * dist;

        n++;
    }
    return n;
};

/**
 * Every visible ambient light, summed into the one set of irradiance
 * coefficients the kernel reads - so ambient lights cost the same however
 * many there are. Returns whether there was any.
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
    settings = defaultRelightSettings();

    readonly supported: boolean;

    private kernels: Kernels = null;
    private grid: DensityGrid = null;
    private entries = new Map<Splat, SplatLighting>();
    private lightBuffer: StorageBuffer = null;
    private lightData = new Float32Array(LIGHT_BUFFER_FLOATS);
    // doubles, so the settings are compared exactly - a float copy of 0.2 is
    // never equal to 0.2, and the lighting would rerun forever
    private seenLights = new Float64Array(LIGHT_BUFFER_FLOATS + 4);

    private active = false;
    private gridDirty = true;
    private occlusionDirty = true;
    private lightingDirty = true;
    private lastGridBuild = -Infinity;
    private positionsVersion = new Map<Splat, number>();
    private failed = false;

    /** for the curious and for tests: what the last build did */
    stats = { gridBuilds: 0, occlusionPasses: 0, lightingPasses: 0, lastGridMs: 0, lastOcclusionMs: 0, lastLightingMs: 0 };

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
            this.active = true;
            this.gridDirty = true;
            this.occlusionDirty = true;
            this.lightingDirty = true;
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
            let moved = false;
            for (let i = 0; i < 16; ++i) {
                if (matrix[i] !== entry.seenMatrix[i]) {
                    moved = true;
                    break;
                }
            }
            if (moved || entry.seenDeleted !== splat.numDeleted || entry.seenLocked !== splat.numLocked || entry.seenPositions !== positions) {
                this.gridDirty = true;
            }
        }

        // what would make the lighting stale: the lights, the ambient light,
        // the captured share, the occlusion strength
        const count = packLights(lights, this.lightData);
        const ambient = packAmbient(lights, this.lightData);
        const seen = this.seenLights;
        const head = [count, this.settings.capturedLight, this.settings.occlusionStrength, ambient ? 1 : 0];
        let lightsChanged = false;
        for (let i = 0; i < head.length && !lightsChanged; ++i) {
            lightsChanged = seen[i] !== head[i];
        }
        for (let i = 0; i < LIGHT_BUFFER_FLOATS && !lightsChanged; ++i) {
            lightsChanged = seen[i + head.length] !== this.lightData[i];
        }
        if (lightsChanged) {
            seen.set(head, 0);
            seen.set(this.lightData, head.length);
            this.lightingDirty = true;
        }

        // occlusion exists only while something reads it
        for (const splat of splats) {
            const entry = this.entries.get(splat);
            if (ambient) {
                if (entry.ensureOcclusion(device, this.kernels)) {
                    this.occlusionDirty = true;
                }
            } else {
                entry.releaseOcclusion();
            }
        }

        const entries = splats.map(s => this.entries.get(s));

        if (this.gridDirty) {
            const now = performance.now();
            if (now - this.lastGridBuild >= GRID_MIN_INTERVAL_MS) {
                this.buildGrid(entries);
                this.lastGridBuild = now;
                this.gridDirty = false;
                this.occlusionDirty = true;
                this.lightingDirty = true;
            }
        }

        if (ambient && this.occlusionDirty && !this.gridDirty) {
            this.occlude(entries);
            this.occlusionDirty = false;
            this.lightingDirty = true;
        }

        if (this.lightingDirty && !this.gridDirty) {
            this.light(entries, count, ambient);
            this.lightingDirty = false;
            this.scene.forceRender = true;
        }

        for (const splat of splats) {
            this.bindMaterial(splat, this.entries.get(splat));
        }
    }

    private buildGrid(entries: SplatLighting[]) {
        const start = performance.now();
        const { device, grid } = this;

        const box = robustBox(entries) ?? { min: [-1, -1, -1], max: [1, 1, 1] };
        grid.layout(box, this.settings.resolution);
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
            deposit.setParameter('counts', [entry.count, entry.width, 0, 0]);
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

    private occlude(entries: SplatLighting[]) {
        const start = performance.now();
        const { device, grid } = this;

        // the range is a share of the grid's longest side, so it means the
        // same on a capture of any scale
        const longest = Math.max(grid.dims[0], grid.dims[1], grid.dims[2]) * grid.cell;
        const range = this.settings.occlusionRange * longest;

        for (const entry of entries) {
            const { splat, occlusion } = entry;
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

    private light(entries: SplatLighting[], lightCount: number, ambient: boolean) {
        const start = performance.now();
        const { device, grid } = this;

        this.lightBuffer.write(0, this.lightData, 0, this.lightData.length);

        for (const entry of entries) {
            const { splat, lighting } = entry;
            lighting.setParameter('gaussians', entry.gaussians);
            lighting.setParameter('density', grid.density);
            lighting.setParameter('levels', grid.levelBuffer);
            lighting.setParameter('lights', this.lightBuffer);
            lighting.setParameter('splatState', splat.stateTexture);
            lighting.setParameter('splatTransform', splat.transformTexture);
            lighting.setParameter('transformPalette', splat.transformPalette.texture);
            lighting.setParameter('lightPlus', entry.lightPlus);
            lighting.setParameter('lightMinus', entry.lightMinus);
            lighting.setParameter('occlusionPlus', entry.occlusionPlus ?? this.kernels.noOcclusion);
            lighting.setParameter('occlusionMinus', entry.occlusionMinus ?? this.kernels.noOcclusion);
            lighting.setParameter('matrixModel', splat.entity.getWorldTransform().data);
            lighting.setParameter('gridOrigin', grid.gridOrigin);
            lighting.setParameter('gridDims', grid.gridDims);
            lighting.setParameter('counts', [entry.count, entry.width, lightCount, 0]);
            lighting.setParameter('params', [this.settings.capturedLight, WRAP, RAY_OFFSET_CELLS, 0]);
            lighting.setParameter('ambient', [ambient && entry.occlusion ? 1 : 0, this.settings.occlusionStrength, 0, 0]);
            dispatchFor(device, lighting, entry.count);
            device.computeDispatch([lighting], 'RelightLighting');
        }

        this.stats.lightingPasses++;
        this.stats.lastLightingMs = performance.now() - start;
    }

    setSettings(partial: Partial<RelightSettings>) {
        const next = { ...this.settings, ...partial };
        next.capturedLight = Math.min(4, Math.max(0, Number(next.capturedLight) || 0));
        next.resolution = Math.round(Math.min(256, Math.max(32, Number(next.resolution) || 128)));
        next.occlusionRange = Math.min(1, Math.max(0.01, Number(next.occlusionRange) || 0.1));
        next.occlusionStrength = Math.min(1, Math.max(0, Number.isFinite(Number(next.occlusionStrength)) ? Number(next.occlusionStrength) : 1));
        if (next.resolution !== this.settings.resolution) {
            this.gridDirty = true;
        }
        if (next.occlusionRange !== this.settings.occlusionRange) {
            this.occlusionDirty = true;
        }
        this.settings = next;
        this.lightingDirty = true;
        this.events.fire('relight.settingsChanged', this.settings);
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
                levels: grid.levels.map(l => l.slice()),
                density: grid.density
            } : null,
            entries: [...this.entries.values()].map(e => ({
                splat: e.splat,
                lightPlus: e.lightPlus,
                lightMinus: e.lightMinus,
                occlusionPlus: e.occlusionPlus,
                occlusionMinus: e.occlusionMinus,
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
    events.function('relight.settings', () => ({ ...relighter.settings }));
    events.function('relight.debug', () => relighter.debugState());
    events.on('relight.setSettings', (partial: Partial<RelightSettings>) => relighter.setSettings(partial));

    events.function('docSerialize.lighting', () => ({ ...relighter.settings }));
    events.on('docDeserialize.lighting', (doc: Partial<RelightSettings> | undefined) => {
        relighter.setSettings({ ...defaultRelightSettings(), ...(doc ?? {}) });
    });

    return relighter;
};

export { registerRelighting, Relighter, defaultRelightSettings, type RelightSettings };
