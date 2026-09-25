import { Vec3 } from 'playcanvas';

import type { VolumeEmitter } from '../edit-ops';
import type { Splat } from '../splat';

/**
 * Volume lights: the glowing part of a capture - a lamp, a window, a
 * screen - made into the light it gives. The selected gaussians of one
 * object are weighed by how much light each shows and clustered into a
 * handful of emitters, so a lamp of thousands of gaussians lights the scene
 * for the price of a handful of falloffs and a single shadow cone.
 *
 * What a gaussian gives off is taken to be what the capture shows of it:
 * its colour's luminance, its opacity and its footprint. A capture cannot
 * tell what glowed from what merely reflected, so the selection is the
 * user saying which.
 */

const SH_C0 = 0.28209479177387814;

// A selection larger than this is sampled evenly before clustering: the
// clusters barely move, and a million-gaussian selection stays quick.
const MAX_SAMPLES = 20000;

// Lloyd iterations after seeding
const ITERATIONS = 10;

type VolumeSource = {
    /** the emitters' weighted middle, in world space - where the light goes */
    centre: Vec3;
    emitters: VolumeEmitter[];
    /** how many gaussians were selected */
    count: number;
    /** how far the selection spreads round its middle, root mean square */
    spread: number;
};

/**
 * The object whose selected gaussians a volume light should come from: the
 * selected object if it has any, or else any drawn object that does. Picking
 * a light in the graph deselects the object but leaves its gaussians
 * selected, so the selected object alone would often say "none".
 */
const splatWithSelection = (selected: Splat | null, splats: Splat[]) => {
    if (selected?.numSelected > 0) return selected;
    return splats.find(splat => splat.visible && splat.numSelected > 0) ?? null;
};

