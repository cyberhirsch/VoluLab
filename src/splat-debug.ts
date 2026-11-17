import type { Splat } from './splat';

/**
 * The debug view: an object's gaussians drawn false-coloured by one channel
 * of their data instead of by their colour.
 *
 * Most channels cost nothing to switch between. The motion textures a 4D
 * model already plays from hold velocity, temporal centre and falloff, and
 * the splat's own data holds opacity, so those are worked out in the vertex
 * shader, with a uniform naming the channel. What only the CPU knows -
 * hierarchy level, the static set, scale ratios, SH energy - goes up as one
 * byte per gaussian, already normalised, when a node asks for it.
 *
 * The colours are defined here once. The shader chunks are generated from
 * them and the node's legend is drawn from them, so the two cannot drift.
 */

type DebugChannel =
    'velocity' | 'speed' | 'time' | 'lifetime' | 'level' | 'static' | 'falloff' |
    'opacity' | 'size' | 'anisotropy' | 'shEnergy';

/** What a debug view node holds. */
type DebugView = {
    channel: DebugChannel;
};

type DebugLegend =
    // a ramp between two values; `log` when the ramp is in the value's logarithm
    { kind: 'ramp' | 'heat', min: number, max: number, log: boolean } |
    // xyz as rgb around grey; `max` is the speed that saturates a channel
    { kind: 'direction', max: number } |
    // one colour per entry; `label` is a locale key, `value` what it is counted by
    { kind: 'categories', entries: { color: number[], label: string, value?: number }[] };

/** A channel worked out for one object: what the shader needs, and the legend. */
type DebugResolved = {
    channel: DebugChannel;
    mode: number;
    // x: where the ramp starts, y: 1 / its length (or 1 / max speed)
    params: [number, number];
    // one byte per gaussian for the channels the GPU cannot work out, or null
    values: Uint8Array | null;
    legend: DebugLegend;
};

// the modes the vertex shader knows (see debugVS in shaders/splat-shader.ts)
const MODE_VELOCITY = 1;
const MODE_SPEED = 2;
const MODE_TIME = 3;
const MODE_LIFETIME = 4;
const MODE_FALLOFF = 5;
const MODE_OPACITY = 6;
const MODE_TEX_RAMP = 7;
const MODE_TEX_HEAT = 8;
const MODE_TEX_CATEGORY = 9;

const hex = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);

// five stops each, evenly spaced, interpolated in sRGB by the shader and by
// the legend's CSS gradient alike
const DEBUG_RAMPS = {
    // viridis: dark to light, for values with an order and no alarm to them
    ramp: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'].map(hex),
    // turbo, thinned: a heat map, for values where the top end is the news
    heat: ['#30123b', '#28bbec', '#a2fc3c', '#fb8022', '#7a0403'].map(hex)
};

// categories: 0 is the neutral one (the global set), the rest tell levels apart
const DEBUG_CATEGORIES = [
    '#8c8c8c', '#3987e5', '#f28e2b', '#59a14f', '#e15759', '#b07aa1', '#edc948', '#76b7b2'
].map(hex);

// a lifetime this many sequences long reads the same as any longer one
const LIFETIME_CAP = 10;

const CHANNELS: { id: DebugChannel, motion: boolean }[] = [
    { id: 'velocity', motion: true },
    { id: 'speed', motion: true },
    { id: 'time', motion: true },
    { id: 'lifetime', motion: true },
    { id: 'falloff', motion: true },
    { id: 'level', motion: true },
    { id: 'static', motion: true },
    { id: 'opacity', motion: false },
    { id: 'size', motion: false },
    { id: 'anisotropy', motion: false },
    { id: 'shEnergy', motion: false }
];

const prop = (splat: Splat, name: string) => splat.splatData.getProp(name) as Float32Array | undefined;

