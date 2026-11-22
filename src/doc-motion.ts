import { EditOp, MultiOp } from './edit-ops';
import { MotionEditOp } from './look/motion-edit';
import { layoutSegment, type MotionLayout } from './motion-sort';
import type { Splat, SplatMotion } from './splat';
import { State } from './splat-state';
import { subsetMotion } from './split';

/**
 * A 4D object's motion as a project stores it, beside the object's PLY:
 * for the 4D objects that have no file of their own - a part split off a
 * 4D model, by a split or still / moving split node. Its PLY holds every
 * gaussian at its temporal centre; this holds the velocities, temporal
 * centres and falloffs, and the hierarchy that says which rows are drawn
 * when. Read back, the object plays as it did.
 *
 * Layout: a u32 header length, the header (JSON, padded to 4 bytes), then
 * velocityTime (f32, 4 a row), falloff (f32), each block's rows (u32) and,
 * if there is one, the per-row hierarchy level (i8) and still flag (u8).
 */

// JSON has no Infinity, which a level of infinite length is
const num = (v: number) => (Number.isFinite(v) ? v : String(v));
const unnum = (v: number | string) => Number(v);

const packMotion = (motion: SplatMotion): Uint8Array => {
    const rows = motion.falloff.length;
    const layout = motion.layout?.() ?? null;
    const hierarchy = motion.hierarchy?.() ?? null;
    const header = JSON.stringify({
        rows,
        layout: layout ? {
            levels: Array.from(layout.levels, num),
            blocks: layout.blocks.map(b => ({ level: b.level, segment: b.segment, count: b.rows.length })),
            ...(layout.scale ? { scale: Array.from(layout.scale, num) } : {}),
            ...(layout.offset ? { offset: Array.from(layout.offset, num) } : {}),
            ...(layout.windows ? { windows: layout.windows.map(w => (w ? Array.from(w, num) : null)) } : {})
        } : null,
        hierarchy: !!hierarchy
    });
    const text = new TextEncoder().encode(header);
    const pad4 = (n: number) => (n + 3) & ~3;
    const parts: ArrayBufferView[] = [motion.velocityTime.subarray(0, rows * 4), motion.falloff];
    layout?.blocks.forEach(b => parts.push(b.rows));
    if (hierarchy) parts.push(hierarchy.level, hierarchy.still);
    const size = 4 + pad4(text.length) + parts.reduce((sum, p) => sum + pad4(p.byteLength), 0);
    const out = new Uint8Array(size);
    new DataView(out.buffer).setUint32(0, text.length, true);
    out.set(text, 4);
    let at = 4 + pad4(text.length);
    parts.forEach((p) => {
        out.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), at);
        at += pad4(p.byteLength);
    });
    return out;
};

/** the active set at a time from a layout, the same array while it is the same set */
const activeFromLayout = (layout: MotionLayout) => {
    const sets: { key: string, rows: Uint32Array }[] = [];
    return (t: number) => {
        const segments = Array.from(layout.levels, (_, l) => layoutSegment(layout, l, t));
        const key = segments.join(',');
        const hit = sets.find(s => s.key === key);
        if (hit) return hit.rows;
        const parts = layout.blocks.filter(b => b.level < 0 || b.segment === segments[b.level]).map(b => b.rows);
        const rows = new Uint32Array(parts.reduce((sum, p) => sum + p.length, 0));
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
};

/** the motion again from what packMotion wrote, or null if it does not read */
const unpackMotion = (bytes: Uint8Array): SplatMotion | null => {
    // copied so every array starts on an aligned offset
    const buffer = bytes.slice().buffer;
    const view = new DataView(buffer);
    if (buffer.byteLength < 4) return null;
    const length = view.getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, length)));
    const pad4 = (n: number) => (n + 3) & ~3;
    let at = 4 + pad4(length);
    const take = <T>(make: (b: ArrayBuffer, o: number, n: number) => T, count: number, bytesPer: number): T => {
        if (at + count * bytesPer > buffer.byteLength) throw new Error('motion data is short');
        const result = make(buffer, at, count);
        at += pad4(count * bytesPer);
        return result;
    };
    const rows = header.rows as number;
    const velocityTime = take((b, o, n) => new Float32Array(b, o, n), rows * 4, 4);
    const falloff = take((b, o, n) => new Float32Array(b, o, n), rows, 4);
    let layout: MotionLayout | null = null;
    if (header.layout) {
        const h = header.layout;
        layout = {
            levels: Float64Array.from(h.levels, unnum),
            blocks: h.blocks.map((b: any) => ({ level: b.level, segment: b.segment, rows: take((buf, o, n) => new Uint32Array(buf, o, n), b.count, 4) })),
            ...(h.scale ? { scale: Float64Array.from(h.scale, unnum) } : {}),
            ...(h.offset ? { offset: Float64Array.from(h.offset, unnum) } : {}),
            ...(h.windows ? { windows: h.windows.map((w: any) => (w ? Float64Array.from(w, unnum) : null)) } : {})
        };
    }
    let hierarchy: { level: Int8Array, still: Uint8Array } | null = null;
    if (header.hierarchy) {
        hierarchy = {
            level: take((b, o, n) => new Int8Array(b, o, n), rows, 1),
            still: take((b, o, n) => new Uint8Array(b, o, n), rows, 1)
        };
    }
    return {
        velocityTime,
        falloff,
        ...(layout ? { activeAt: activeFromLayout(layout), layout: () => layout } : {}),
        ...(hierarchy ? { hierarchy: () => hierarchy } : {})
    };
};

/**
 * The motion to store for a 4D object without a file of its own: what it
 * had under its first applied motion-edit node, which the project stores as
 * a node and applies again on open (doc-looks.ts) - so stored as it is now,
 * the edit would be made twice. With `allRows` false the PLY leaves the
 * deleted gaussians out, and so does this.
 */
const storedMotion = (splat: Splat, ops: EditOp[], cursor: number, allRows: boolean): SplatMotion | null => {
    if (!splat.motion) return null;
    let motion = splat.motion;
    for (const outer of ops.slice(0, cursor)) {
        const parts = outer instanceof MultiOp ? outer.ops : [outer];
        const first = parts.find(op => op instanceof MotionEditOp && op.splat === splat && op.base) as MotionEditOp | undefined;
        if (first) {
            motion = first.base;
            break;
        }
    }
    const n = splat.splatData.numSplats;
    if (motion.falloff.length !== n) return null;
    if (allRows || !splat.state.numDeleted) return motion;
    const state = splat.state.data;
    const kept: number[] = [];
    for (let i = 0; i < n; ++i) {
        if ((state[i] & State.deleted) === 0) kept.push(i);
    }
    return subsetMotion(motion, Uint32Array.from(kept), n);
};

export { packMotion, unpackMotion, storedMotion };
