import { count, type FieldNode, type FieldSpec } from './fields';
import { SH_C0, scopeRows } from './measure';
import { composeGrades, type Grade } from '../grade-palette';
import { Scene } from '../scene';
import { Splat } from '../splat';

/**
 * A node that grades rows through the palette. `plan` says, per row in
 * scope, which of its grades the row gets (-1: none); each (slot the row is
 * on, grade) pair becomes one new slot holding the two composed. Undo puts
 * the indices back and frees the slots, which were the newest - the history
 * undoes newest first.
 */
abstract class GradeRowsOp implements FieldNode {
    name: string;
    splat: Splat;
    bypassed?: boolean;
    affected = -1;

    private saved: Uint16Array | null = null;
    private slots = 0;

    constructor(splat: Splat) {
        this.splat = splat;
    }

    protected abstract plan(splat: Splat, rows: Uint32Array): { bucket: Int32Array, grades: Grade[] } | null;

    abstract get settings(): Record<string, any>;

    abstract fields(scene: Scene): FieldSpec[];

    do() {
        const { splat } = this;
        if (!splat?.splatData) return;
        const { rows } = scopeRows(splat);
        const plan = rows.length ? this.plan(splat, rows) : null;
        if (!plan) {
            this.affected = 0;
            return;
        }
        const { bucket, grades } = plan;
        const palette = splat.gradePalette;
        const indices = splat.gradeTexture.lock() as Uint16Array;
        this.saved = indices.slice();
        const G = grades.length;
        const slotOf = new Map<number, number>();
        let changed = 0;
        for (let k = 0; k < rows.length; ++k) {
            const b = bucket[k];
            if (b < 0) continue;
            const r = rows[k];
            const old = indices[r];
            const key = old * G + b;
            let slot = slotOf.get(key);
            if (slot === undefined) {
                if (slotOf.size >= 60000) continue;
                slot = palette.alloc();
                palette.setGrade(slot, composeGrades(palette.getGrade(old), grades[b]));
                slotOf.set(key, slot);
            }
            indices[r] = slot;
            changed++;
        }
        splat.gradeTexture.unlock();
        this.slots = slotOf.size;
        this.affected = changed;
        splat.scene.forceRender = true;
    }

    undo() {
        const { splat, saved } = this;
        if (!saved) return;
        this.saved = null;
        const indices = splat.gradeTexture.lock() as Uint16Array;
        if (indices.length === saved.length) indices.set(saved);
        splat.gradeTexture.unlock();
        splat.gradePalette.free(this.slots);
        this.slots = 0;
        if (splat.scene) splat.scene.forceRender = true;
    }

    destroy() {
        this.splat = null;
        this.saved = null;
    }

    protected scopeStat(): FieldSpec {
        return { kind: 'stat', label: 'node.look.changed', value: count(this.affected), raw: this.affected >= 0 };
    }
}

const diagGrade = (r: number, g: number, b: number, t: [number, number, number] = [0, 0, 0], alpha = 1): Grade => ({
    m: [r, 0, 0, 0, g, 0, 0, 0, b],
    t,
    alpha
});

/**
 * The colour each row is drawn with, ahead of the object's own grade: its
 * DC colour through the palette slot it is on - what colour nodes and the
 * nodes here have put on it so far - and that slot's alpha scale. A
 * measure taken on these sees the nodes above it.
 */
const gradedColour = (splat: Splat) => {
    const data = splat.splatData;
    const dc = [0, 1, 2].map(c => data.getProp(`f_dc_${c}`) as Float32Array);
    const slots = new Uint16Array(splat.gradeTexture.lock() as Uint16Array);
    splat.gradeTexture.unlock();
    const grades = new Map<number, Grade>();
    /** rgb into out[0..2], the alpha scale into out[3] */
    return (r: number, out: number[]) => {
        const c0 = 0.5 + SH_C0 * (dc[0]?.[r] ?? 0);
        const c1 = 0.5 + SH_C0 * (dc[1]?.[r] ?? 0);
        const c2 = 0.5 + SH_C0 * (dc[2]?.[r] ?? 0);
        const slot = slots[r];
        if (!slot) {
            out[0] = c0;
            out[1] = c1;
            out[2] = c2;
            out[3] = 1;
            return;
        }
        let g = grades.get(slot);
        if (!g) {
            g = splat.gradePalette.getGrade(slot);
            grades.set(slot, g);
        }
        const { m, t } = g;
        out[0] = m[0] * c0 + m[3] * c1 + m[6] * c2 + t[0];
        out[1] = m[1] * c0 + m[4] * c1 + m[7] * c2 + t[1];
        out[2] = m[2] * c0 + m[5] * c1 + m[8] * c2 + t[2];
        out[3] = g.alpha;
    };
};

export { GradeRowsOp, diagGrade, gradedColour };