const emittersFromSelection = (splat: Splat, maxEmitters = 16): VolumeSource | null => {
    const data = splat.splatData;
    const state = data.getProp('state') as Uint8Array;
    const prop = (name: string) => data.getProp(name) as Float32Array;
    const x = prop('x');
    const y = prop('y');
    const z = prop('z');
    const dc = [prop('f_dc_0'), prop('f_dc_1'), prop('f_dc_2')];
    const opacity = prop('opacity');
    const scales = [prop('scale_0'), prop('scale_1'), prop('scale_2')];
    // the sorter's centres follow the transform palette, so they are where
    // the gaussians are drawn now
    const centers = (splat.entity.gsplat?.instance as any)?.sorter?.centers as Float32Array;
    const m = splat.entity.getWorldTransform().data;
    // footprints scale with the object; assumed uniform, like the gizmo does
    const worldScale = Math.hypot(m[0], m[1], m[2]);

    const selected: number[] = [];
    for (let i = 0; i < data.numSplats; ++i) {
        // selected, and neither hidden nor deleted
        if (state[i] === 1) selected.push(i);
    }
    if (selected.length === 0) return null;

    const stride = Math.ceil(selected.length / MAX_SAMPLES);
    const n = Math.ceil(selected.length / stride);
    const px = new Float64Array(n);
    const py = new Float64Array(n);
    const pz = new Float64Array(n);
    const cr = new Float64Array(n);
    const cg = new Float64Array(n);
    const cb = new Float64Array(n);
    const w = new Float64Array(n);

    for (let k = 0; k < n; ++k) {
        const i = selected[k * stride];
        const lx = centers ? centers[i * 3] : x[i];
        const ly = centers ? centers[i * 3 + 1] : y[i];
        const lz = centers ? centers[i * 3 + 2] : z[i];
        px[k] = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
        py[k] = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
        pz[k] = m[2] * lx + m[6] * ly + m[10] * lz + m[14];

        const r = dc[0] ? Math.max(0, 0.5 + SH_C0 * dc[0][i]) : 1;
        const g = dc[1] ? Math.max(0, 0.5 + SH_C0 * dc[1][i]) : 1;
        const b = dc[2] ? Math.max(0, 0.5 + SH_C0 * dc[2][i]) : 1;
        cr[k] = r;
        cg[k] = g;
        cb[k] = b;

        const alpha = opacity ? 1 / (1 + Math.exp(-opacity[i])) : 1;
        const s = scales.map(v => (v ? Math.exp(v[i]) : 1)).sort((p, q) => q - p);
        const footprint = Math.PI * s[0] * s[1] * worldScale * worldScale;
        const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        // a floor, so a selection of dark gaussians still makes a light
        w[k] = Math.max(luminance * alpha * footprint, 1e-12);
    }

    // seeds: the brightest gaussian, then over and over the one that most
    // outweighs its distance to the seeds so far - farthest-point seeding,
    // weighted, and the same every time for the same selection
    const count = Math.min(maxEmitters, n);
    const sx = new Float64Array(count);
    const sy = new Float64Array(count);
    const sz = new Float64Array(count);
    const nearest = new Float64Array(n).fill(Infinity);
    let pick = 0;
    for (let k = 1; k < n; ++k) {
        if (w[k] > w[pick]) pick = k;
    }
    for (let c = 0; c < count; ++c) {
        sx[c] = px[pick];
        sy[c] = py[pick];
        sz[c] = pz[pick];
        let best = -1;
        for (let k = 0; k < n; ++k) {
            const dx = px[k] - sx[c];
            const dy = py[k] - sy[c];
            const dz = pz[k] - sz[c];
            nearest[k] = Math.min(nearest[k], dx * dx + dy * dy + dz * dz);
            const score = nearest[k] * w[k];
            if (score > best) {
                best = score;
                pick = k;
            }
        }
    }

    // Lloyd's iterations, weighted
    const owner = new Int32Array(n);
    const sw = new Float64Array(count);
    const ax = new Float64Array(count);
    const ay = new Float64Array(count);
    const az = new Float64Array(count);
    for (let it = 0; it < ITERATIONS; ++it) {
        sw.fill(0);
        ax.fill(0);
        ay.fill(0);
        az.fill(0);
        for (let k = 0; k < n; ++k) {
            let best = Infinity;
            let c = 0;
            for (let j = 0; j < count; ++j) {
                const dx = px[k] - sx[j];
                const dy = py[k] - sy[j];
                const dz = pz[k] - sz[j];
                const d2 = dx * dx + dy * dy + dz * dz;
                if (d2 < best) {
                    best = d2;
                    c = j;
                }
            }
            owner[k] = c;
            sw[c] += w[k];
            ax[c] += w[k] * px[k];
            ay[c] += w[k] * py[k];
            az[c] += w[k] * pz[k];
        }
        for (let j = 0; j < count; ++j) {
            // an emptied cluster keeps its place
            if (sw[j] > 0) {
                sx[j] = ax[j] / sw[j];
                sy[j] = ay[j] / sw[j];
                sz[j] = az[j] / sw[j];
            }
        }
    }

    // each cluster's colour and spread, from the members it ended with
    const colour = new Float64Array(count * 3);
    const spread2 = new Float64Array(count);
    let total = 0;
    let mx = 0;
    let my = 0;
    let mz = 0;
    for (let k = 0; k < n; ++k) {
        const c = owner[k];
        colour[c * 3] += w[k] * cr[k];
        colour[c * 3 + 1] += w[k] * cg[k];
        colour[c * 3 + 2] += w[k] * cb[k];
        const dx = px[k] - sx[c];
        const dy = py[k] - sy[c];
        const dz = pz[k] - sz[c];
        spread2[c] += w[k] * (dx * dx + dy * dy + dz * dz);
        total += w[k];
        mx += w[k] * px[k];
        my += w[k] * py[k];
        mz += w[k] * pz[k];
    }
    const centre = new Vec3(mx / total, my / total, mz / total);

    const emitters: VolumeEmitter[] = [];
    for (let j = 0; j < count; ++j) {
        if (!(sw[j] > 0)) continue;
        const r = colour[j * 3] / sw[j];
        const g = colour[j * 3 + 1] / sw[j];
        const b = colour[j * 3 + 2] / sw[j];
        const peak = Math.max(r, g, b, 1e-9);
        emitters.push({
            offset: [sx[j] - centre.x, sy[j] - centre.y, sz[j] - centre.z],
            weight: sw[j] / total,
            color: [r / peak, g / peak, b / peak],
            radius: Math.sqrt(spread2[j] / sw[j])
        });
    }

    let spread = 0;
    for (let k = 0; k < n; ++k) {
        const dx = px[k] - centre.x;
        const dy = py[k] - centre.y;
        const dz = pz[k] - centre.z;
        spread += w[k] * (dx * dx + dy * dy + dz * dz);
    }

    return {
        centre,
        emitters,
        count: selected.length,
        spread: Math.sqrt(spread / total)
    };
};

export { emittersFromSelection, splatWithSelection, type VolumeSource };
