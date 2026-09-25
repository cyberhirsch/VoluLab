/**
 * Ambient light: where it comes from and how it is reduced.
 *
 * An ambient light is either a flat colour or an environment - an
 * equirectangular HDRI or photo. Either way the relighter only ever sees
 * nine spherical-harmonic coefficients per channel: the irradiance the
 * environment delivers to a surface facing any given way. That is all a
 * diffuse surface can tell apart, which is why nine numbers suffice where
 * the image had millions.
 *
 * The environment itself is kept as a small map, 32 x 16. Irradiance is so
 * smooth that nothing a larger map adds survives the projection, and a map
 * this size can live in the project file - so turning the environment later
 * re-projects from the map rather than needing the original image. A bright
 * sun in the HDRI loses nothing by it: pixels are averaged, not sampled, so
 * its energy lands in the texel it fell in.
 *
 * Conventions. Y is up. The image's top row is straight up, its bottom row
 * straight down, and its horizontal centre faces -Z; `rotation` turns the
 * environment about the up axis, in degrees. Colours are linear.
 */

const ENV_WIDTH = 32;
const ENV_HEIGHT = 16;

type Environment = {
    /** what it was loaded from, for display */
    name: string;
    width: number;
    height: number;
    /**
     * linear rgb, rows from the top, normalised so the mean luminance over
     * the sphere is 1 - an environment's own exposure is not the user's
     * concern, the light's intensity is
     */
    data: number[];
};

/** solid angle of a texel in row `v` of a width x height equirect map */
const texelSolidAngle = (v: number, width: number, height: number) => {
    const theta = Math.PI * (v + 0.5) / height;
    return (2 * Math.PI / width) * (Math.PI / height) * Math.sin(theta);
};

/** Scale so the mean luminance over the sphere is 1; a black map is left alone. */
const normalise = (env: Environment): Environment => {
    const { width, height, data } = env;
    let sum = 0;
    for (let v = 0; v < height; ++v) {
        const dw = texelSolidAngle(v, width, height);
        for (let u = 0; u < width; ++u) {
            const o = (v * width + u) * 3;
            sum += (0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2]) * dw;
        }
    }
    const mean = sum / (4 * Math.PI);
    if (mean > 1e-12) {
        for (let i = 0; i < data.length; ++i) {
            data[i] /= mean;
        }
    }
    return env;
};

/** A small map being filled: sums and counts per texel. */
class EnvironmentBins {
    sums = new Float64Array(ENV_WIDTH * ENV_HEIGHT * 3);
    counts = new Float64Array(ENV_WIDTH * ENV_HEIGHT);

    constructor(private sourceWidth: number, private sourceHeight: number) {}

    add(x: number, y: number, r: number, g: number, b: number) {
        const tx = Math.min(ENV_WIDTH - 1, Math.floor(x * ENV_WIDTH / this.sourceWidth));
        const ty = Math.min(ENV_HEIGHT - 1, Math.floor(y * ENV_HEIGHT / this.sourceHeight));
        const t = ty * ENV_WIDTH + tx;
        this.sums[t * 3] += r;
        this.sums[t * 3 + 1] += g;
        this.sums[t * 3 + 2] += b;
        this.counts[t]++;
    }

    finish(name: string): Environment {
        const data = new Array<number>(ENV_WIDTH * ENV_HEIGHT * 3).fill(0);
        for (let t = 0; t < ENV_WIDTH * ENV_HEIGHT; ++t) {
            const n = Math.max(1, this.counts[t]);
            for (let c = 0; c < 3; ++c) {
                const v = this.sums[t * 3 + c] / n;
                data[t * 3 + c] = isFinite(v) && v > 0 ? v : 0;
            }
        }
        return normalise({ name, width: ENV_WIDTH, height: ENV_HEIGHT, data });
    }
}

/**
 * Radiance .hdr, the RGBE format most HDRIs ship in. Decoded scanline by
 * scanline straight into the small map, so an 8K image never exists as
 * floats - it would be the better part of half a gigabyte.
 */
