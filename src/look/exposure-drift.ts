import { type FieldSpec, type LookSpec } from './fields';
import { diagGrade, GradeRowsOp, gradedColour } from './grade-rows';
import { ALPHA_MIN, framesOf, lifeOf, rowWindows, sigmoid } from './measure';
import { type Grade } from '../grade-palette';
import { Splat } from '../splat';

/**
 * Exposure over time: evens out exposure drift between the frames of a 4D
 * model - and with white balance on, colour drift too. It measures each
 * frame's mean colour (opacity weighted, over a sample of the gaussians
 * drawn there), works out the gain that takes it to the mean over all
 * frames - or, with `window` frames, to the mean of the frames around it,
 * which keeps slow changes and removes quick ones - and grades each
 * gaussian by the gains of the frames it is drawn in. `strength` scales the
 * correction, in stops.
 *
 * Manual exposure and white balance over time are the colour node's own
 * settings, keyed over time.
 */
class ExposureDriftOp extends GradeRowsOp {
    name = 'exposureDrift';
    strength: number;
    window: number;
    balance: boolean;

    /** per frame, the gain worked out on the last apply (exposure, or its mean over channels) */
    gains: Float32Array | null = null;

    constructor(splat: Splat, settings: Partial<{ strength: number, window: number, balance: boolean }> = {}) {
        super(splat);
        this.strength = settings.strength ?? 1;
        this.window = settings.window ?? 0;
        this.balance = !!settings.balance;
    }

    get settings() {
        return { strength: this.strength, window: this.window, balance: this.balance };
    }

    get sourceLabel() {
        return this.balance ? 'exposure + white' : 'exposure';
    }

    protected plan(splat: Splat, rows: Uint32Array) {
        const { motion } = splat;
        this.gains = null;
        if (!motion || this.strength <= 0) return null;
        const F = framesOf(splat);
        if (F < 2) return null;
        const data = splat.splatData;
        const n = data.numSplats;
        const colourOf = gradedColour(splat);
        const rgba = [0, 0, 0, 1];
        const opacity = data.getProp('opacity') as Float32Array;
        const { velocityTime: vt, falloff } = motion;
        const { lo, hi } = rowWindows(motion, n);

        // each frame's mean colour, over a sample of what is drawn there
        const acc = new Float64Array(F * 3);
        const W = new Float64Array(F);
        const stride = Math.max(1, Math.ceil(rows.length / 300000));
        const span = (r: number, share: number) => {
            const [a, b] = lifeOf(vt[r * 4 + 3], falloff[r], lo[r], hi[r], share);
            return [Math.max(0, Math.ceil(a * F - 1e-6)), Math.min(F - 1, Math.floor(b * F + 1e-6))];
        };
        for (let k = 0; k < rows.length; k += stride) {
            const r = rows[k];
            const [k0, k1] = span(r, ALPHA_MIN);
            if (k0 > k1) continue;
            colourOf(r, rgba);
            const peak = (opacity ? sigmoid(opacity[r]) : 1) * rgba[3];
            const tc = vt[r * 4 + 3];
            const f = falloff[r];
            const c0 = Math.max(0, rgba[0]);
            const c1 = Math.max(0, rgba[1]);
            const c2 = Math.max(0, rgba[2]);
            for (let fr = k0; fr <= k1; ++fr) {
                const dt = fr / F - tc;
                const w = peak * Math.exp(-f * dt * dt);
                W[fr] += w;
                acc[fr * 3] += w * c0;
                acc[fr * 3 + 1] += w * c1;
                acc[fr * 3 + 2] += w * c2;
            }
        }

        // the mean per frame, and what it is taken to
        const mean = new Float64Array(F * 3);
        const seen = new Uint8Array(F);
        for (let fr = 0; fr < F; ++fr) {
            if (!(W[fr] > 0)) continue;
            seen[fr] = 1;
            for (let c = 0; c < 3; ++c) mean[fr * 3 + c] = acc[fr * 3 + c] / W[fr];
        }
        const luma = (fr: number) => 0.2126 * mean[fr * 3] + 0.7152 * mean[fr * 3 + 1] + 0.0722 * mean[fr * 3 + 2];
        const target = (fr: number, c: number) => {
            let sum = 0;
            let m = 0;
            const w = Math.round(this.window);
            const from = w > 0 ? Math.max(0, fr - w) : 0;
            const to = w > 0 ? Math.min(F - 1, fr + w) : F - 1;
            for (let j = from; j <= to; ++j) {
                if (!seen[j]) continue;
                sum += c < 0 ? luma(j) : mean[j * 3 + c];
                m++;
            }
            return m ? sum / m : 0;
        };

        // per frame and channel, the log2 gain
        const s = Math.max(0, this.strength);
        const logGain = new Float64Array(F * 3);
        for (let fr = 0; fr < F; ++fr) {
            if (!seen[fr]) continue;
            for (let c = 0; c < 3; ++c) {
                const want = this.balance ? target(fr, c) : target(fr, -1);
                const have = this.balance ? mean[fr * 3 + c] : luma(fr);
                const g = have > 1e-6 && want > 1e-6 ? Math.log2(want / have) : 0;
                logGain[fr * 3 + c] = s * Math.min(2, Math.max(-2, g));
            }
        }
        this.gains = Float32Array.from({ length: F }, (_, fr) => 2 ** ((logGain[fr * 3] + logGain[fr * 3 + 1] + logGain[fr * 3 + 2]) / 3));

        // prefix sums, so a gaussian's gain is the mean over the frames it is drawn in
        const prefix = new Float64Array((F + 1) * 3);
        for (let fr = 0; fr < F; ++fr) {
            for (let c = 0; c < 3; ++c) prefix[(fr + 1) * 3 + c] = prefix[fr * 3 + c] + logGain[fr * 3 + c];
        }

        // gains quantised to a fraction of a stop, a grade per gain there is
        const quantise = (step: number) => {
            const bucket = new Int32Array(rows.length).fill(-1);
            const index = new Map<number, number>();
            const grades: Grade[] = [];
            for (let k = 0; k < rows.length; ++k) {
                const [k0, k1] = span(rows[k], 0.5);
                if (k0 > k1) continue;
                const len = k1 - k0 + 1;
                const q = [0, 1, 2].map(c => Math.round((prefix[(k1 + 1) * 3 + c] - prefix[k0 * 3 + c]) / len / step));
                if (q[0] === 0 && q[1] === 0 && q[2] === 0) continue;
                const key = ((q[0] + 512) * 1024 + (q[1] + 512)) * 1024 + (q[2] + 512);
                let b = index.get(key);
                if (b === undefined) {
                    b = grades.length;
                    index.set(key, b);
                    grades.push(diagGrade(2 ** (q[0] * step), 2 ** (q[1] * step), 2 ** (q[2] * step)));
                }
                bucket[k] = b;
            }
            return { bucket, grades };
        };
        let plan = quantise(1 / 64);
        if (plan.grades.length > 4096) plan = quantise(1 / 16);
        return plan.grades.length ? plan : null;
    }