/** Whether this object has the data a channel is read from. */
const debugChannelAvailable = (splat: Splat, channel: DebugChannel): boolean => {
    const entry = CHANNELS.find(c => c.id === channel);
    if (!entry) return false;
    if (entry.motion) {
        if (!splat.motion) return false;
        return (channel !== 'level' && channel !== 'static') || !!splat.motion.hierarchy;
    }
    switch (channel) {
        case 'opacity': return true;
        case 'size':
        case 'anisotropy': return !!(prop(splat, 'scale_0') && prop(splat, 'scale_1') && prop(splat, 'scale_2'));
        case 'shEnergy': return !!(prop(splat, 'f_rest_0') && prop(splat, 'f_dc_0') && prop(splat, 'f_dc_1') && prop(splat, 'f_dc_2'));
        default: return false;
    }
};

/** The channel a new node starts on: motion first, where there is any. */
const defaultDebugChannel = (splat: Splat): DebugChannel => (splat.motion ? 'speed' : 'opacity');

// The range a ramp covers: the values with half a percent trimmed off each
// end, from a sample. A handful of floaters would otherwise set the range
// for everyone else and leave the rest of the object one colour.
const trimmedRange = (count: number, value: (i: number) => number): [number, number] => {
    const step = Math.max(1, Math.floor(count / 65536));
    const sample: number[] = [];
    for (let i = 0; i < count; i += step) {
        const v = value(i);
        if (Number.isFinite(v)) sample.push(v);
    }
    if (!sample.length) return [0, 1];
    const sorted = Float64Array.from(sample).sort();
    const cut = Math.floor(sorted.length * 0.005);
    return [sorted[cut], sorted[sorted.length - 1 - cut]];
};

// a ramp's start and 1 / length, with a range of nothing given some length
const rampParams = (lo: number, hi: number): [number, number] => [lo, 1 / Math.max(hi - lo, 1e-6)];

const toBytes = (count: number, lo: number, hi: number, value: (i: number) => number) => {
    const [start, scale] = rampParams(lo, hi);
    const out = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
        const v = (value(i) - start) * scale;
        // NaN compares false both ways and lands on 0
        out[i] = v > 0 ? (v < 1 ? Math.round(v * 255) : 255) : 0;
    }
    return out;
};

// SH band 0's basis constant: a DC coefficient c shows as 0.5 + SH_C0 * c
const SH_C0 = 0.28209479177387814;

/**
 * Work a channel out for an object: the mode and range the shader is given,
 * the per-gaussian bytes where it needs them, and the legend. Null when the
 * object does not have the channel. One pass over the data at most - call
 * it when the data or the channel changes, not per frame.
 */
