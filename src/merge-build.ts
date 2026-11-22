/**
 * What a merge node (and a switch node) makes: one object out of several,
 * as one set of gaussians the renderer sorts and draws together.
 *
 * Several objects drawn one after the other are each sorted on their own,
 * so where they overlap in depth the one drawn last is in front of all of
 * the other - an actor walking through a set is either all in front of the
 * set or all behind it. One object, sorted as one, is right everywhere.
 *
 * Each input keeps where it stands: its gaussians are baked into the
 * merged object's space with the input's placement, its transform nodes,
 * its colour and its debug view, the way an export writes them
 * (SingleSplat). A 4D input keeps its motion, and its time: the merged
 * object has one clock, the timeline's, and each input's time nodes say
 * which time of the input each frame of the timeline shows. Where that
 * moves on linearly - no time node, a trim, a retime, a time offset - the
 * input's time is a linear function of the merged object's, which the
 * gaussians can carry: centres, velocities and fades are written for the
 * merged clock, and the hierarchy's segments, which are of the input's
 * clock, are told how the two clocks relate (MotionLayout scale and
 * offset). Where it does not - a loop, a ping-pong, a freeze frame, a
 * hold - the timeline is cut into the runs that are linear, and the input
 * comes in once per distinct run, drawn only in its run's windows. A held
 * or frozen run is a still: the gaussians at that time, without motion.
 *
 * An input outside its own sequence contributes nothing (a 3D input is
 * there all the time). Inputs at another frame rate are read by seconds:
 * frame f of the merged timeline is time f / rate, and the input's frame
 * at that time, between frames if it falls there - the model is
 * continuous in time, so nothing is resampled.
 *
 * The SH bands are made the same: padded with zeros to the most any input
 * has, or cut to the fewest.
 *
 * The still/moving split the sort worker and the compact GSV export use
 * carries over: a gaussian of an input's global set that is there for the
 * whole merged sequence stays global, and the worker finds again which of
 * those stand still. One that is there only part of the time is in a
 * level of its own with that window, and is sorted as moving.
 */

import { GSplatData, Quat, Vec3 } from 'playcanvas';

import { dcDecode, dcEncode, gradeMatrix, invSigmoid, sigmoid } from './color-grade';
import { toGrade } from './grade-palette';
import { layoutSegment, type MotionLayout } from './motion-sort';
import type { Splat, SplatMotion } from './splat';
import { debugColorSource } from './splat-debug';
import { SingleSplat, SplatTransformCache, gradeLookup, splatSHBands } from './splat-serialize';
import { State } from './splat-state';
import { resolveTime } from './time-map';

type ShMode = 'pad' | 'truncate';

/** Which inputs a frame of the merged sequence shows; all of them, for a merge. */
type InputPicker = (input: number, frame: number) => boolean;

type MergeBuildOptions = {
    sh: ShMode;
    /** the timeline's frame rate: a frame of the merged sequence is 1 / rate seconds */
    rate: number;
    /** the timeline's length, for inputs that do not say how long they are */
    timelineFrames: number;
    /** per input: whether it is in at all, and its opacity multiplier */
    include?: boolean[];
    opacity?: number[];
    /** a switch: which input each frame shows. Set, the result always has motion */
    pick?: InputPicker;
    /** frames the result spans at least (a switch's cuts may go further) */
    minFrames?: number;
};

type MergeBuilt = {
    data: GSplatData;
    motion: SplatMotion | null;
    /** frames of the merged sequence; 0 for a 3D result */
    frames: number;
    bands: number;
    /** per input, how many rows it came to (all its copies) */
    rows: number[];
    /** per input, how many times it came in (one per distinct run of time) */
    copies: number[];
};

const shNames = new Array(45).fill('').map((_, i) => `f_rest_${i}`);
const shBandCoeffs = [0, 3, 8, 15];

// The frame rate of an input's own frames: what its import said, or the
// timeline's.
const inputRate = (splat: Splat, rate: number) => {
    const fps = (splat as any).motionFps;
    return Number.isFinite(fps) && fps > 0 ? fps : rate;
};

