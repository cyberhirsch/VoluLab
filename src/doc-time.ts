/**
 * How a project keeps the time nodes and the keyed colour nodes.
 *
 * Time nodes (trim, retime, loop, freeze, offset) change no data: they are
 * stored as their settings and go back in through `time.addNode`, each at
 * its place in the history, so their order against the merges and other
 * nodes the object feeds is what it was.
 *
 * A colour node is otherwise not a node in a project: what it did is in the
 * object (its own grade) or baked into the object's colours (a grade scoped
 * to a selection). Keyed, that loses the keys. So a keyed colour node is
 * stored as a node with its keys:
 *
 *  - the object's own grade: the node goes back on with its values and keys;
 *    the object's grade stored with the object is what it gives anyway.
 *  - a grade scoped to a selection: only where the object's selection nodes
 *    are stored too (they make the selection it graded again), it is the
 *    last thing on the object to put gaussians on new grades, and no debug
 *    view is on it. Then its grade is taken off the object while the object
 *    is written, and the node grades it again when the project opens.
 *    Otherwise it stays baked in, as before, and its keys are not kept.
 */

import { Color } from 'playcanvas';

import { GradeParams } from './color-grade';
import { EditOp, ScopedColorOp, SetSplatColorAdjustmentOp, TimeNodeSettings, TimeOp, principalOp } from './edit-ops';
import { Events } from './events';
import { isKeyed, packKeys, unpackKeys } from './keyframes';
import { Splat } from './splat';

type Place = (op: EditOp | undefined) => { at?: number, pos?: number[] };
type Later = (stored: any, add: () => EditOp | null) => void;

const packColor = (c: Color | undefined) => (c ? [c.r, c.g, c.b, c.a] : undefined);
const unpackColor = (a: unknown) => (Array.isArray(a) && a.length >= 3 && a.every(Number.isFinite) ? new Color(a[0], a[1], a[2], a[3] ?? 1) : undefined);

/** Each object's time nodes, in history order. */
const storeTimeNodes = (ops: EditOp[], cursor: number, splats: Splat[], placeOf: Place) => ops.slice(0, cursor).flatMap((o) => {
    const op = principalOp(o);
    const i = op instanceof TimeOp ? splats.indexOf(op.splat) : -1;
    const settings = i >= 0 ? (op as TimeOp).settings : null;
    return settings ? [{ ...settings, splat: i, bypassed: !!o.bypassed, ...placeOf(o) }] : [];
});

const restoreTimeNodes = (document: any, loaded: Splat[], later: Later, events: Events) => {
    (Array.isArray(document?.timeNodes) ? document.timeNodes : []).forEach((stored: TimeNodeSettings & { splat: number }) => {
        const splat = loaded[stored?.splat];
        if (splat) later(stored, () => events.invoke('time.addNode', splat, stored));
    });
};

/**
 * The keyed colour nodes a project keeps as nodes, and a function that puts
 * back on the objects the grades taken off them while they are written.
 * `withNodes[i]`: object i's selection nodes are stored.
 */
const storeColourNodes = (ops: EditOp[], cursor: number, splats: Splat[], withNodes: boolean[], placeOf: Place) => {
    const stored: any[] = [];
    const putBack: (() => void)[] = [];
    const applied = ops.slice(0, cursor);

    applied.forEach((o, at) => {
        const op = principalOp(o);
        if (!isKeyed(op)) return;

        if (op instanceof SetSplatColorAdjustmentOp) {
            const i = splats.indexOf(op.splat);
            if (i < 0) return;
            stored.push({
                kind: 'object',
                splat: i,
                state: { ...op.newState, tintClr: packColor(op.newState.tintClr) },
                keys: packKeys(op),
                bypassed: !!o.bypassed,
                ...placeOf(o)
            });
            return;
        }

        if (!(op instanceof ScopedColorOp)) return;
        const i = splats.indexOf(op.splat);
        const map = (op as any).paletteMap as Map<number, number> | null;
        if (i < 0 || !withNodes[i] || op.splat.debugViews.length) return;
        // a later colour node on the object composed its grades from these
        if (applied.slice(at + 1).some(l => principalOp(l) instanceof ScopedColorOp && (principalOp(l) as ScopedColorOp).splat === op.splat)) return;

        const grade = { ...op.grade, tintClr: packColor(op.grade.tintClr) };
        if (o.bypassed || !map) {
            // nothing of it is on the object: the node goes back as it was
            stored.push({ kind: 'scoped', splat: i, grade, keys: packKeys(op), bypassed: !!o.bypassed, ...placeOf(o) });
            return;
        }

        // its gaussians back on the grades they were on before it
        const splat = op.splat;
        const slots = splat.gradeTexture.lock() as Uint16Array;
        const before = slots.slice();
        const inverse = new Map<number, number>();
        map.forEach((slot, old) => inverse.set(slot, old));
        const newest = Math.max(...map.values());
        let clean = true;
        for (let k = 0; k < slots.length; ++k) {
            const back = inverse.get(slots[k]);
            if (back !== undefined) slots[k] = back;
            // a grade newer than this node's: something after it re-graded rows
            else if (slots[k] > newest) clean = false;
        }
        if (!clean) slots.set(before);
        splat.gradeTexture.unlock();
        if (!clean) return;

        putBack.push(() => {
            const t = splat.gradeTexture.lock() as Uint16Array;
            t.set(before);
            splat.gradeTexture.unlock();
            splat.scene.forceRender = true;
        });
        stored.push({ kind: 'scoped', splat: i, grade, keys: packKeys(op), ...placeOf(o) });
    });

    return { stored, putBack: () => putBack.forEach(f => f()) };
};

const restoreColourNodes = (document: any, loaded: Splat[], later: Later, events: Events) => {
    (Array.isArray(document?.colourNodes) ? document.colourNodes : []).forEach((stored: any) => {
        const splat = loaded[stored?.splat];
        if (!splat) return;
        later(stored, () => {
            let op: SetSplatColorAdjustmentOp | ScopedColorOp;
            if (stored.kind === 'object' && stored.state) {
                const state = { ...stored.state, tintClr: unpackColor(stored.state.tintClr) };
                op = new SetSplatColorAdjustmentOp({ splat, oldState: { ...state }, newState: state });
            } else if (stored.kind === 'scoped' && stored.grade) {
                const g = stored.grade;
                op = new ScopedColorOp(splat, { ...g, tintClr: unpackColor(g.tintClr) ?? new Color(1, 1, 1) } as GradeParams);
            } else {
                return null;
            }
            unpackKeys(op, stored.keys);
            (op as EditOp).bypassed = !!stored.bypassed;
            events.fire('edit.add', op);
            return op as EditOp;
        });
    });
};

export { storeTimeNodes, restoreTimeNodes, storeColourNodes, restoreColourNodes };