const resolveDebugView = (splat: Splat, channel: DebugChannel): DebugResolved | null => {
    if (!debugChannelAvailable(splat, channel)) return null;

    const count = splat.splatData.numSplats;
    const motion = splat.motion;
    const vt = motion?.velocityTime;
    const speed = (i: number) => Math.hypot(vt[i * 4], vt[i * 4 + 1], vt[i * 4 + 2]);

    switch (channel) {
        case 'velocity': {
            const max = Math.max(trimmedRange(count, speed)[1], 1e-9);
            return { channel, mode: MODE_VELOCITY, params: [1 / max, 0], values: null, legend: { kind: 'direction', max } };
        }
        case 'speed': {
            // what stands still has no logarithm; it takes the ramp's low end
            const [lo, hi] = trimmedRange(count, (i) => {
                const s = speed(i);
                return s > 0 ? Math.log(s) : NaN;
            });
            return {
                channel,
                mode: MODE_SPEED,
                params: rampParams(lo, hi),
                values: null,
                legend: { kind: 'heat', min: Math.exp(lo), max: Math.exp(hi), log: true }
            };
        }
        case 'time':
            return { channel, mode: MODE_TIME, params: [0, 1], values: null, legend: { kind: 'ramp', min: 0, max: 1, log: false } };
        case 'lifetime': {
            // falloff is 1 / (2 sigma_t^2), so ln sigma_t = 0.5 ln(0.5 / falloff)
            const falloff = motion.falloff;
            const range = trimmedRange(count, i => 0.5 * Math.log(0.5 / Math.max(falloff[i], 1e-30)));
            const hi = Math.min(range[1], Math.log(LIFETIME_CAP));
            const lo = Math.min(range[0], hi - 1e-3);
            return {
                channel,
                mode: MODE_LIFETIME,
                params: rampParams(lo, hi),
                values: null,
                legend: { kind: 'ramp', min: Math.exp(lo), max: Math.exp(hi), log: true }
            };
        }
        case 'falloff':
            return { channel, mode: MODE_FALLOFF, params: [0, 1], values: null, legend: { kind: 'ramp', min: 0, max: 1, log: false } };
        case 'level': {
            const { level } = motion.hierarchy();
            const values = new Uint8Array(count);
            const counts = new Map<number, number>();
            const wrap = DEBUG_CATEGORIES.length - 1;
            for (let i = 0; i < count; i++) {
                const l = level[i];
                // the global set (-1) is category 0; levels cycle through the rest
                values[i] = l < 0 ? 0 : 1 + (l % wrap);
                counts.set(l, (counts.get(l) ?? 0) + 1);
            }
            const entries = [...counts.keys()].sort((a, b) => a - b).map(l => ({
                color: DEBUG_CATEGORIES[l < 0 ? 0 : 1 + (l % wrap)],
                label: l < 0 ? 'debug.level-global' : 'debug.level-n',
                value: l < 0 ? undefined : l
            }));
            return { channel, mode: MODE_TEX_CATEGORY, params: [0, 1], values, legend: { kind: 'categories', entries } };
        }
        case 'static': {
            const { still } = motion.hierarchy();
            const values = new Uint8Array(count);
            for (let i = 0; i < count; i++) {
                values[i] = still[i] ? 1 : 2;
            }
            return {
                channel,
                mode: MODE_TEX_CATEGORY,
                params: [0, 1],
                values,
                legend: {
                    kind: 'categories',
                    entries: [
                        { color: DEBUG_CATEGORIES[1], label: 'debug.static' },
                        { color: DEBUG_CATEGORIES[2], label: 'debug.dynamic' }
                    ]
                }
            };
        }
        case 'opacity':
            return { channel, mode: MODE_OPACITY, params: [0, 1], values: null, legend: { kind: 'ramp', min: 0, max: 1, log: false } };
        case 'size': {
            // the scales are stored as logarithms already
            const s0 = prop(splat, 'scale_0'), s1 = prop(splat, 'scale_1'), s2 = prop(splat, 'scale_2');
            const largest = (i: number) => Math.max(s0[i], s1[i], s2[i]);
            const [lo, hi] = trimmedRange(count, largest);
            return {
                channel,
                mode: MODE_TEX_RAMP,
                params: [0, 1],
                values: toBytes(count, lo, hi, largest),
                legend: { kind: 'ramp', min: Math.exp(lo), max: Math.exp(hi), log: true }
            };
        }
        case 'anisotropy': {
            const s0 = prop(splat, 'scale_0'), s1 = prop(splat, 'scale_1'), s2 = prop(splat, 'scale_2');
            const ratio = (i: number) => Math.max(s0[i], s1[i], s2[i]) - Math.min(s0[i], s1[i], s2[i]);
            // from round (a ratio of 1) up, so the same colour means the same
            // shape at the low end whatever the object
            const hi = Math.max(trimmedRange(count, ratio)[1], 1e-3);
            return {
                channel,
                mode: MODE_TEX_HEAT,
                params: [0, 1],
                values: toBytes(count, 0, hi, ratio),
                legend: { kind: 'heat', min: 1, max: Math.exp(hi), log: true }
            };
        }
        case 'shEnergy': {
            const dc = [0, 1, 2].map(c => prop(splat, `f_dc_${c}`));
            const rest: Float32Array[] = [];
            for (let k = 0; ; k++) {
                const p = prop(splat, `f_rest_${k}`);
                if (!p) break;
                rest.push(p);
            }
            // the rest coefficients' energy against the colour the DC term
            // shows on its own: 0 is a gaussian that looks the same from
            // everywhere. Worked out once, then both ranged and packed
            const energy = new Float32Array(count);
            for (let i = 0; i < count; i++) {
                let sum = 0;
                for (let k = 0; k < rest.length; k++) {
                    sum += rest[k][i] * rest[k][i];
                }
                const r = 0.5 + SH_C0 * dc[0][i], g = 0.5 + SH_C0 * dc[1][i], b = 0.5 + SH_C0 * dc[2][i];
                energy[i] = SH_C0 * Math.sqrt(sum) / Math.max(Math.hypot(r, g, b), 0.05);
            }
            const hi = Math.max(trimmedRange(count, i => energy[i])[1], 1e-6);
            return {
                channel,
                mode: MODE_TEX_HEAT,
                params: [0, 1],
                values: toBytes(count, 0, hi, i => energy[i]),
                legend: { kind: 'heat', min: 0, max: hi, log: false }
            };
        }
        default:
            return null;
    }
};

