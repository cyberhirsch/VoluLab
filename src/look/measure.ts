/**
 * What the cleanup and look nodes measure of an object: the rows a node
 * acts on, where in time a 4D model's rows are drawn, and which stand still.
 */

import { Splat, type SplatMotion } from '../splat';
import { State } from '../splat-state';

const SH_C0 = 0.28209479177387814;

// what a gaussian below this alpha is to the shader: not drawn
const ALPHA_MIN = 1 / 255;

/** The still rule of the compact GSV export (tgh/gsv.ts): drift over the sequence, as a share of the thinnest axis ... */
const GSV_MAX_DRIFT = 1e-3;
/** ... and the least the lifetime falloff may fall to over the sequence */
const GSV_MIN_FALLOFF = 1 - 1 / 510;

/** The rows a node acts on: what is selected, or everything not deleted when nothing is. */
const scopeRows = (splat: Splat): { rows: Uint32Array, scoped: boolean } => {
    const state = splat.splatData.getProp('state') as Uint8Array;
    const n = splat.splatData.numSplats;
    let selected = 0;
    for (let i = 0; i < n; ++i) {
        if (state[i] === State.selected) selected++;
    }
    const scoped = selected > 0;
    const pick = scoped ? (s: number) => s === State.selected : (s: number) => (s & State.deleted) === 0;
    let k = 0;
    for (let i = 0; i < n; ++i) {
        if (pick(state[i])) k++;
    }
    const rows = new Uint32Array(k);
    k = 0;
    for (let i = 0; i < n; ++i) {
        if (pick(state[i])) rows[k++] = i;
    }
    return { rows, scoped };
};

/**
 * Per row of a 4D model, the stretch of normalised time its place in the
 * hierarchy lets it be drawn in, and whether it is in the global set (in
 * every active set). Without a hierarchy every row is global.
 */
const rowWindows = (motion: SplatMotion, n: number) => {
    const lo = new Float32Array(n);
    const hi = new Float32Array(n).fill(1);
    const global = new Uint8Array(n).fill(1);
    const layout = motion.layout?.();
    if (layout) {
        for (const block of layout.blocks) {
            if (block.level < 0) continue;
            const len = layout.levels[block.level];
            const a = block.segment * len;
            const { rows } = block;
            for (let i = 0; i < rows.length; ++i) {
                const r = rows[i];
                if (r >= n) continue;
                lo[r] = a;
                hi[r] = a + len;
                global[r] = 0;
            }
        }
    }
    return { lo, hi, global };
};

/**
 * How much of normalised time a row is drawn at more than `share` of its
 * peak opacity, within its window and the sequence: [from, to], empty when
 * from > to.
 */
const lifeOf = (tc: number, falloff: number, lo: number, hi: number, share: number): [number, number] => {
    const h = falloff > 1e-12 ? Math.sqrt(-Math.log(share) / falloff) : Infinity;
    return [Math.max(tc - h, lo, 0), Math.min(tc + h, hi, 1)];
};

/** A row's thinnest axis, from its log scales. */
const thinnestOf = (data: any) => {
    const s0 = data.getProp('scale_0') as Float32Array;
    const s1 = data.getProp('scale_1') as Float32Array;
    const s2 = data.getProp('scale_2') as Float32Array;
    return (r: number) => (s0 && s1 && s2 ? Math.exp(Math.min(s0[r], s1[r], s2[r])) : 1);
};

/**
 * Whether each row of a 4D model stands still: in the global set, and
 * moving less than `drift` of its thinnest axis over the time it is drawn;
 * with `fade`, also never fading over the sequence. drift = 0.001 with
 * fade is exactly the rule the compact GSV export moves gaussians to its
 * static page by, and the debug view's "still" channel shows.
 */
const stillFlags = (splat: Splat, drift: number, fade: boolean): Uint8Array => {
    const n = splat.splatData.numSplats;
    const still = new Uint8Array(n);
    const { motion } = splat;
    if (!motion) {
        still.fill(1);
        return still;
    }
    const { velocityTime: vt, falloff } = motion;
    const { lo, hi, global } = rowWindows(motion, n);
    const thinnest = thinnestOf(splat.splatData);
    for (let r = 0; r < n; ++r) {
        if (!global[r]) continue;
        const tc = vt[r * 4 + 3];
        const f = falloff[r];
        const [a, b] = lifeOf(tc, f, lo[r], hi[r], ALPHA_MIN);
        const life = Math.max(0, b - a);
        const moved = Math.hypot(vt[r * 4], vt[r * 4 + 1], vt[r * 4 + 2]) * (fade ? 1 : life);
        if (moved > drift * thinnest(r)) continue;
        if (fade && Math.exp(-f * Math.max(tc, 1 - tc) ** 2) < GSV_MIN_FALLOFF) continue;
        still[r] = 1;
    }
    return still;
};

/** The model's frame count, as the object last showed it. */
const framesOf = (splat: Splat) => Math.max(1, splat.motionFrames || 1);

const sigmoid = (v: number) => 1 / (1 + Math.exp(-v));

export { SH_C0, ALPHA_MIN, GSV_MAX_DRIFT, GSV_MIN_FALLOFF, scopeRows, rowWindows, lifeOf, thinnestOf, stillFlags, framesOf, sigmoid };
