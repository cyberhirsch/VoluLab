import { type FieldSpec, type LookSpec } from './fields';
import { framesOf, stillFlags } from './measure';
import { MotionEditOp } from './motion-edit';
import { Splat, type SplatMotion } from '../splat';

/**
 * Fill hole: a still gaussian - in the global set, moving less than `still`
 * of its thinnest axis - that fades out where a frame lost coverage lives
 * `reach` frames longer on each side, so the frames around it fill the gap:
 * the neighbouring frames' gaussians copied in, without a copy. Only still
 * ones: a moving gaussian living longer would leave a trail.
 */
class FillHoleOp extends MotionEditOp {
    name = 'fillHole';
    reach: number;
    still: number;

    constructor(splat: Splat, settings: Partial<{ reach: number, still: number }> = {}) {
        super(splat);
        this.reach = settings.reach ?? 4;
        this.still = settings.still ?? 0.1;
    }

    get settings() {
        return { reach: this.reach, still: this.still };
    }

    get sourceLabel() {
        return `${this.reach} f`;
    }

    protected edit(splat: Splat, motion: SplatMotion, rows: Uint32Array, vt: Float32Array, falloff: Float32Array) {
        if (this.reach <= 0) return 0;
        const flags = stillFlags(splat, this.still, false);
        const extra = this.reach / framesOf(splat);
        let changed = 0;
        for (let k = 0; k < rows.length; ++k) {
            const r = rows[k];
            if (!flags[r] || !(falloff[r] > 0)) continue;
            // sigma = 1 / sqrt(2 falloff), longer by the reach
            const sigma = Math.sqrt(0.5 / falloff[r]) + extra;
            falloff[r] = 0.5 / (sigma * sigma);
            changed++;
        }
        return changed;
    }

    fields(): FieldSpec[] {
        return [
            { kind: 'slider',
                label: 'node.fill.reach',
                value: this.reach,
                min: 0,
                max: 30,
                step: 1,
                apply: (v) => {
                    this.reach = v;
                } },
            { kind: 'slider',
                label: 'node.look.still',
                value: Math.log10(this.still),
                min: -3,
                max: 1,
                step: 0.05,
                apply: (v) => {
                    this.still = 10 ** v;
                },
                format: v => `${+(10 ** v).toPrecision(2)}` },
            ...this.common('node.fill.note')
        ];
    }
}

const fillHole: LookSpec = {
    kind: 'fillHole',
    label: 'fill hole',
    hint: 'still gaussians live longer, to cover frames that lost them',
    create: splat => new FillHoleOp(splat),
    restore: (splat, settings) => new FillHoleOp(splat, settings ?? {}),
    stored: true
};

export { FillHoleOp, fillHole };
