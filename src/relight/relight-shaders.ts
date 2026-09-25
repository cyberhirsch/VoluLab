/**
 * The compute kernels behind relighting. See `relighter.ts` for how they
 * are scheduled and task.md for why the design is a density grid rather
 * than shadow maps.
 *
 * Every kernel is WGSL with explicit `@group(0) @binding(n)` declarations,
 * matching a BindGroupFormat built in the same order on the JS side - the
 * way the engine's own radix sort and prefix sum are written. The engine's
 * shorthand declarations are avoided on purpose: they reflect every storage
 * texture as 2D, and they bind 32-bit float textures as filterable, which
 * the transform palette is not on every adapter.
 *
 * Units, once, because every kernel shares them. The grid stores extinction
 * as optical depth across one finest cell - "kappa". A ray that travels a
 * distance d through a cell holding kappa gains kappa * d / h0 of optical
 * depth, whatever level it sampled, which is what lets the cone tracer
 * switch levels mid-ray without rescaling anything.
 */

// accumulation is fixed point: WebGPU has atomics on u32 and nothing else
const FIXED_POINT = 4096;

// the finest level a deposit may use is the one where the gaussian's
// footprint spans at most this many cells; beyond it, a coarser level
const MAX_FOOTPRINT = 24;

// samples per gaussian at most - a well sampled footprint, not a mesh
const MAX_SAMPLES = 32;

// workgroup size for every kernel here
const WORKGROUP = 64;

/**
 * A fixed set of standard-normal offsets, used to spread a large gaussian's
 * extinction across the cells it covers. Entry 0 is the centre, so a small
 * gaussian - the common case - deposits exactly where it is. After that the
 * points come in antithetic pairs, so any prefix of the list is close to
 * balanced around the centre. Halton rather than random so the set is the
 * same on every run and every machine.
 */
const gaussianSamples = (count: number) => {
    const halton = (index: number, base: number) => {
        let f = 1;
        let r = 0;
        let i = index;
        while (i > 0) {
            f /= base;
            r += f * (i % base);
            i = Math.floor(i / base);
        }
        return r;
    };

    const out: number[][] = [[0, 0, 0]];
    for (let i = 1; out.length < count; ++i) {
        // Box-Muller on two Halton pairs, radii clamped so no sample lands
        // absurdly far out in the tail
        const u1 = Math.max(1e-6, halton(i, 2));
        const u2 = halton(i, 3);
        const u3 = Math.max(1e-6, halton(i, 5));
        const u4 = halton(i, 7);
        const r1 = Math.min(3, Math.sqrt(-2 * Math.log(u1)));
        const r2 = Math.min(3, Math.sqrt(-2 * Math.log(u3)));
        const x = r1 * Math.cos(2 * Math.PI * u2);
        const y = r1 * Math.sin(2 * Math.PI * u2);
        const z = r2 * Math.cos(2 * Math.PI * u4);
        out.push([x, y, z]);
        if (out.length < count) {
            out.push([-x, -y, -z]);
        }
    }
    return out;
};

const samplesWGSL = gaussianSamples(MAX_SAMPLES)
.map(([x, y, z]) => `vec3f(${x.toFixed(6)}, ${y.toFixed(6)}, ${z.toFixed(6)})`)
.join(',\n    ');

