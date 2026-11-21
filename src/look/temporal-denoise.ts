import { type FieldSpec, type LookSpec } from './fields';
import { ALPHA_MIN, framesOf, lifeOf, rowWindows, thinnestOf } from './measure';
import { MotionEditOp } from './motion-edit';
import { Splat, type SplatMotion } from '../splat';

/**
 * Temporal denoise: what barely moves is smoothed, what really moves is
 * kept. A gaussian whose drift over the time it is drawn stays under `keep`
 * of its thinnest axis has its velocity damped by `strength` - jitter around
 * a rest pose - and its lifetime widened by `smooth` frames, so it fades
 * in and out over longer: a low-pass on its opacity over time. A gaussian's
 * colour is the same at every time in this kind of model, so there is no
 * colour flicker of a single gaussian to smooth.
 */
class TemporalDenoiseOp extends MotionEditOp {
    name = 'temporalDenoise';
    strength: number;
    smooth: number;
    keep: number;

    constructor(splat: Splat, settings: Partial<{ strength: number, smooth: number, keep: number }> = {}) {
        super(splat);
        this.strength = settings.strength ?? 0.75;
        this.smooth = settings.smooth ?? 2;
        this.keep = settings.keep ?? 1;
    }

    get settings() {
        return { strength: this.strength, smooth: this.smooth, keep: this.keep };
    }

    get sourceLabel() {
        return `${Math.round(this.strength * 100)}%, ${this.smooth} f`;
    }

    protected edit(splat: Splat, motion: SplatMotion, rows: Uint32Array, vt: Float32Array, falloff: Float32Array) {
        if (this.strength <= 0 && this.smooth <= 0) return 0;
        const n = splat.splatData.numSplats;
        const { lo, hi } = rowWindows(motion, n);
        const thinnest = thinnestOf(splat.splatData);
        const widen = (this.smooth / framesOf(splat)) ** 2;
        const damp = 1 - Math.min(1, Math.max(0, this.strength));
        let changed = 0;
        for (let k = 0; k < rows.length; ++k) {
            const r = rows[k];
            const [a, b] = lifeOf(vt[r * 4 + 3], falloff[r], lo[r], hi[r], ALPHA_MIN);
            const moved = Math.hypot(vt[r * 4], vt[r * 4 + 1], vt[r * 4 + 2]) * Math.max(0, b - a);
            if (moved > this.keep * thinnest(r)) continue;
            vt[r * 4] *= damp;
            vt[r * 4 + 1] *= damp;
            vt[r * 4 + 2] *= damp;
            if (widen > 0 && falloff[r] > 0) {
                // the lifetime is a gaussian in time: widening it by a
                // gaussian of `smooth` frames adds the variances
                falloff[r] = 1 / (1 / falloff[r] + 2 * widen);
            }
            changed++;
        }
        return changed;
    }

    fields(): FieldSpec[] {
        return [
            { kind: 'slider',
                label: 'node.denoise.strength',
                value: this.strength,
                min: 0,
                max: 1,
                step: 0.05,
                apply: (v) => {
                    this.strength = v;
                },
                format: v => `${Math.round(v * 100)}%` },
            { kind: 'slider',
                label: 'node.denoise.smooth',
                value: this.smooth,
                min: 0,
                max: 20,
                step: 0.5,
                apply: (v) => {
                    this.smooth = v;
                } },
            { kind: 'slider',
                label: 'node.denoise.keep',
                value: this.keep,
                min: 0.05,
                max: 20,
                step: 0.05,
                apply: (v) => {
                    this.keep = v;
                },
                format: v => v.toFixed(2) },
            ...this.common('node.denoise.note')
        ];
    }
}

const temporalDenoise: LookSpec = {
    kind: 'temporalDenoise',
    label: 'temporal denoise',
    hint: 'jitter and popping smoothed, real motion kept',
    create: splat => new TemporalDenoiseOp(splat),
    restore: (splat, settings) => new TemporalDenoiseOp(splat, settings ?? {}),
    stored: true
};

export { TemporalDenoiseOp, temporalDenoise };