// ---------------------------------------------------------------------------
// The shader's half: the ramps and categories above as GLSL and WGSL.
// ---------------------------------------------------------------------------

const f = (v: number) => v.toFixed(4);
const vec3Of = (c: number[], type: string) => `${type}(${f(c[0])}, ${f(c[1])}, ${f(c[2])})`;

const rampGlsl = (name: string, stops: number[][]) => `
vec3 ${name}(float v) {
    float x = clamp(v, 0.0, 1.0) * 4.0;
    vec3 c = mix(${vec3Of(stops[0], 'vec3')}, ${vec3Of(stops[1], 'vec3')}, clamp(x, 0.0, 1.0));
    c = mix(c, ${vec3Of(stops[2], 'vec3')}, clamp(x - 1.0, 0.0, 1.0));
    c = mix(c, ${vec3Of(stops[3], 'vec3')}, clamp(x - 2.0, 0.0, 1.0));
    return mix(c, ${vec3Of(stops[4], 'vec3')}, clamp(x - 3.0, 0.0, 1.0));
}
`;

const rampWgsl = (name: string, stops: number[][]) => `
fn ${name}(v: f32) -> vec3f {
    let x = clamp(v, 0.0, 1.0) * 4.0;
    var c = mix(${vec3Of(stops[0], 'vec3f')}, ${vec3Of(stops[1], 'vec3f')}, clamp(x, 0.0, 1.0));
    c = mix(c, ${vec3Of(stops[2], 'vec3f')}, clamp(x - 1.0, 0.0, 1.0));
    c = mix(c, ${vec3Of(stops[3], 'vec3f')}, clamp(x - 2.0, 0.0, 1.0));
    return mix(c, ${vec3Of(stops[4], 'vec3f')}, clamp(x - 3.0, 0.0, 1.0));
}
`;

const categoryLines = (type: string) => DEBUG_CATEGORIES.slice(1)
.map((c, i) => `    if (i == ${i + 1}) { return ${vec3Of(c, type)}; }`)
.join('\n');

/** debugRamp, debugHeat and debugCategory, for the vertex shader. */
const debugColorsGLSL = `
${rampGlsl('debugRamp', DEBUG_RAMPS.ramp)}
${rampGlsl('debugHeat', DEBUG_RAMPS.heat)}
vec3 debugCategory(int i) {
${categoryLines('vec3')}
    return ${vec3Of(DEBUG_CATEGORIES[0], 'vec3')};
}
`;

const debugColorsWGSL = `
${rampWgsl('debugRamp', DEBUG_RAMPS.ramp)}
${rampWgsl('debugHeat', DEBUG_RAMPS.heat)}
fn debugCategory(i: i32) -> vec3f {
${categoryLines('vec3f')}
    return ${vec3Of(DEBUG_CATEGORIES[0], 'vec3f')};
}
`;

const DEBUG_CHANNELS = CHANNELS.map(c => c.id);

export {
    DEBUG_CHANNELS,
    DEBUG_RAMPS,
    debugChannelAvailable,
    defaultDebugChannel,
    resolveDebugView,
    debugColorsGLSL,
    debugColorsWGSL,
    type DebugChannel,
    type DebugLegend,
    type DebugResolved,
    type DebugView
};