/** How many frames of the merged sequence an input's own sequence covers; 0 for a 3D input. */
const inputSpan = (splat: Splat, rate: number, timelineFrames: number) => {
    if (!splat.motion) return 0;
    const frames = splat.motionFrames || timelineFrames;
    if (!(frames > 0)) return 0;
    return splat.timeSpan * rate / inputRate(splat, rate);
};

/**
 * The input's normalised time at a frame of the merged sequence, or null
 * when it is not there.
 */
const inputTime = (splat: Splat, f: number, rate: number, timelineFrames: number) => {
    const frames = splat.motionFrames || timelineFrames;
    const g = f * inputRate(splat, rate) / rate;
    if (g < -1e-6 || g > splat.timeSpan - 1 + 1e-6) return null;
    const at = resolveTime(splat.timeMaps, frames, Math.max(0, g));
    return at === null ? null : at / frames;
};

/**
 * A run of time an input comes in with: its time is scale * u + offset
 * (u the merged object's normalised time) within the windows; scale 0 is
 * a still, at `offset`.
 */
type Piece = { scale: number, offset: number, windows: number[] };

const close = (a: number, b: number) => Math.abs(a - b) <= 1e-7 * Math.max(1, Math.abs(a), Math.abs(b));

/**
 * Cut an input's times over the merged sequence (one per frame, null where
 * it is not there) into linear runs, and the runs into pieces: runs on the
 * same line share one, each run a window of it.
 */
const piecesOf = (times: (number | null)[], frames: number): Piece[] => {
    const runs: { f0: number, f1: number, slope: number | null }[] = [];
    let f = 0;
    while (f < frames) {
        if (times[f] === null) {
            f++;
            continue;
        }
        const f0 = f;
        let slope: number | null = null;
        if (f + 1 < frames && times[f + 1] !== null) {
            slope = times[f + 1] - times[f];
            f++;
            while (f + 1 < frames && times[f + 1] !== null && close(times[f + 1] - times[f], slope)) {
                f++;
            }
        }
        runs.push({ f0, f1: f, slope });
        f++;
    }

    const pieces: Piece[] = [];
    const window = (run: { f0: number, f1: number }) => [run.f0 / frames, (run.f1 + 1) / frames];
    const join = (scale: number, offset: number, run: { f0: number, f1: number }) => {
        const same = pieces.find(p => close(p.scale, scale) && close(p.offset, offset));
        if (same) {
            same.windows.push(...window(run));
        } else {
            pieces.push({ scale, offset, windows: window(run) });
        }
    };

    // the runs with a line first, then the single frames: one on the line
    // of a run joins it rather than coming in as a still of its own
    runs.filter(r => r.slope !== null).forEach((run) => {
        const scale = run.slope * frames;
        // a time that stands still is a still
        if (Math.abs(scale) < 1e-9) {
            join(0, times[run.f0], run);
        } else {
            join(scale, times[run.f0] - run.slope * run.f0, run);
        }
    });
    runs.filter(r => r.slope === null).forEach((run) => {
        const u = run.f0 / frames;
        const t = times[run.f0];
        const on = pieces.find(p => p.scale !== 0 && close(p.scale * u + p.offset, t));
        if (on) {
            on.windows.push(...window(run));
        } else {
            join(0, t, run);
        }
    });

    // windows in order, the touching ones joined
    pieces.forEach((p) => {
        const pairs: number[][] = [];
        for (let i = 0; i < p.windows.length; i += 2) pairs.push([p.windows[i], p.windows[i + 1]]);
        pairs.sort((a, b) => a[0] - b[0]);
        const out: number[] = [];
        pairs.forEach(([a, b]) => {
            if (out.length && a <= out[out.length - 1] + 1e-12) {
                out[out.length - 1] = Math.max(out[out.length - 1], b);
            } else {
                out.push(a, b);
            }
        });
        p.windows = out;
    });
    return pieces;
};

// a piece's windows cover the whole sequence: then it needs none
const whole = (windows: number[]) => windows.length === 2 && windows[0] <= 1e-12 && windows[1] >= 1 - 1e-12;

/**
 * The windows, of the merged object's time u, of a level whose windows are
 * `inner`, of an input's time scale * u + offset, within a piece's windows
 * `outer`: the inner ones mapped to u, and cut to the outer ones. Null:
 * always.
 */