    fields(): FieldSpec[] {
        if (!this.splat?.motion) return [{ kind: 'note', text: 'node.look.still3d' }];
        const gains = this.gains;
        let range = 'node.look.not-applied';
        if (gains?.length) {
            const stops = Array.from(gains, g => Math.log2(g));
            range = `${Math.min(...stops).toFixed(2)} … ${Math.max(...stops).toFixed(2)} EV`;
        }
        return [
            { kind: 'slider',
                label: 'node.exposure.strength',
                value: this.strength,
                min: 0,
                max: 1,
                step: 0.05,
                apply: (v) => {
                    this.strength = v;
                },
                format: v => `${Math.round(v * 100)}%` },
            { kind: 'slider',
                label: 'node.exposure.window',
                value: this.window,
                min: 0,
                max: 60,
                step: 1,
                apply: (v) => {
                    this.window = v;
                },
                format: v => (v > 0 ? `±${v}` : 'node.exposure.all') },
            { kind: 'choice',
                label: 'node.exposure.balance',
                value: this.balance ? 'yes' : 'no',
                options: [['yes', 'node.look.yes'], ['no', 'node.look.no']],
                apply: (v) => {
                    this.balance = v === 'yes';
                } },
            { kind: 'stat', label: 'node.exposure.range', value: range, raw: !!gains?.length },
            this.scopeStat(),
            { kind: 'note', text: 'node.exposure.note' }
        ];
    }
}

/** kept as what it did, on the grade palette: see doc-looks.ts */
const exposureDrift: LookSpec = {
    kind: 'exposureDrift',
    label: 'exposure over time',
    hint: 'exposure and white balance drift between frames evened out',
    create: splat => new ExposureDriftOp(splat)
};

export { ExposureDriftOp, exposureDrift };
