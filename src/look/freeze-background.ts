import { type FieldSpec, type LookSpec } from './fields';
import { framesOf, stillFlags } from './measure';
import { MotionEditOp } from './motion-edit';
import { Splat, type SplatMotion } from '../splat';

type FreezeMode = 'frame' | 'sequence';

/**
 * Freeze background: the still part held. Set to a frame, it is the still
 * gaussians as they are at that frame of the model - those drawn there at
 * half their peak or more stay, at their peak, for the whole sequence, and
 * the rest are never drawn. Set to the sequence, every still gaussian stays
 * for the whole sequence. Either way the background stops flickering, and
 * the sort worker takes what is held as still rows, sorted once per view.
 * What moves is left as it is.
 */
class FreezeBackgroundOp extends MotionEditOp {
    name = 'freezeBackground';
    mode: FreezeMode;
    frame: number;
    still: number;

    constructor(splat: Splat, settings: Partial<{ mode: FreezeMode, frame: number, still: number }> = {}) {
        super(splat);
        this.mode = settings.mode === 'sequence' ? 'sequence' : 'frame';
        this.frame = settings.frame ?? 0;
        this.still = settings.still ?? 0.1;
    }

    get settings() {
        return { mode: this.mode, frame: this.frame, still: this.still };
    }

    get sourceLabel() {
        return this.mode === 'frame' ? `frame ${this.frame}` : 'sequence';
    }

    protected edit(splat: Splat, motion: SplatMotion, rows: Uint32Array, vt: Float32Array, falloff: Float32Array) {
        const flags = stillFlags(splat, this.still, false);
        const frames = framesOf(splat);
        const at = Math.min(frames - 1, Math.max(0, Math.round(this.frame))) / frames;
        let changed = 0;
        for (let k = 0; k < rows.length; ++k) {
            const r = rows[k];
            if (!flags[r]) continue;
            const o = r * 4;
            const shown = this.mode === 'sequence' || Math.exp(-falloff[r] * (at - vt[o + 3]) ** 2) >= 0.5;
            if (shown) {
                // standing where it is at its temporal centre, at its peak
                vt[o] = 0;
                vt[o + 1] = 0;
                vt[o + 2] = 0;
                falloff[r] = 0;
            } else {
                // centred outside the sequence and gone a hair from its centre
                vt[o + 3] = -1;
                falloff[r] = 1e6;
            }
            changed++;
        }
        return changed;
    }

    fields(): FieldSpec[] {
        return [
            { kind: 'choice',
                label: 'node.freezeBg.mode',
                value: this.mode,
                options: [['frame', 'node.freezeBg.frame-mode'], ['sequence', 'node.freezeBg.sequence']],
                apply: (v) => {
                    this.mode = v as FreezeMode;
                } },
            ...(this.mode === 'frame' ? [{ kind: 'number',
                label: 'node.freezeBg.frame',
                value: this.frame,
                step: 1,
                neutral: 0,
                apply: (v: number) => {
                    this.frame = Math.max(0, Math.round(v));
                } } as FieldSpec] : []),
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
            ...this.common('node.freezeBg.note')
        ];
    }
}

const freezeBackground: LookSpec = {
    kind: 'freezeBackground',
    label: 'freeze background',
    hint: 'the still part held at one frame',
    // held at the frame of the model shown now
    create: (splat) => {
        const frames = framesOf(splat);
        return new FreezeBackgroundOp(splat, { frame: Math.min(frames - 1, Math.round(splat.motionTime * frames)) });
    },
    restore: (splat, settings) => new FreezeBackgroundOp(splat, settings ?? {}),
    stored: true
};

export { FreezeBackgroundOp, freezeBackground };