const composeWindows = (outer: Float64Array | null, inner: Float64Array | null, scale: number, offset: number) => {
    if (!inner) return outer;
    const mapped: number[][] = [];
    for (let i = 0; i < inner.length; i += 2) {
        const a = (inner[i] - offset) / scale;
        const b = (inner[i + 1] - offset) / scale;
        mapped.push(a <= b ? [a, b] : [b, a]);
    }
    mapped.sort((p, q) => p[0] - q[0]);
    const bounds = outer ? Array.from({ length: outer.length / 2 }, (_, i) => [outer[i * 2], outer[i * 2 + 1]]) : [[-Infinity, Infinity]];
    const out: number[] = [];
    bounds.forEach(([a0, b0]) => mapped.forEach(([a1, b1]) => {
        const a = Math.max(a0, a1);
        const b = Math.min(b0, b1);
        if (a < b) out.push(a, b);
    }));
    return Float64Array.from(out);
};

/** The rows of an input's model active at its time t, from its layout; null: all. */
const activeRows = (motion: SplatMotion, t: number) => {
    if (motion.activeAt) return motion.activeAt(t);
    return null;
};

/** One input as the merged object takes it: its live rows, baked. */
type Part = {
    splat: Splat;
    /** the input's rows that are in, ascending */
    rows: Uint32Array;
    /** the input's row -> index into `rows`, plus one; 0: not in */
    index: Uint32Array;
    /** the baked columns, a value per row of `rows` */
    columns: Map<string, Float32Array>;
    /** velocity per row, in the merged object's space, per unit of the input's time */
    velocity: Float32Array | null;
};

const members = (bands: number) => [
    'x', 'y', 'z',
    'f_dc_0', 'f_dc_1', 'f_dc_2',
    'opacity',
    'scale_0', 'scale_1', 'scale_2',
    'rot_0', 'rot_1', 'rot_2', 'rot_3',
    ...shNames.slice(0, shBandCoeffs[bands] * 3)
];

const vel = new Vec3();
const pos = new Vec3();
const rq = new Quat();
const tmpSH = new Float32Array(15);
const rgb = { r: 0, g: 0, b: 0 };