// shared by the kernels that walk gaussians
const gaussianCommon = /* wgsl */`
const WORKGROUP: u32 = ${WORKGROUP}u;

// q = (x, y, z, w)
fn quatToMat3(q: vec4f) -> mat3x3f {
    let x = q.x;
    let y = q.y;
    let z = q.z;
    let w = q.w;
    return mat3x3f(
        vec3f(1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z), 2.0 * (x * z - w * y)),
        vec3f(2.0 * (x * y - w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x)),
        vec3f(2.0 * (x * z + w * y), 2.0 * (y * z - w * x), 1.0 - 2.0 * (x * x + y * y))
    );
}

// The same world matrix the splat vertex shader builds: the object's model
// matrix, then whatever the transform palette holds for this gaussian.
// Kept in step with applyPaletteTransform in splat-shader.ts.
fn splatWorld(uv: vec2i) -> mat4x4f {
    let index = textureLoad(splatTransform, uv, 0).r;
    if (index == 0u) {
        return uniforms.matrixModel;
    }
    let u = i32(index % 512u) * 3;
    let v = i32(index / 512u);
    let t = mat4x4f(
        textureLoad(transformPalette, vec2i(u, v), 0),
        textureLoad(transformPalette, vec2i(u + 1, v), 0),
        textureLoad(transformPalette, vec2i(u + 2, v), 0),
        vec4f(0.0, 0.0, 0.0, 1.0)
    );
    return uniforms.matrixModel * transpose(t);
}

fn splatIndex(wid: vec3u, nwg: vec3u, lid: u32) -> u32 {
    return (wid.y * nwg.x + wid.x) * WORKGROUP + lid;
}

fn splatUV(i: u32) -> vec2i {
    return vec2i(i32(i % uniforms.counts.y), i32(i / uniforms.counts.y));
}

fn splatStateBits(uv: vec2i) -> u32 {
    return u32(textureLoad(splatState, uv, 0).r * 255.0 + 0.5);
}

fn isDeleted(uv: vec2i) -> bool {
    return (splatStateBits(uv) & 4u) != 0u;
}

// deleted, or hidden - which this app records as locked, and draws as all
// but invisible. Neither should cast a shadow.
fn isGone(uv: vec2i) -> bool {
    return (splatStateBits(uv) & 6u) != 0u;
}
`;

/**
 * Deposit: every drawn gaussian adds its extinction to the grid.
 *
 * A gaussian's extinction "mass" is its optical depth times its footprint:
 * tau * 2pi * sMid * sMax. That is the quantity that makes a wall of
 * gaussians opaque in proportion to how completely they cover it, whatever
 * the cell size - a ray crossing a covered wall gains about tau however the
 * mass was spread.
 *
 * The spread is by sampling: up to MAX_SAMPLES standard-normal points pushed
 * through the gaussian's own axes, each deposited trilinearly. A gaussian
 * too large to sample well at the finest level deposits into a coarser one
 * instead, where the same samples cover it; the push-down kernel hands that
 * back to the finer levels afterwards. Without that, a sky-sized gaussian
 * would land as a few dense clumps and cast black spots.
 */
