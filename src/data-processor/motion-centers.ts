import {
    ADDRESS_CLAMP_TO_EDGE,
    FILTER_NEAREST,
    PIXELFORMAT_RGBA32U,
    GraphicsDevice,
    Texture
} from 'playcanvas';

import { Splat } from '../splat';

// the splat shader drops a gaussian faded below 1/255: dt^2 * falloff > ln 255
const FADE_CUT = Math.log(255);

/**
 * The gaussians of a 4D model in the active set at `time`. The set shown is
 * kept by the splat; another time asks the model, or, if it cannot say,
 * falls back to the shown set. Null means all of them.
 */
const activeAt = (splat: Splat, time: number): Uint32Array | null => {
    if (time === splat.motionTime) {
        return splat.motionActive;
    }
    return splat.motion.activeAt ? splat.motion.activeAt(time) : splat.motionActive;
};

/**
 * 1 for each gaussian of a 4D model drawn at `time`: in the active set then
 * and not faded out. Deletion and hiding are left to the caller.
 */
const drawnAt = (splat: Splat, time: number): Uint8Array => {
    const numSplats = splat.splatData.numSplats;
    const vt = splat.motion.velocityTime;
    const { falloff } = splat.motion;
    const active = activeAt(splat, time);

    const drawn = new Uint8Array(numSplats);
    if (active) {
        for (let i = 0; i < active.length; i++) {
            if (active[i] < numSplats) drawn[active[i]] = 1;
        }
    } else {
        drawn.fill(1);
    }

    for (let i = 0; i < numSplats; i++) {
        const dt = time - vt[i * 4 + 3];
        if (dt * dt * falloff[i] > FADE_CUT) {
            drawn[i] = 0;
        }
    }
    return drawn;
};

/** Clear the entries of a per-gaussian mask that are not drawn at `time`. */
const dropAbsent = (splat: Splat, time: number, data: Uint8Array) => {
    const drawn = drawnAt(splat, time);
    for (let i = 0; i < drawn.length; i++) {
        if (!drawn[i]) data[i] = 0;
    }
};

/**
 * The centres of a 4D model at `time`, 4 floats per gaussian (xyz, w left
 * as it is). With `hide`, a gaussian not drawn then goes to infinity, which
 * the bound shader skips and no hit test catches.
 */
const moveCenters = (splat: Splat, time: number, out: Float32Array, hide: boolean) => {
    const { splatData } = splat;
    const x = splatData.getProp('x') as Float32Array;
    const y = splatData.getProp('y') as Float32Array;
    const z = splatData.getProp('z') as Float32Array;
    const vt = splat.motion.velocityTime;
    const drawn = hide ? drawnAt(splat, time) : null;
    for (let i = 0; i < splatData.numSplats; i++) {
        if (drawn && !drawn[i]) {
            out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = Infinity;
            continue;
        }
        const dt = time - vt[i * 4 + 3];
        out[i * 4] = x[i] + vt[i * 4] * dt;
        out[i * 4 + 1] = y[i] + vt[i * 4 + 1] * dt;
        out[i * 4 + 2] = z[i] + vt[i * 4 + 2] * dt;
    }
};

/**
 * Each centre of a 4D model where it is at the first (end 0) or last (end 1)
 * moment it is drawn in the sequence. Motion is linear, so the two ends
 * between them bound everywhere a gaussian goes. One never drawn goes to
 * infinity. The active set is not consulted: it only narrows that window.
 */
const extentCenters = (splat: Splat, end: 0 | 1, out: Float32Array) => {
    const { splatData } = splat;
    const x = splatData.getProp('x') as Float32Array;
    const y = splatData.getProp('y') as Float32Array;
    const z = splatData.getProp('z') as Float32Array;
    const vt = splat.motion.velocityTime;
    const { falloff } = splat.motion;
    for (let i = 0; i < splatData.numSplats; i++) {
        const tc = vt[i * 4 + 3];
        const reach = falloff[i] > 0 ? Math.sqrt(FADE_CUT / falloff[i]) : Infinity;
        const lo = Math.max(0, tc - reach);
        const hi = Math.min(1, tc + reach);
        if (!(lo <= hi)) {
            out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = Infinity;
            continue;
        }
        const dt = (end === 0 ? lo : hi) - tc;
        out[i * 4] = x[i] + vt[i * 4] * dt;
        out[i * 4 + 1] = y[i] + vt[i * 4 + 1] * dt;
        out[i * 4 + 2] = z[i] + vt[i * 4 + 2] * dt;
    }
};

type Slot = {
    texture: Texture | null;
    key: unknown[];
};

/**
 * Stand-ins for a 4D model's transformA, whose centres are the temporal
 * centres: the same layout, the rotation in w copied over, the centres moved.
 * The GPU passes that read centres - intersect, select by range, bounds -
 * take one of these for a model with motion. Each is kept with what it was
 * made from, so asking again for the frame shown costs no CPU pass.
 */
class MotionCenters {
    private device: GraphicsDevice;
    private shown: Slot = { texture: null, key: [] };
    private ends: Slot[] = [{ texture: null, key: [] }, { texture: null, key: [] }];

    constructor(device: GraphicsDevice) {
        this.device = device;
    }

    private fill(slot: Slot, splat: Splat, key: unknown[], write: (out: Float32Array) => void) {
        const like = (splat.entity.gsplat.instance.resource as any).getTexture('transformA') as Texture;
        const fullKey = [splat, like, splat.motion, ...key];
        if (slot.texture && slot.key.length === fullKey.length && slot.key.every((k, i) => k === fullKey[i])) {
            return slot.texture;
        }

        const { width, height } = like;
        if (!slot.texture || slot.texture.width !== width || slot.texture.height !== height) {
            slot.texture?.destroy();
            slot.texture = new Texture(this.device, {
                name: 'motionCenters',
                width,
                height,
                format: PIXELFORMAT_RGBA32U,
                mipmaps: false,
                minFilter: FILTER_NEAREST,
                magFilter: FILTER_NEAREST,
                addressU: ADDRESS_CLAMP_TO_EDGE,
                addressV: ADDRESS_CLAMP_TO_EDGE
            });
        }

        const data = slot.texture.lock() as Uint32Array;
        // the resource keeps its upload: w holds the rotation, which the
        // value shader reads
        const source = like.getSource() as unknown as Uint32Array;
        if (source && source.length === data.length) {
            data.set(source);
        }
        write(new Float32Array(data.buffer));
        slot.texture.unlock();
        slot.key = fullKey;
        return slot.texture;
    }

    /** Centres at `time`; a gaussian not drawn then is at infinity. */
    at(splat: Splat, time: number) {
        return this.fill(this.shown, splat, [time, activeAt(splat, time)], out => moveCenters(splat, time, out, true));
    }

    /** Centres at the first (0) or last (1) moment each is drawn. */
    extent(splat: Splat, end: 0 | 1) {
        return this.fill(this.ends[end], splat, [], out => extentCenters(splat, end, out));
    }
}

export { MotionCenters, activeAt, drawnAt, dropAbsent, moveCenters };