/** What SingleSplat does to a gaussian, done to these rows of an object column by column. */
const bakeColumns = (splat: Splat, rows: Uint32Array, bands: number, columns: Map<string, Float32Array>, transforms: SplatTransformCache) => {
    const count = rows.length;
    // the columns as they are: the SH bands an sh-bands node leaves, and
    // zeros above them. The data holds all its bands, so the stride is theirs
    const srcCoeffs = shBandCoeffs[splatSHBands(splat, false)];
    const keptCoeffs = shBandCoeffs[splatSHBands(splat)];
    const dstCoeffs = shBandCoeffs[bands];
    columns.forEach((to, name) => {
        const sh = shNames.indexOf(name);
        let from: Float32Array | null;
        if (sh >= 0) {
            const channel = Math.floor(sh / dstCoeffs);
            const coeff = sh % dstCoeffs;
            from = coeff < keptCoeffs ? splat.splatData.getProp(shNames[channel * srcCoeffs + coeff]) as Float32Array : null;
        } else {
            from = splat.splatData.getProp(name) as Float32Array;
        }
        if (from) {
            for (let k = 0; k < count; ++k) to[k] = from[rows[k]];
        }
    });

    // placed: the transform of each gaussian - the object's, and a transform
    // node's on a selection - of which there are a few for all of them
    const x = columns.get('x'), y = columns.get('y'), z = columns.get('z');
    const r0 = columns.get('rot_0'), r1 = columns.get('rot_1'), r2 = columns.get('rot_2'), r3 = columns.get('rot_3');
    const s0 = columns.get('scale_0'), s1 = columns.get('scale_1'), s2 = columns.get('scale_2');
    const sh = shNames.slice(0, dstCoeffs * 3).map(name => columns.get(name));
    for (let k = 0; k < count; ++k) {
        const r = rows[k];
        const mat = transforms.getMat(r);
        pos.set(x[k], y[k], z[k]);
        mat.transformPoint(pos, pos);
        x[k] = pos.x;
        y[k] = pos.y;
        z[k] = pos.z;
        const rot = transforms.getRot(r);
        rq.set(r1[k], r2[k], r3[k], r0[k]).mul2(rot, rq);
        r1[k] = rq.x;
        r2[k] = rq.y;
        r3[k] = rq.z;
        r0[k] = rq.w;
        const scale = transforms.getScale(r);
        if (scale.x !== 1 || scale.y !== 1 || scale.z !== 1) {
            s0[k] = Math.log(Math.exp(s0[k]) * scale.x);
            s1[k] = Math.log(Math.exp(s1[k]) * scale.y);
            s2[k] = Math.log(Math.exp(s2[k]) * scale.z);
        }
        // a turn turns the view-dependent colour too
        if (dstCoeffs && Math.abs(Math.abs(rot.w) - 1) > 1e-7) {
            const shRot = transforms.getSHRot(r);
            for (let c = 0; c < 3; ++c) {
                for (let d = 0; d < dstCoeffs; ++d) tmpSH[d] = sh[c * dstCoeffs + d][k];
                shRot.apply(tmpSH);
                for (let d = 0; d < dstCoeffs; ++d) sh[c * dstCoeffs + d][k] = tmpSH[d];
            }
        }
    }

    // coloured: the grade each gaussian is on, then the object's
    const gradeFor = gradeLookup(splat, toGrade(gradeMatrix(splat)));
    const dc0 = columns.get('f_dc_0'), dc1 = columns.get('f_dc_1'), dc2 = columns.get('f_dc_2');
    const opacity = columns.get('opacity');
    for (let k = 0; k < count; ++k) {
        const grade = gradeFor(rows[k]);
        if (grade.hasTint) {
            rgb.r = dcDecode(dc0[k]);
            rgb.g = dcDecode(dc1[k]);
            rgb.b = dcDecode(dc2[k]);
            grade.applyDC(rgb);
            dc0[k] = dcEncode(rgb.r);
            dc1[k] = dcEncode(rgb.g);
            dc2[k] = dcEncode(rgb.b);
            for (let d = 0; d < dstCoeffs; ++d) {
                rgb.r = sh[d][k];
                rgb.g = sh[d + dstCoeffs][k];
                rgb.b = sh[d + dstCoeffs * 2][k];
                grade.applySH(rgb);
                sh[d][k] = rgb.r;
                sh[d + dstCoeffs][k] = rgb.g;
                sh[d + dstCoeffs * 2][k] = rgb.b;
            }
        }
        if (grade.hasAlpha) {
            opacity[k] = grade.applyOpacity(opacity[k]);
        }
    }
};

/**
 * An input's gaussians the way an export writes them: placed, coloured
 * and turned (SH too) into the merged object's space - which is the space
 * of a file, so the merged object stands where a loaded PLY would. Deleted
 * gaussians are left out.
 *
 * Column by column rather than gaussian by gaussian (SingleSplat): the
 * same arithmetic in a fraction of the time. An input under a debug view,
 * whose colour is worked out per gaussian, goes the slow way.
 */
const bakePart = (splat: Splat, bands: number): Part => {
    const state = splat.splatData.getProp('state') as Uint8Array;
    const n = splat.splatData.numSplats;
    let count = 0;
    for (let i = 0; i < n; ++i) {
        if ((state[i] & State.deleted) === 0) count++;
    }
    const rows = new Uint32Array(count);
    const index = new Uint32Array(n);
    for (let i = 0, k = 0; i < n; ++i) {
        if ((state[i] & State.deleted) === 0) {
            rows[k] = i;
            index[i] = ++k;
        }
    }

    const names = members(bands);
    const columns = new Map<string, Float32Array>();
    names.forEach(name => columns.set(name, new Float32Array(count)));
    const transforms = new SplatTransformCache(splat);

    if (debugColorSource(splat)) {
        const single = new SingleSplat(names, {});
        const out = names.map(name => columns.get(name));
        for (let k = 0; k < count; ++k) {
            single.read(splat, rows[k]);
            const { data } = single;
            for (let c = 0; c < names.length; ++c) {
                out[c][k] = data[names[c]];
            }
        }
    } else {
        bakeColumns(splat, rows, bands, columns, transforms);
    }

    // a 4D model's velocities turn and scale with it, as its centres do
    let velocity: Float32Array | null = null;
    if (splat.motion) {
        const vt = splat.motion.velocityTime;
        velocity = new Float32Array(count * 3);
        for (let k = 0; k < count; ++k) {
            const r = rows[k];
            vel.set(vt[r * 4], vt[r * 4 + 1], vt[r * 4 + 2]);
            transforms.getMat(r).transformVector(vel, vel);
            velocity[k * 3] = vel.x;
            velocity[k * 3 + 1] = vel.y;
            velocity[k * 3 + 2] = vel.z;
        }
    }

    return { splat, rows, index, columns, velocity };
};