const depositSource = /* wgsl */`
@group(0) @binding(0) var<storage, read> gaussians: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> accum: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read> levels: array<vec4u>;
@group(0) @binding(3) var splatState: texture_2d<f32>;
@group(0) @binding(4) var splatTransform: texture_2d<u32>;
@group(0) @binding(5) var transformPalette: texture_2d<f32>;

struct Uniforms {
    matrixModel: mat4x4f,
    gridOrigin: vec4f,      // xyz: grid min corner, w: finest cell size
    gridDims: vec4u,        // xyz: finest dims, w: level count
    counts: vec4u           // x: gaussians, y: texture width
};
@group(0) @binding(6) var<uniform> uniforms: Uniforms;

${gaussianCommon}

const FIXED: f32 = ${FIXED_POINT}.0;
const MAX_SAMPLES: u32 = ${MAX_SAMPLES}u;
const MAX_FOOTPRINT: f32 = ${MAX_FOOTPRINT}.0;

var<private> SAMPLES: array<vec3f, ${MAX_SAMPLES}> = array<vec3f, ${MAX_SAMPLES}>(
    ${samplesWGSL}
);

fn hash(v: u32) -> u32 {
    let s = v * 747796405u + 2891336453u;
    let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
}

// Stochastic rounding: a fraction of a fixed-point unit is added with that
// probability, so the countless faint gaussians in a capture still add up
// on average instead of each rounding to nothing. Seeded by gaussian and
// sample, so a rebuild of an unchanged scene gives the same grid.
fn deposit(level: u32, p: vec3f, amount: f32, seed: u32) {
    let info = levels[level];
    let hl = uniforms.gridOrigin.w * f32(1u << level);
    let g = (p - uniforms.gridOrigin.xyz) / hl - vec3f(0.5);
    let b = floor(g);
    let f = g - b;
    let bi = vec3i(b);
    let dims = vec3i(info.xyz);
    for (var c = 0u; c < 8u; c++) {
        let o = vec3i(i32(c & 1u), i32((c >> 1u) & 1u), i32((c >> 2u) & 1u));
        let cell = bi + o;
        if (any(cell < vec3i(0)) || any(cell >= dims)) {
            continue;
        }
        let wv = select(vec3f(1.0) - f, f, o == vec3i(1));
        let v = amount * wv.x * wv.y * wv.z * FIXED;
        if (v <= 0.0) {
            continue;
        }
        let r = f32(hash(seed * 8u + c)) * (1.0 / 4294967296.0);
        let add = u32(min(floor(v + r), 16777216.0));
        if (add == 0u) {
            continue;
        }
        let cellIndex = info.w + u32((cell.z * dims.y + cell.y) * dims.x + cell.x);
        atomicAdd(&accum[cellIndex], add);
    }
}

@compute @workgroup_size(WORKGROUP)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
    let i = splatIndex(wid, nwg, lid);
    if (i >= uniforms.counts.x) {
        return;
    }

    let uv = splatUV(i);
    if (isGone(uv)) {
        return;
    }

    let g0 = gaussians[i * 3u];
    let tau = g0.w;
    if (tau <= 0.0) {
        return;
    }
    let g1 = gaussians[i * 3u + 1u];
    let g2 = gaussians[i * 3u + 2u];

    let world = splatWorld(uv);
    let m3 = mat3x3f(world[0].xyz, world[1].xyz, world[2].xyz);
    let rot = quatToMat3(g1);

    // the gaussian's three axes in world space, each one sigma long
    let a0 = m3 * (rot[0] * g2.x);
    let a1 = m3 * (rot[1] * g2.y);
    let a2 = m3 * (rot[2] * g2.z);
    let l0 = length(a0);
    let l1 = length(a1);
    let l2 = length(a2);
    let lMax = max(l0, max(l1, l2));
    let lMin = min(l0, min(l1, l2));
    let lMid = l0 + l1 + l2 - lMax - lMin;

    let mass = tau * 6.2831853 * lMid * lMax;
    let centre = (world * vec4f(g0.xyz, 1.0)).xyz;

    let h0 = uniforms.gridOrigin.w;
    let levelCount = uniforms.gridDims.w;
    var level = 0u;
    var hl = h0;
    var footprint = max(1.0, 3.0 * lMid / hl) * max(1.0, 3.0 * lMax / hl);
    loop {
        if (footprint <= MAX_FOOTPRINT || level + 1u >= levelCount) {
            break;
        }
        level += 1u;
        hl *= 2.0;
        footprint = max(1.0, 3.0 * lMid / hl) * max(1.0, 3.0 * lMax / hl);
    }

    let k = u32(clamp(ceil(footprint), 1.0, f32(MAX_SAMPLES)));

    // mass spread over k samples, as density in finest-cell units: a sample
    // landing whole in one level-l cell raises that cell's kappa by this
    let amount = mass / f32(k) * h0 / (hl * hl * hl);

    for (var j = 0u; j < k; j++) {
        let z = SAMPLES[j];
        deposit(level, centre + a0 * z.x + a1 * z.y + a2 * z.z, amount, i * MAX_SAMPLES + j);
    }
}
`;

/** Fixed point back to kappa, every level at once. */
const resolveSource = /* wgsl */`
@group(0) @binding(0) var<storage, read> accum: array<u32>;
@group(0) @binding(1) var<storage, read_write> density: array<f32>;

struct Uniforms {
    counts: vec4u           // x: cells across all levels
};
@group(0) @binding(2) var<uniform> uniforms: Uniforms;

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
    let i = (wid.y * nwg.x + wid.x) * ${WORKGROUP}u + lid;
    if (i >= uniforms.counts.x) {
        return;
    }
    density[i] = f32(accum[i]) * (1.0 / ${FIXED_POINT}.0);
}
`;

/**
 * Pull-up: a coarse cell gains the mean of its eight children. Run once per
 * level, finest first, so each level averages children that are already
 * complete. The children's own direct deposits are in them; the coarse
 * cell's direct deposit was put there by the resolve.
 */
const pullSource = /* wgsl */`
@group(0) @binding(0) var<storage, read_write> density: array<f32>;
@group(0) @binding(1) var<storage, read> levels: array<vec4u>;

struct Uniforms {
    counts: vec4u           // x: the level being built
};
@group(0) @binding(2) var<uniform> uniforms: Uniforms;

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
    let i = (wid.y * nwg.x + wid.x) * ${WORKGROUP}u + lid;
    let level = uniforms.counts.x;
    let info = levels[level];
    let child = levels[level - 1u];
    let plane = info.x * info.y;
    if (i >= plane * info.z) {
        return;
    }
    let c = vec3u(i % info.x, (i % plane) / info.x, i / plane);
    var sum = 0.0;
    for (var k = 0u; k < 8u; k++) {
        let q = c * 2u + vec3u(k & 1u, (k >> 1u) & 1u, (k >> 2u) & 1u);
        if (all(q < child.xyz)) {
            sum += density[child.w + (q.z * child.y + q.y) * child.x + q.x];
        }
    }
    density[info.w + i] += sum * 0.125;
}
`;