const decodeHdr = (buffer: ArrayBuffer, name: string): Environment => {
    const bytes = new Uint8Array(buffer);
    let pos = 0;

    const readLine = () => {
        let line = '';
        while (pos < bytes.length && bytes[pos] !== 0x0a) {
            line += String.fromCharCode(bytes[pos++]);
        }
        pos++;
        return line;
    };

    if (!readLine().startsWith('#?')) {
        throw new Error('not a Radiance HDR file');
    }
    for (;;) {
        if (pos >= bytes.length) throw new Error('HDR header has no end');
        const line = readLine();
        if (line === '') break;
        if (line.startsWith('FORMAT=') && line.slice(7).trim() !== '32-bit_rle_rgbe') {
            throw new Error(`unsupported HDR format ${line.slice(7)}`);
        }
    }

    const size = readLine().match(/^-Y\s+(\d+)\s+\+X\s+(\d+)$/);
    if (!size) throw new Error('unsupported HDR orientation');
    const height = parseInt(size[1], 10);
    const width = parseInt(size[2], 10);
    if (!(width > 0 && height > 0)) throw new Error('empty HDR image');

    const bins = new EnvironmentBins(width, height);
    const scan = new Uint8Array(width * 4);

    for (let y = 0; y < height; ++y) {
        if (pos + 4 > bytes.length) throw new Error('HDR image is truncated');

        const rle = width >= 8 && width < 32768 &&
            bytes[pos] === 2 && bytes[pos + 1] === 2 && ((bytes[pos + 2] << 8) | bytes[pos + 3]) === width;

        if (rle) {
            // one run-length stream per component, one after another
            pos += 4;
            for (let c = 0; c < 4; ++c) {
                let x = 0;
                while (x < width) {
                    if (pos >= bytes.length) throw new Error('HDR image is truncated');
                    let count = bytes[pos++];
                    if (count > 128) {
                        count -= 128;
                        if (x + count > width) throw new Error('bad HDR run');
                        const value = bytes[pos++];
                        for (let k = 0; k < count; ++k) scan[(x++) * 4 + c] = value;
                    } else {
                        if (count === 0 || x + count > width) throw new Error('bad HDR run');
                        for (let k = 0; k < count; ++k) scan[(x++) * 4 + c] = bytes[pos++];
                    }
                }
            }
        } else {
            // flat scanline
            if (pos + width * 4 > bytes.length) throw new Error('HDR image is truncated');
            scan.set(bytes.subarray(pos, pos + width * 4));
            pos += width * 4;
        }

        for (let x = 0; x < width; ++x) {
            const e = scan[x * 4 + 3];
            if (e === 0) {
                bins.add(x, y, 0, 0, 0);
            } else {
                const f = Math.pow(2, e - 136);
                bins.add(x, y, scan[x * 4] * f, scan[x * 4 + 1] * f, scan[x * 4 + 2] * f);
            }
        }
    }

    return bins.finish(name);
};

const srgbToLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

/**
 * A photo - PNG, JPEG, WebP - taken as an equirectangular environment. The
 * browser decodes it at a modest size first; the averaging does the rest.
 * Low dynamic range, so a sun in it is clipped: fine for a sky, weak for
 * sunlight, which is what a sun light is for.
 */
const decodeImage = async (blob: Blob, name: string): Promise<Environment> => {
    const bitmap = await createImageBitmap(blob);
    const width = Math.min(bitmap.width, 512);
    const height = Math.min(bitmap.height, 256);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) {
        bitmap.close();
        throw new Error('no 2D canvas to decode the image with');
    }
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const pixels = context.getImageData(0, 0, width, height).data;

    const bins = new EnvironmentBins(width, height);
    for (let y = 0; y < height; ++y) {
        for (let x = 0; x < width; ++x) {
            const o = (y * width + x) * 4;
            bins.add(x, y,
                srgbToLinear(pixels[o] / 255),
                srgbToLinear(pixels[o + 1] / 255),
                srgbToLinear(pixels[o + 2] / 255));
        }
    }
    return bins.finish(name);
};

/** Any supported file to an environment; throws with a readable reason otherwise. */
const loadEnvironment = async (file: File): Promise<Environment> => {
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.hdr') || lower.endsWith('.pic')) {
        return decodeHdr(await file.arrayBuffer(), file.name);
    }
    if (lower.endsWith('.exr')) {
        throw new Error('EXR is not supported yet - save the HDRI as .hdr');
    }
    return decodeImage(file, file.name);
};

/** A stored environment back from a project, or null if it does not add up. */
const validEnvironment = (env: any): Environment | null => {
    if (!env || !Array.isArray(env.data)) return null;
    const width = env.width | 0;
    const height = env.height | 0;
    if (width <= 0 || height <= 0 || env.data.length !== width * height * 3) return null;
    return {
        name: String(env.name ?? 'environment'),
        width,
        height,
        data: env.data.map((v: any) => (isFinite(v) && v > 0 ? Number(v) : 0))
    };
};