/** What the parts are made from, so a part is baked again only when that changed. */
type PartCache = Map<Splat, { signature: string, bands: number, part: Part }>;

// a cheap hash of a typed array's bytes
const hashBytes = (view: ArrayBufferView | null | undefined) => {
    if (!view) return 0;
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const words = new Uint32Array(view.buffer, view.byteOffset, view.byteLength >>> 2);
    let h = 0x811c9dc5;
    for (let i = 0; i < words.length; ++i) {
        h = Math.imul(h ^ words[i], 0x01000193);
    }
    for (let i = words.length * 4; i < bytes.length; ++i) {
        h = Math.imul(h ^ bytes[i], 0x01000193);
    }
    return h >>> 0;
};

const textureHash = (texture: any) => {
    const data = texture?.lock?.({ mode: 1 /* TEXTURELOCK_READ */ });
    const h = data && (data.byteOffset % 4 === 0) ? hashBytes(data) : 0;
    texture?.unlock?.();
    return h;
};

/**
 * What an input's baked part depends on: its data and which of it is
 * deleted, where it stands, its transform and colour nodes, its debug
 * view and its bands.
 */
const partSignature = (splat: Splat) => {
    const m = splat.entity.getWorldTransform().data;
    return JSON.stringify([
        (splat.asset as any)?.id,
        splat.numSplats,
        hashBytes(splat.state.data.map(v => v & State.deleted)),
        Array.from(m, v => +v.toFixed(7)),
        textureHash(splat.transformTexture),
        textureHash(splat.transformPalette.texture),
        textureHash(splat.gradeTexture),
        textureHash(splat.gradePalette.texture),
        [splat.tintClr.r, splat.tintClr.g, splat.tintClr.b, splat.temperature, splat.saturation, splat.exposure,
            splat.brightness, splat.blackPoint, splat.whitePoint, splat.transparency],
        splat.debugShown ? [splat.debugShown.channel, splat.debugShown.mode, Array.from(splat.debugShown.params ?? [])] : null,
        splat.shBandLimit,
        // a 4D model's velocities: the same data, but motion set later
        splat.motion ? splat.motion.velocityTime.length : 0
    ]);
};

/** What decides an input's time: its time nodes, and how long its own sequence is. */
const timeSignature = (splat: Splat) => JSON.stringify([
    splat.motionFrames,
    (splat as any).motionFps ?? null,
    splat.timeMaps.map(m => (m.key ? m.key() : { kind: m.constructor.name, ...m }))
]);

/**
 * Everything the merged object is made from, as a string: built again
 * only when this changes.
 */
const mergeSignature = (inputs: Splat[], options: MergeBuildOptions, extra: unknown) => JSON.stringify([
    inputs.map(s => partSignature(s) + timeSignature(s)),
    options.sh,
    options.rate,
    // the timeline's length only matters to a switch, which spans it
    options.pick ? options.timelineFrames : null,
    options.include ?? null,
    options.opacity ?? null,
    options.minFrames ?? 0,
    extra
]);

const flip = new Quat().setFromEulerAngles(0, 0, 180);

/**
 * Build the merged object's data, and its motion when any input moves or a
 * switch picks inputs over time. `cache` keeps each input's baked part
 * for the next build.
 */