/**
 * Push-down: what was deposited directly into a coarse cell was meant to be
 * spread evenly through it, so every finer cell inside gains it. Reads only
 * the fixed-point deposits, never the pulled-up densities, so running after
 * all the pulls cannot count anything twice.
 */
const pushSource = /* wgsl */`
@group(0) @binding(0) var<storage, read> accum: array<u32>;
@group(0) @binding(1) var<storage, read_write> density: array<f32>;
@group(0) @binding(2) var<storage, read> levels: array<vec4u>;

struct Uniforms {
    counts: vec4u           // x: cells in every level but the coarsest, y: level count
};
@group(0) @binding(3) var<uniform> uniforms: Uniforms;

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
    let i = (wid.y * nwg.x + wid.x) * ${WORKGROUP}u + lid;
    if (i >= uniforms.counts.x) {
        return;
    }
    let levelCount = uniforms.counts.y;

    // which level this flat index falls in
    var level = 0u;
    for (var l = 1u; l < levelCount; l++) {
        if (i >= levels[l].w) {
            level = l;
        }
    }
    let info = levels[level];
    let localIndex = i - info.w;
    let plane = info.x * info.y;
    let c = vec3u(localIndex % info.x, (localIndex % plane) / info.x, localIndex / plane);

    var add = 0u;
    for (var m = level + 1u; m < levelCount; m++) {
        let a = levels[m];
        let q = c >> vec3u(m - level);
        add += accum[a.w + (q.z * a.y + q.y) * a.x + q.x];
    }
    if (add > 0u) {
        density[i] += f32(add) * (1.0 / ${FIXED_POINT}.0);
    }
}
`;

/**
 * Lighting: each gaussian, lit once, from both sides of its flat axis.
 *
 * A captured gaussian has no outside. Its flat axis gives a normal up to
 * sign, and the density around a single-layer wall is the same on both
 * sides, so no amount of looking at the grid says which side the camera
 * was on. So both sides are lit and stored - "plus" along the axis, "minus"
 * against it - and the splat shader picks the one facing the viewer. A wall
 * seen from the room gets the room side's light; the sun behind that wall
 * lands on the side nobody captured.
 *
 * Per light, only the side facing it is traced: its shadow ray starts just
 * off that side and walks the grid toward the light as a cone as wide as
 * the light looks from here. Round gaussians - fog, fuzz - have no useful
 * axis, and are lit the same from every side.
 *
 * Light records are four vec4s:
 *   0: xyz position, or the direction toward a sun; w kind (0 point, 1 spot, 2 sun)
 *   1: rgb colour times intensity; w emitter radius, or the sun's tan(half angle)
 *   2: xyz spot axis; w cos(outer half angle)
 *   3: x cos(inner half angle); y falloff reference distance squared
 */
