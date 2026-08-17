import {
    ADDRESS_CLAMP_TO_EDGE,
    PIXELFORMAT_RGBA32F,
    GraphicsDevice,
    Texture
} from 'playcanvas';

/**
 * A palette of colour grades, one per slot, indexed per gaussian.
 *
 * The same shape as TransformPalette and for the same reason: a gaussian
 * carries a small index rather than its own copy of the thing, and the thing
 * itself lives once in a texture the shaders read.
 *
 * A grade is a 3x3 matrix, a translation and an alpha scale - see
 * `gradeMatrix` in color-grade.ts for why the eight parameters collapse to
 * exactly that. Four texels hold it:
 *
 *   texel 0   column 0 of the matrix, translation.r in w
 *   texel 1   column 1 of the matrix, translation.g in w
 *   texel 2   column 2 of the matrix, translation.b in w
 *   texel 3   alpha scale in x, rest unused
 *
 * Columns rather than rows, because that is how GLSL reads a mat3 and the
 * matrix is not symmetric.
 *
 * The translation is a vector rather than the single number a freshly built
 * grade needs. A grade on its own offsets all three channels alike, so one
 * number would do - but composing two does not preserve that. Applying `b`
 * to `a`'s offset gives `B·(a.t·1)`, and `B·1` is only a grey when `b` has no
 * tint, temperature or saturation. Storing three numbers is the difference
 * between grades that stack and grades that stack incorrectly.
 *
 * Slot 0 is the object's own grade, which every gaussian points at until a
 * colour node moves it somewhere else. That keeps an ungraded object at one
 * slot and one index value, and it is why the shader can take an early exit
 * on index 0.
 */

const TEXELS_PER_GRADE = 4;

// grades per row: 512, the same as the transform palette
const width = 512 * TEXELS_PER_GRADE;

export type Grade = {
    /** column-major 3x3: m[col * 3 + row] */
    m: number[];
    /** per-channel translation */
    t: [number, number, number];
    /** alpha multiplier */
    alpha: number;
};

export const identityGrade = (): Grade => ({
    m: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    t: [0, 0, 0],
    alpha: 1
});

/** Multiply a column-major 3x3 by a vector. */
const mulVec = (m: number[], v: [number, number, number]): [number, number, number] => [
    m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    m[2] * v[0] + m[5] * v[1] + m[8] * v[2]
];

/**
 * Apply `b` after `a`: the grade that does what running one and then the
 * other would.
 *
 * Composition is the whole reason grades are stored as matrices. A second
 * colour node over a region an earlier one already graded has to carry both,
 * and the eight-parameter form cannot express the result.
 *
 *   (b ∘ a)(c) = B·(A·c + a.t) + b.t = (B·A)·c + B·a.t + b.t
 */
export const composeGrades = (a: Grade, b: Grade): Grade => {
    const m: number[] = new Array(9);
    for (let col = 0; col < 3; ++col) {
        for (let row = 0; row < 3; ++row) {
            let sum = 0;
            for (let k = 0; k < 3; ++k) {
                sum += b.m[k * 3 + row] * a.m[col * 3 + k];
            }
            m[col * 3 + row] = sum;
        }
    }

    const bt = mulVec(b.m, a.t);
    return {
        m,
        t: [bt[0] + b.t[0], bt[1] + b.t[1], bt[2] + b.t[2]],
        alpha: a.alpha * b.alpha
    };
};

class GradePalette {
    getGrade: (index: number) => Grade;
    setGrade: (index: number, grade: Grade) => void;
    alloc: (num?: number) => number;
    free: (num?: number) => void;
    texture: Texture;

    constructor(device: GraphicsDevice, initialSize = 1024) {
        let texture: Texture;
        let data: Float32Array;

        const realloc = (w: number, h: number) => {
            const next = new Texture(device, {
                name: 'gradePalette',
                width: w,
                height: h,
                format: PIXELFORMAT_RGBA32F,
                mipmaps: false,
                addressU: ADDRESS_CLAMP_TO_EDGE,
                addressV: ADDRESS_CLAMP_TO_EDGE
            });

            const nextData = next.lock() as Float32Array;
            next.unlock();

            if (texture) {
                nextData.set(data);
                texture.destroy();
            }

            texture = next;
            data = nextData;
        };

        const stride = TEXELS_PER_GRADE * 4;

        this.getGrade = (index: number): Grade => {
            const o = index * stride;
            return {
                m: [
                    data[o], data[o + 1], data[o + 2],
                    data[o + 4], data[o + 5], data[o + 6],
                    data[o + 8], data[o + 9], data[o + 10]
                ],
                t: [data[o + 3], data[o + 7], data[o + 11]],
                alpha: data[o + 12]
            };
        };

        this.setGrade = (index: number, grade: Grade) => {
            const o = index * stride;
            for (let col = 0; col < 3; ++col) {
                data[o + col * 4] = grade.m[col * 3];
                data[o + col * 4 + 1] = grade.m[col * 3 + 1];
                data[o + col * 4 + 2] = grade.m[col * 3 + 2];
                data[o + col * 4 + 3] = grade.t[col];
            }
            data[o + 12] = grade.alpha;
            data[o + 13] = 0;
            data[o + 14] = 0;
            data[o + 15] = 0;

            texture.upload();
        };

        // slot 0 is the object's own grade
        let nextIdx = 1;

        this.alloc = (num = 1) => {
            const result = nextIdx;
            while (nextIdx + num > data.length / stride) {
                realloc(width, texture.height * 2);
            }
            nextIdx += num;
            return result;
        };

        this.free = (num = 1) => {
            nextIdx -= num;
        };

        Object.defineProperty(this, 'texture', {
            get() {
                return texture;
            }
        });

        realloc(width, Math.ceil(initialSize / (width / TEXELS_PER_GRADE)));
        this.setGrade(0, identityGrade());
    }
}

export { GradePalette };
