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

class ColorGrade {
    private s: RGB;
    private offset: number;
    private saturation: number;
    private transparency: number;

    readonly hasTint: boolean;

    constructor(p: GradeParams) {
        const { scale, offset } = gradeTransform(p);
        this.s = scale;
        this.offset = offset;
        this.saturation = p.saturation;
        this.transparency = p.transparency;

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

    private apply(c: RGB, offset: number) {
        c.r = offset + c.r * this.s.r;
        c.g = offset + c.g * this.s.g;
        c.b = offset + c.b * this.s.b;

        const grey = c.r * 0.299 + c.g * 0.587 + c.b * 0.114;
        c.r = grey + (c.r - grey) * this.saturation;
        c.g = grey + (c.g - grey) * this.saturation;
        c.b = grey + (c.b - grey) * this.saturation;
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

export { ColorGrade, gradeTransform, dcDecode, dcEncode, sigmoid, invSigmoid, SH_C0 };
export type { GradeParams, RGB };