const buildMerge = (inputs: Splat[], options: MergeBuildOptions, cache: PartCache): MergeBuilt => {
    const rate = options.rate > 0 ? options.rate : 30;
    const timelineFrames = Math.max(1, options.timelineFrames || 1);
    const included = inputs.map((s, i) => !!s && (options.include?.[i] ?? true));

    // the bands: the most any input has, or the fewest
    const bandsOf = inputs.map((s, i) => (included[i] ? splatSHBands(s) : -1)).filter(b => b >= 0);
    const bands = !bandsOf.length ? 0 : (options.sh === 'truncate' ? Math.min(...bandsOf) : Math.max(...bandsOf));

    // the merged sequence: as long as the longest input's, or the cuts'
    const spans = inputs.map((s, i) => (included[i] ? inputSpan(s, rate, timelineFrames) : 0));
    let frames = Math.ceil(Math.max(0, ...spans) - 1e-6);
    if (options.pick) frames = Math.max(frames, timelineFrames, options.minFrames ?? 0);
    const moving = frames > 0;

    // each input baked, or as it was
    const parts = inputs.map((s, i) => {
        if (!included[i]) return null;
        const signature = partSignature(s);
        const hit = cache.get(s);
        if (hit && hit.signature === signature && hit.bands === bands) return hit.part;
        const part = bakePart(s, bands);
        cache.set(s, { signature, bands, part });
        return part;
    });
    // forget what is no longer an input
    [...cache.keys()].forEach(s => !inputs.includes(s) && cache.delete(s));

    // each input's pieces of time
    const piecesFor = inputs.map((s, i): Piece[] => {
        if (!included[i] || !parts[i]?.rows.length) return [];
        if (!moving) return [{ scale: 0, offset: 0, windows: [0, 1] }];
        const times: (number | null)[] = new Array(frames);
        for (let f = 0; f < frames; ++f) {
            const present = !options.pick || options.pick(i, f);
            times[f] = !present ? null : (s.motion ? inputTime(s, f, rate, timelineFrames) : 0);
        }
        if (!s.motion) {
            // a 3D input: there whenever it is picked, still
            const ps = piecesOf(times.map(t => (t === null ? null : 0)), frames);
            return ps.length ? [{ scale: 0, offset: 0, windows: ps.flatMap(p => p.windows) }] : [];
        }
        return piecesOf(times, frames);
    });

    // per piece: the input's rows it takes. A still takes those active at
    // its time; one that moves takes them all and lets the levels decide
    type Taken = { input: number, piece: Piece, rows: Uint32Array /* indices into the part's rows */ };
    const taken: Taken[] = [];
    piecesFor.forEach((pieces, i) => {
        const part = parts[i];
        pieces.forEach((piece) => {
            let rows: Uint32Array;
            const motion = inputs[i].motion;
            if (motion && piece.scale === 0) {
                const active = activeRows(motion, piece.offset);
                if (active) {
                    const picked: number[] = [];
                    for (let a = 0; a < active.length; ++a) {
                        const k = part.index[active[a]];
                        if (k) picked.push(k - 1);
                    }
                    picked.sort((a, b) => a - b);
                    rows = Uint32Array.from(picked);
                } else {
                    rows = Uint32Array.from({ length: part.rows.length }, (_, k) => k);
                }
            } else {
                rows = Uint32Array.from({ length: part.rows.length }, (_, k) => k);
            }
            if (rows.length) taken.push({ input: i, piece, rows });
        });
    });

    const total = taken.reduce((sum, t) => sum + t.rows.length, 0);
    const names = members(bands);
    const columns = new Map<string, Float32Array>();
    names.forEach(name => columns.set(name, new Float32Array(Math.max(1, total))));

    const velocityTime = moving ? new Float32Array(Math.max(1, total) * 4) : null;
    const falloff = moving ? new Float32Array(Math.max(1, total)) : null;

    // the layout: the global rows, and a level per (piece, level of its input)
    const globals: number[] = [];
    const levels: number[] = [];
    const scale: number[] = [];
    const offset: number[] = [];
    const windows: (Float64Array | null)[] = [];
    const blocks: { level: number, segment: number, rows: Uint32Array }[] = [];
    // per merged row: its level (-1 global) and whether it is still, for the debug view
    const rowLevel = moving ? new Int8Array(Math.max(1, total)) : null;
    const rowStill = moving ? new Uint8Array(Math.max(1, total)) : null;

    const rowsPerInput = inputs.map(() => 0);
    const copies = inputs.map(() => 0);

    let base = 0;
    taken.forEach(({ input, piece, rows }) => {
        const part = parts[input];
        const splat = inputs[input];
        const motion = splat.motion;
        const mult = Math.max(0, options.opacity?.[input] ?? 1);
        rowsPerInput[input] += rows.length;
        copies[input]++;

        // the columns, the opacity times the multiplier
        names.forEach((name) => {
            const from = part.columns.get(name);
            const to = columns.get(name);
            for (let k = 0; k < rows.length; ++k) to[base + k] = from[rows[k]];
        });
        if (mult !== 1) {
            const o = columns.get('opacity');
            for (let k = 0; k < rows.length; ++k) {
                o[base + k] = invSigmoid(sigmoid(o[base + k]) * mult);
            }
        }

        const pieceWindows = whole(piece.windows) ? null : Float64Array.from(piece.windows);
        const wholeTime = !pieceWindows;

        if (moving) {
            const vt = motion?.velocityTime;
            const fo = motion?.falloff;
            const x = columns.get('x');
            const y = columns.get('y');
            const z = columns.get('z');
            const o = columns.get('opacity');
            const hierarchy = motion?.hierarchy?.();
            for (let k = 0; k < rows.length; ++k) {
                const r = part.rows[rows[k]];
                const m = base + k;
                if (!motion) {
                    // a 3D input: still, always faded in
                    rowStill[m] = 1;
                    rowLevel[m] = -1;
                    continue;
                }
                const tc = vt[r * 4 + 3];
                const vx = part.velocity[rows[k] * 3];
                const vy = part.velocity[rows[k] * 3 + 1];
                const vz = part.velocity[rows[k] * 3 + 2];
                if (piece.scale === 0) {
                    // a still: where it is at that time, faded as it is then
                    const dt = piece.offset - tc;
                    x[m] += vx * dt;
                    y[m] += vy * dt;
                    z[m] += vz * dt;
                    const fade = Math.exp(-dt * dt * fo[r]);
                    o[m] = invSigmoid(sigmoid(o[m]) * fade);
                    rowStill[m] = 1;
                    rowLevel[m] = -1;
                } else {
                    // the input's time is scale * u + offset: what moves at
                    // v per unit of its time moves at v * scale per unit of u
                    velocityTime[m * 4] = vx * piece.scale;
                    velocityTime[m * 4 + 1] = vy * piece.scale;
                    velocityTime[m * 4 + 2] = vz * piece.scale;
                    velocityTime[m * 4 + 3] = (tc - piece.offset) / piece.scale;
                    falloff[m] = fo[r] * piece.scale * piece.scale;
                    rowLevel[m] = hierarchy ? hierarchy.level[r] : -1;
                    rowStill[m] = hierarchy ? hierarchy.still[r] : 0;
                }
            }
        }

        // where its rows go in the layout
        const layout = motion?.layout?.();
        if (!motion || piece.scale === 0 || !layout) {
            // still, or every row always active: one block
            const merged = Uint32Array.from(rows, (_, k) => base + k);
            if (wholeTime) {
                merged.forEach(r => globals.push(r));
            } else {
                levels.push(Infinity);
                scale.push(1);
                offset.push(0);
                windows.push(pieceWindows);
                blocks.push({ level: levels.length - 1, segment: 0, rows: merged });
            }
        } else {
            // the input's row -> the merged row, plus one
            const at = new Uint32Array(splat.numSplats);
            for (let k = 0; k < rows.length; ++k) at[part.rows[rows[k]]] = base + k + 1;
            const map = (from: Uint32Array) => {
                const out: number[] = [];
                for (let i = 0; i < from.length; ++i) {
                    const m = at[from[i]];
                    if (m) out.push(m - 1);
                }
                return Uint32Array.from(out);
            };
            // an input made of others (a merge, a switch) has its own scale,
            // offset and windows per level, of the input's time: composed
            // with the piece's, so its cuts stay where they were
            const first = levels.length;
            layout.levels.forEach((segLen, l) => {
                const s = layout.scale?.[l] ?? 1;
                const o = layout.offset?.[l] ?? 0;
                levels.push(segLen);
                scale.push(s * piece.scale);
                offset.push(s * piece.offset + o);
                windows.push(composeWindows(pieceWindows, layout.windows?.[l] ?? null, piece.scale, piece.offset));
            });
            let windowLevel = -1;
            layout.blocks.forEach((block) => {
                const merged = map(block.rows);
                if (!merged.length) return;
                if (block.level < 0) {
                    if (wholeTime) {
                        merged.forEach(r => globals.push(r));
                    } else {
                        if (windowLevel < 0) {
                            levels.push(Infinity);
                            scale.push(1);
                            offset.push(0);
                            windows.push(pieceWindows);
                            windowLevel = levels.length - 1;
                        }
                        blocks.push({ level: windowLevel, segment: 0, rows: merged });
                    }
                } else {
                    blocks.push({ level: first + block.level, segment: block.segment, rows: merged });
                }
            });
            // rows on no block of the input's: drawn whenever the input is
            const onBlock = new Uint8Array(rows.length);
            layout.blocks.forEach(block => block.rows.forEach((r) => {
                const m = at[r];
                if (m) onBlock[m - 1 - base] = 1;
            }));
            const loose: number[] = [];
            for (let k = 0; k < rows.length; ++k) {
                if (!onBlock[k]) loose.push(base + k);
            }
            if (loose.length && wholeTime) {
                loose.forEach(r => globals.push(r));
            } else if (loose.length) {
                levels.push(Infinity);
                scale.push(1);
                offset.push(0);
                windows.push(pieceWindows);
                blocks.push({ level: levels.length - 1, segment: 0, rows: Uint32Array.from(loose) });
            }
        }

        base += rows.length;
    });

    // data that draws nothing, rather than none
    if (total === 0) {
        const o = columns.get('opacity');
        o[0] = -20;
        ['scale_0', 'scale_1', 'scale_2'].forEach(n => (columns.get(n)[0] = -20));
        columns.get('rot_0')[0] = 1;
    }

    const data = new GSplatData([{
        name: 'vertex',
        count: Math.max(1, total),
        properties: names.map(name => ({ type: 'float', name, storage: columns.get(name), byteSize: 4 }))
    }]);

    let motion: SplatMotion | null = null;
    if (moving) {
        globals.sort((a, b) => a - b);
        const layout: MotionLayout = {
            levels: Float64Array.from(levels),
            blocks: [{ level: -1, segment: 0, rows: Uint32Array.from(globals) }, ...blocks],
            scale: Float64Array.from(scale),
            offset: Float64Array.from(offset),
            windows
        };

        // the active set at a time, the same array while it is the same set
        const sets: { key: string, rows: Uint32Array }[] = [];
        const activeAt = (t: number) => {
            const segments = layout.levels.length ? Array.from(layout.levels, (_, l) => layoutSegment(layout, l, t)) : [];
            const key = segments.join(',');
            const hit = sets.findIndex(s => s.key === key);
            if (hit >= 0) return sets[hit].rows;
            const parts: Uint32Array[] = [layout.blocks[0].rows];
            for (let b = 1; b < layout.blocks.length; ++b) {
                const block = layout.blocks[b];
                if (block.segment === segments[block.level]) parts.push(block.rows);
            }
            const length = parts.reduce((sum, p) => sum + p.length, 0);
            const rows = new Uint32Array(length);
            let at = 0;
            parts.forEach((p) => {
                rows.set(p, at);
                at += p.length;
            });
            rows.sort();
            sets.unshift({ key, rows });
            sets.length = Math.min(sets.length, 2);
            return rows;
        };

        motion = {
            velocityTime,
            falloff,
            activeAt,
            layout: () => layout,
            hierarchy: () => ({ level: rowLevel, still: rowStill })
        };
    }

    return { data, motion, frames: moving ? frames : 0, bands, rows: rowsPerInput, copies };
};

/** The rotation the merged object is placed with: that of a loaded PLY, since its data is in a file's space. */
const mergedRotation = () => flip.clone();

export {
    buildMerge,
    mergeSignature,
    mergedRotation,
    inputSpan,
    type MergeBuildOptions,
    type MergeBuilt,
    type PartCache,
    type ShMode,
    type InputPicker
};