const lightingSource = /* wgsl */`
@group(0) @binding(0) var<storage, read> gaussians: array<vec4f>;
@group(0) @binding(1) var<storage, read> density: array<f32>;
@group(0) @binding(2) var<storage, read> levels: array<vec4u>;
@group(0) @binding(3) var<storage, read> lights: array<vec4f>;
@group(0) @binding(4) var splatState: texture_2d<f32>;
@group(0) @binding(5) var splatTransform: texture_2d<u32>;
@group(0) @binding(6) var transformPalette: texture_2d<f32>;
@group(0) @binding(7) var lightPlus: texture_storage_2d<rgba16float, write>;
@group(0) @binding(8) var lightMinus: texture_storage_2d<rgba16float, write>;

struct Uniforms {
    matrixModel: mat4x4f,
    gridOrigin: vec4f,      // xyz: grid min corner, w: finest cell size
    gridDims: vec4u,        // xyz: finest dims, w: level count
    counts: vec4u,          // x: gaussians, y: texture width, z: lights
    params: vec4f           // x: captured light, y: wrap, z: ray offset in cells
};
@group(0) @binding(9) var<uniform> uniforms: Uniforms;

${gaussianCommon}

fn fetch(info: vec4u, c: vec3i) -> f32 {
    if (any(c < vec3i(0)) || any(c >= vec3i(info.xyz))) {
        return 0.0;
    }
    return density[info.w + u32((c.z * i32(info.y) + c.y) * i32(info.x) + c.x)];
}

fn sampleLevel(pos: vec3f, level: u32) -> f32 {
    let info = levels[level];
    let hl = uniforms.gridOrigin.w * f32(1u << level);
    let g = (pos - uniforms.gridOrigin.xyz) / hl - vec3f(0.5);
    let b = floor(g);
    let f = g - b;
    let c = vec3i(b);
    let x00 = mix(fetch(info, c), fetch(info, c + vec3i(1, 0, 0)), f.x);
    let x10 = mix(fetch(info, c + vec3i(0, 1, 0)), fetch(info, c + vec3i(1, 1, 0)), f.x);
    let x01 = mix(fetch(info, c + vec3i(0, 0, 1)), fetch(info, c + vec3i(1, 0, 1)), f.x);
    let x11 = mix(fetch(info, c + vec3i(0, 1, 1)), fetch(info, c + vec3i(1, 1, 1)), f.x);
    return mix(mix(x00, x10, f.y), mix(x01, x11, f.y), f.z);
}

fn sampleLod(pos: vec3f, lod: f32) -> f32 {
    let l0 = u32(lod);
    let fr = lod - f32(l0);
    let a = sampleLevel(pos, l0);
    if (fr < 0.05 || l0 + 1u >= uniforms.gridDims.w) {
        return a;
    }
    return mix(a, sampleLevel(pos, l0 + 1u), fr);
}

// Transmittance along a cone. The cone's width picks the level, so a soft
// light reads coarse cells and a hard one reads fine ones. Where a coarse
// level reads empty, a whole stretch is known to be empty and is skipped:
// a coarse cell is the mean of its non-negative children, so zero there is
// zero all the way down.
fn coneTrace(origin: vec3f, dir: vec3f, tanHalf: f32, maxDist: f32) -> f32 {
    let h0 = uniforms.gridOrigin.w;
    let boxMin = uniforms.gridOrigin.xyz;
    let boxMax = boxMin + vec3f(uniforms.gridDims.xyz) * h0;

    // clip the ray to the grid; outside it there is nothing to hit
    let safe = select(dir, vec3f(1e-8), abs(dir) < vec3f(1e-8));
    let inv = 1.0 / safe;
    let t0 = (boxMin - origin) * inv;
    let t1 = (boxMax - origin) * inv;
    let tEnter = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), min(t0.z, t1.z));
    let tExit = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), max(t0.z, t1.z));

    var t = max(0.5 * h0, tEnter);
    let tEnd = min(maxDist, tExit);

    let levelCount = uniforms.gridDims.w;
    let skipLevel = min(3u, levelCount - 1u);
    let skipStep = (0.5 * f32(1u << skipLevel) - 0.5) * h0;

    var tau = 0.0;
    var empty = true;
    for (var it = 0u; it < 384u; it++) {
        if (t >= tEnd) {
            break;
        }
        let pos = origin + dir * t;
        let diam = max(h0, 2.0 * t * tanHalf);
        let lod = min(log2(diam / h0), f32(levelCount - 1u));

        if (empty && skipLevel > 0u && lod < f32(skipLevel)) {
            if (sampleLevel(pos, skipLevel) <= 0.0) {
                t += max(skipStep, 0.5 * h0);
                continue;
            }
        }

        let kappa = sampleLod(pos, lod);
        empty = kappa <= 0.0;
        let stepLen = max(0.5 * h0, 0.5 * diam);
        tau += kappa * stepLen / h0;
        if (tau > 7.0) {
            break;
        }
        t += stepLen;
    }
    return exp(-tau);
}

// The axis the splat shader also picks, with the same tie-break, so both
// agree which side is "plus".
fn flatAxis(s: vec3f) -> u32 {
    if (s.x < s.y) {
        return select(2u, 0u, s.x < s.z);
    }
    return select(2u, 1u, s.y < s.z);
}

@compute @workgroup_size(WORKGROUP)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
    let i = splatIndex(wid, nwg, lid);
    if (i >= uniforms.counts.x) {
        return;
    }

    let uv = splatUV(i);
    let base = vec3f(uniforms.params.x);

    // deleted gaussians are never drawn; they get the neutral value so an
    // undo shows them captured-lit until the next relight
    if (isDeleted(uv)) {
        textureStore(lightPlus, uv, vec4f(base, 1.0));
        textureStore(lightMinus, uv, vec4f(base, 1.0));
        return;
    }

    let g0 = gaussians[i * 3u];
    let g1 = gaussians[i * 3u + 1u];
    let g2 = gaussians[i * 3u + 2u];

    let world = splatWorld(uv);
    let m3 = mat3x3f(world[0].xyz, world[1].xyz, world[2].xyz);
    let p = (world * vec4f(g0.xyz, 1.0)).xyz;

    // the flat axis in world space. Normals take the inverse transpose; the
    // cofactor matrix is that times the determinant, whose sign is put back
    // so "plus" survives a mirroring transform
    let s = g2.xyz;
    // through a variable: WGSL only indexes a matrix at runtime in memory
    var rot = quatToMat3(g1);
    let axis = rot[flatAxis(s)];
    let cof = mat3x3f(cross(m3[1], m3[2]), cross(m3[2], m3[0]), cross(m3[0], m3[1]));
    let det = dot(m3[0], cross(m3[1], m3[2]));
    let n = normalize(cof * axis) * select(-1.0, 1.0, det >= 0.0);

    // 1 for a flat gaussian with a meaningful axis, 0 for a round one
    let sMax = max(s.x, max(s.y, s.z));
    let sMin = min(s.x, min(s.y, s.z));
    let sMid = s.x + s.y + s.z - sMax - sMin;
    let flatness = 1.0 - smoothstep(0.2, 0.6, sMin / max(sMid, 1e-12));

    let h0 = uniforms.gridOrigin.w;
    let wrap = uniforms.params.y;
    let offset = uniforms.params.z * h0;

    var plus = vec3f(0.0);
    var minus = vec3f(0.0);

    for (var li = 0u; li < uniforms.counts.z; li++) {
        let la = lights[li * 4u];
        let lb = lights[li * 4u + 1u];
        let lc = lights[li * 4u + 2u];
        let ld = lights[li * 4u + 3u];
        let kind = u32(la.w + 0.5);

        var toLight: vec3f;
        var falloff = 1.0;
        var tanHalf: f32;
        var maxDist: f32;

        if (kind == 2u) {
            toLight = la.xyz;
            tanHalf = lb.w;
            maxDist = 3.0e38;
        } else {
            let d = la.xyz - p;
            let dist = max(length(d), 1e-6);
            toLight = d / dist;
            let radius = lb.w;
            falloff = ld.y / max(dist * dist, max(radius * radius, 1e-12));
            tanHalf = radius / dist;
            maxDist = dist - radius;
            if (kind == 1u) {
                falloff *= smoothstep(lc.w, ld.x, dot(-toLight, lc.xyz));
            }
        }

        let energy = lb.rgb * falloff;
        if (max(energy.r, max(energy.g, energy.b)) <= 1e-5) {
            continue;
        }

        let ndl = dot(n, toLight);
        let side = select(-1.0, 1.0, ndl >= 0.0);
        let facing = abs(ndl);

        // wrapped Lambert on the lit side; the wrap's tail on the far side
        let near = (facing + wrap) / (1.0 + wrap);
        let far = max(0.0, wrap - facing) / (1.0 + wrap);

        // leave from just off the lit side - along the axis for a flat
        // gaussian, toward the light for a round one
        let away = normalize(mix(toLight, n * side, flatness));
        let visibility = coneTrace(p + away * offset, toLight, tanHalf, maxDist);

        let lit = energy * visibility;
        let litNear = lit * mix(0.5, near, flatness);
        let litFar = lit * mix(0.5, far, flatness);
        if (side > 0.0) {
            plus += litNear;
            minus += litFar;
        } else {
            minus += litNear;
            plus += litFar;
        }
    }

    textureStore(lightPlus, uv, vec4f(base + plus, 1.0));
    textureStore(lightMinus, uv, vec4f(base + minus, 1.0));
}
`;

export {
    FIXED_POINT,
    WORKGROUP,
    depositSource,
    resolveSource,
    pullSource,
    pushSource,
    lightingSource
};