// ---------------------------------------------------------------------------
// Spherical harmonics, bands 0 to 2, real, orthonormal, Y up. The lighting
// kernel evaluates exactly these nine functions - the two sides only have to
// agree with each other, not with any textbook's axis order.
// ---------------------------------------------------------------------------

const SH_COEFFICIENTS = 9;

const shBasis = (x: number, y: number, z: number, out: Float64Array) => {
    out[0] = 0.282095;
    out[1] = 0.488603 * x;
    out[2] = 0.488603 * y;
    out[3] = 0.488603 * z;
    out[4] = 1.092548 * x * z;
    out[5] = 1.092548 * x * y;
    out[6] = 1.092548 * y * z;
    out[7] = 0.315392 * (3 * y * y - 1);
    out[8] = 0.546274 * (x * x - z * z);
};

// Radiance to irradiance is a convolution with the cosine lobe, which in SH
// is a per-band scale (Ramamoorthi and Hanrahan): pi, 2pi/3, pi/4. Divided
// by pi, so a uniform environment of radiance 1 gives a surface a factor
// of exactly 1 - "as bright as the capture already was".
const IRRADIANCE_BAND = [1, 2 / 3, 2 / 3, 2 / 3, 1 / 4, 1 / 4, 1 / 4, 1 / 4, 1 / 4];

const tmpBasis = new Float64Array(SH_COEFFICIENTS);

/**
 * Add one ambient light's irradiance coefficients into `out` (nine rgb
 * triples, as `out[k * 4 + c]` so they drop straight into vec4s).
 */
const addAmbientSH = (
    out: Float32Array | Float64Array,
    offset: number,
    color: number[],
    intensity: number,
    environment: Environment | null,
    rotationDegrees: number
) => {
    const scale = [color[0] * intensity, color[1] * intensity, color[2] * intensity];

    if (!environment) {
        // a flat colour: only the constant term, sized so the factor is the
        // colour times the intensity whichever way a surface faces
        for (let c = 0; c < 3; ++c) {
            out[offset + c] += scale[c] / 0.282095;
        }
        return;
    }

    const { width, height, data } = environment;
    const rotation = rotationDegrees * Math.PI / 180;
    const acc = new Float64Array(SH_COEFFICIENTS * 3);

    for (let v = 0; v < height; ++v) {
        const theta = Math.PI * (v + 0.5) / height;
        const sinTheta = Math.sin(theta);
        const y = Math.cos(theta);
        const dw = texelSolidAngle(v, width, height);
        for (let u = 0; u < width; ++u) {
            const phi = 2 * Math.PI * (u + 0.5) / width - Math.PI + rotation;
            shBasis(sinTheta * Math.sin(phi), y, -sinTheta * Math.cos(phi), tmpBasis);
            const o = (v * width + u) * 3;
            for (let k = 0; k < SH_COEFFICIENTS; ++k) {
                const w = tmpBasis[k] * dw;
                acc[k * 3] += data[o] * w;
                acc[k * 3 + 1] += data[o + 1] * w;
                acc[k * 3 + 2] += data[o + 2] * w;
            }
        }
    }

    for (let k = 0; k < SH_COEFFICIENTS; ++k) {
        for (let c = 0; c < 3; ++c) {
            out[offset + k * 4 + c] += acc[k * 3 + c] * IRRADIANCE_BAND[k] * scale[c];
        }
    }
};

/** The factor the coefficients give a surface facing (x, y, z) - the kernel's twin, for tests. */
const evalAmbientSH = (sh: ArrayLike<number>, offset: number, x: number, y: number, z: number) => {
    shBasis(x, y, z, tmpBasis);
    const out = [0, 0, 0];
    for (let k = 0; k < SH_COEFFICIENTS; ++k) {
        for (let c = 0; c < 3; ++c) {
            out[c] += sh[offset + k * 4 + c] * tmpBasis[k];
        }
    }
    return out;
};

export {
    ENV_WIDTH,
    ENV_HEIGHT,
    SH_COEFFICIENTS,
    type Environment,
    decodeHdr,
    loadEnvironment,
    validEnvironment,
    addAmbientSH,
    evalAmbientSH
};
