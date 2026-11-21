/**
 * What a split node is made from: the rows a selection picks, and those
 * rows of an object as data of their own.
 *
 * A 4D model's rows are taken as they are - each gaussian at its temporal
 * centre, with its velocity, its lifetime and its place in the hierarchy -
 * so the part split off plays as the model did. A 3D object's rows go the
 * way a duplicate's do, written out and read back (see editor.ts), which
 * bakes in what the nodes above did to them.
 */

import { GSplatData } from 'playcanvas';

import type { MotionLayout } from './motion-sort';
import type { Splat, SplatMotion } from './splat';
import { State } from './splat-state';

/** The rows that are selected and nothing else, ascending. */
const selectedRows = (splat: Splat): Uint32Array => {
    const state = splat.splatData.getProp('state') as Uint8Array;
    const n = splat.splatData.numSplats;
    let count = 0;
    for (let i = 0; i < n; ++i) {
        if (state[i] === State.selected) count++;
    }
    const rows = new Uint32Array(count);
    for (let i = 0, k = 0; i < n; ++i) {
        if (state[i] === State.selected) rows[k++] = i;
    }
    return rows;
};

const sameRows = (a: Uint32Array | null, b: Uint32Array | null) => {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; ++i) {
        if (a[i] !== b[i]) return false;
    }
    return true;
};

// the columns an object adds to its data for its own bookkeeping
const OWN = new Set(['state', 'transform']);

/** Those rows of an object's data, column for column. */
const subsetData = (splat: Splat, rows: Uint32Array): GSplatData => {
    const properties = splat.splatData.getElement('vertex').properties
    .filter(p => !OWN.has(p.name))
    .map((p) => {
        const from = p.storage as any;
        const storage = new from.constructor(rows.length);
        for (let i = 0; i < rows.length; ++i) {
            storage[i] = from[rows[i]];
        }
        return { type: p.type, name: p.name, storage, byteSize: p.byteSize };
    });
    return new GSplatData([{ name: 'vertex', count: rows.length, properties }]);
};

/** Data that draws nothing: one gaussian with no size and no opacity. */
const emptyData = (): GSplatData => {
    const names = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
    const properties = names.map((name) => {
        const storage = new Float32Array(1);
        if (name === 'opacity' || name.startsWith('scale_')) storage[0] = -20;
        if (name === 'rot_0') storage[0] = 1;
        return { type: 'float', name, storage, byteSize: 4 };
    });
    return new GSplatData([{ name: 'vertex', count: 1, properties }]);
};

/**
 * Those rows of a 4D model's motion. `total` is how many rows the model
 * has. The hierarchy is the model's with the other rows taken out, so a
 * row is drawn at the times it was in the whole model.
 */
const subsetMotion = (motion: SplatMotion, rows: Uint32Array, total: number): SplatMotion => {
    const velocityTime = new Float32Array(rows.length * 4);
    const falloff = new Float32Array(rows.length);
    // the model's row -> this one's, plus one; 0: not among them
    const index = new Uint32Array(total);
    rows.forEach((row, i) => {
        velocityTime.set(motion.velocityTime.subarray(row * 4, row * 4 + 4), i * 4);
        falloff[i] = motion.falloff[row];
        index[row] = i + 1;
    });

    // both lists ascend, so what is picked ascends too
    const pick = (from: Uint32Array) => {
        let count = 0;
        for (let i = 0; i < from.length; ++i) {
            if (index[from[i]]) count++;
        }
        const out = new Uint32Array(count);
        for (let i = 0, k = 0; i < from.length; ++i) {
            const at = index[from[i]];
            if (at) out[k++] = at - 1;
        }
        return out;
    };

    // the model hands back the same array while its active set is the
    // same, and so must this: one picked set per set of the model's
    const sets = new WeakMap<Uint32Array, Uint32Array>();
    let layout: MotionLayout | null = null;
    let hierarchy: { level: Int8Array, still: Uint8Array } | null = null;

    return {
        velocityTime,
        falloff,
        activeAt: motion.activeAt && ((t: number) => {
            const active = motion.activeAt(t);
            if (!active) return null;
            if (!sets.has(active)) sets.set(active, pick(active));
            return sets.get(active);
        }),
        layout: motion.layout && (() => {
            if (!layout) {
                const whole = motion.layout();
                layout = {
                    levels: whole.levels,
                    blocks: whole.blocks.map(b => ({ ...b, rows: pick(b.rows) })).filter(b => b.rows.length > 0)
                };
            }
            return layout;
        }),
        hierarchy: motion.hierarchy && (() => {
            if (!hierarchy) {
                const whole = motion.hierarchy();
                hierarchy = {
                    level: Int8Array.from(rows, row => whole.level[row]),
                    still: Uint8Array.from(rows, row => whole.still[row])
                };
            }
            return hierarchy;
        })
    };
};

export { selectedRows, sameRows, subsetData, emptyData, subsetMotion };
