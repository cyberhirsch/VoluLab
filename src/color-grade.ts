import { Color } from 'playcanvas';

const SH_C0 = 0.28209479177387814;

const dcDecode = (v: number) => v * SH_C0 + 0.5;
const dcEncode = (v: number) => (v - 0.5) / SH_C0;

const sigmoid = (v: number) => 1 / (1 + Math.exp(-v));
const invSigmoid = (v: number) => ((v <= 0) ? -400 : ((v >= 1) ? 400 : -Math.log(1 / v - 1)));

type GradeParams = {
    tintClr: Color,
    temperature: number,
    saturation: number,
    /** photographic stops: +1 doubles, -1 halves */
    exposure?: number,
    brightness: number,
    blackPoint: number,
    whitePoint: number,
    transparency: number
};

type RGB = { r: number, g: number, b: number };

/** the smallest gap allowed between the black and white points */
const MIN_RANGE = 1e-3;

/**
 * What the grade reduces to: a per-channel scale and a shared offset.
 *
 * The same two numbers are needed by the renderer, the histogram, the range
 * selector and the cpu path, and they were worked out separately in each -
 * four copies of one formula, which is four chances for one of them to be
 * left behind. Exposure is applied here, so it reaches all of them.
 *
 * Order matters: exposure multiplies before the black point is subtracted, so
 * it behaves like exposing the shot rather than lifting the result.
 */
const gradeTransform = (p: GradeParams) => {
    const gain = Math.pow(2, p.exposure ?? 0);
    // white and black are independent sliders with nothing stopping them
    // meeting or crossing, which divides by zero or inverts the image
    const range = Math.max(MIN_RANGE, p.whitePoint - p.blackPoint);
    const scale = gain / range;

    return {
        offset: -p.blackPoint + p.brightness,
        scale: {
            r: scale * p.tintClr.r * (1 + p.temperature),
            g: scale * p.tintClr.g,
            b: scale * p.tintClr.b * (1 - p.temperature)
        }
    };
};

/** Rec.601 luma weights, as the saturation lerp has always used. */
const LUMA = { r: 0.299, g: 0.587, b: 0.114 };

/**
 * The whole grade as one 3x3 matrix and one translation.
 *
 * Saturation is a linear map - a lerp towards grey, which is a projection -
 * and the levels are affine, so the eight parameters collapse to exactly this
 * and nothing is lost. Two consequences, both wanted:
 *
 *  - The renderer, the histogram and the export path stop each carrying their
 *    own arrangement of scale, offset and saturation.
 *  - Two grades compose by multiplying, which the parameter form cannot
 *    express. That is what a second colour node stacking on a region an
 *    earlier one already touched will need.
 *
 * Written out: c' = sat·(s∘c) + (1-sat)·((w∘s)·c)·1 + o·1, where the offset
 * survives the saturation untouched because a grey stays put under it.
 */
const gradeMatrix = (p: GradeParams) => {
    const { scale, offset } = gradeTransform(p);
    const sat = p.saturation;
    const k = 1 - sat;

    // Column-major, because that is what GLSL means by mat3 and this array is
    // uploaded straight into one. Each column j is the input channel's
    // contribution: k*w_j*s_j spread across all three outputs, plus sat*s_j on
    // its own. The matrix is not symmetric, so the order is not cosmetic - read
    // the other way round it grades by the transpose and quietly gets it wrong.
    const col = (w: number, s: number, axis: number) => {
        const shared = k * w * s;
        return [
            shared + (axis === 0 ? sat * s : 0),
            shared + (axis === 1 ? sat * s : 0),
            shared + (axis === 2 ? sat * s : 0)
        ];
    };

    return {
        m: [
            ...col(LUMA.r, scale.r, 0),
            ...col(LUMA.g, scale.g, 1),
            ...col(LUMA.b, scale.b, 2)
        ],
        t: offset,
        alpha: p.transparency
    };
};

class ColorGrade {
    private m: number[];
    private offset: number;
    private transparency: number;

    readonly hasTint: boolean;

    constructor(p: GradeParams) {
        const grade = gradeMatrix(p);
        this.m = grade.m;
        this.offset = grade.t;
        this.transparency = grade.alpha;

        this.hasTint = (
            !p.tintClr.equals(Color.WHITE) ||
            p.temperature !== 0 ||
            p.saturation !== 1 ||
            (p.exposure ?? 0) !== 0 ||
            p.brightness !== 0 ||
            p.blackPoint !== 0 ||
            p.whitePoint !== 1
        );
    }

    // The DC term carries the translation; an SH term is a delta, so it gets
    // the linear part only. Indexed column-major, matching the array the
    // shaders are handed.
    private apply(c: RGB, offset: number) {
        const { m } = this;
        const { r, g, b } = c;
        c.r = m[0] * r + m[3] * g + m[6] * b + offset;
        c.g = m[1] * r + m[4] * g + m[7] * b + offset;
        c.b = m[2] * r + m[5] * g + m[8] * b + offset;
    }

    applyDC(c: RGB) {
        this.apply(c, this.offset);
    }

    applySH(c: RGB) {
        this.apply(c, 0);
    }

    applyOpacity(o: number): number {
        return invSigmoid(sigmoid(o) * this.transparency);
    }

    applyAlpha(o: number): number {
        return sigmoid(o) * this.transparency;
    }
}

export { ColorGrade, gradeTransform, gradeMatrix, dcDecode, dcEncode, sigmoid, invSigmoid, SH_C0 };
export type { GradeParams, RGB };
