import { Asset, GSplatData, Quat } from 'playcanvas';

import { validateGSplatData } from '../io';
import { Scene } from '../scene';
import { FrameData, FrameSource } from '../sequence';
import type { Splat, SplatMotion } from '../splat';
import { standsStill } from './gsv';
import { TghModel } from './tgh-model';

/**
 * A FrameSource backed by a TGH model rather than by files.
 *
 * By default the model plays on the GPU: getFrame gives one asset holding
 * every gaussian at its temporal centre, and showFrame only sets the time -
 * the vertex shader moves and fades each gaussian, and the CPU work per
 * frame is the depth sort's centres. With `gpu` off, each frame is the
 * model conditioned on the CPU and built into an asset of its own, swapped
 * in by sequence.ts like any other sequence (seconds per frame at a
 * million gaussians).
 */
class TghFrameSource implements FrameSource {
    readonly model: TghModel;
    private frames: number;
    private scene: Scene;
    readonly name: string;

    // a -Y-up capture takes the 180 degree flip about Z that the PLY import
    // path applies; a +Z-up world turns Z onto the engine's +Y instead
    private rotation: Quat;

    // the per-gaussian motion for GPU playback, built with the rest frame
    private motion: SplatMotion | null = null;

    constructor(model: TghModel, frameCount: number, scene: Scene, name: string, gpu = true) {
        this.model = model;
        this.frames = Math.max(1, Math.floor(frameCount));
        this.scene = scene;
        this.name = name;
        this.rotation = model.meta.zUp ?
            new Quat().setFromEulerAngles(-90, 0, 0) :
            new Quat().setFromEulerAngles(0, 0, 180);
        if (gpu) {
            this.showFrame = this.showFrameGpu;
        }
    }

    showFrame?: (splat: Splat, index: number) => void;

    // EasyVolcap trains frame f of N at t = f / N (frame_to_t: the range
    // plus one step), so the last frame sits one step short of t = 1
    private timeOf(index: number) {
        return index / this.frames;
    }

    // the active set changes only where a TGH segment does: the same array
    // is handed back until then, so the splat keeps its sort mapping
    private activeKey = '';
    private active: Uint32Array | null = null;

    private showFrameGpu(splat: Splat, index: number) {
        if (!splat.motion) {
            splat.setMotion(this.motion);
        }
        const t = this.timeOf(index);
        const key = Array.from(this.model.levels, len => Math.floor(t / len)).join(',');
        if (key !== this.activeKey) {
            this.activeKey = key;
            this.active = this.model.activeIndices(t);
        }
        splat.showTime(t, this.active);
    }

    get frameCount() {
        return this.frames;
    }

    // Which level each row is on, and whether it is one the GSV writer
    // would move to the static page: a global gaussian that neither moves
    // nor fades over the sequence. Worked out once, when the debug view
    // first asks.
    private levelsAndStill: { level: Int8Array, still: Uint8Array } | null = null;

    private hierarchy() {
        if (!this.levelsAndStill) {
            const level = new Int8Array(this.model.numSplats);
            const still = new Uint8Array(this.model.numSplats);
            const t = this.model.tensors.t;
            const motion = new Float32Array(11);
            for (const block of this.model.blocks()) {
                const { rows } = block;
                for (let i = 0; i < rows.length; i++) {
                    const n = rows[i];
                    level[n] = block.level;
                    if (block.level < 0) {
                        this.model.motionParams(n, motion);
                        still[n] = standsStill(motion, t[n]) ? 1 : 0;
                    }
                }
            }
            this.levelsAndStill = { level, still };
        }
        return this.levelsAndStill;
    }

    getFrame(index: number): Promise<FrameData> {
        let frame;
        if (this.showFrame) {
            const rest = this.model.restFrame();
            this.motion = {
                velocityTime: rest.velocityTime,
                falloff: rest.falloff,
                activeAt: t => this.model.activeIndices(t),
                hierarchy: () => this.hierarchy()
            };
            frame = rest;
        } else {
            frame = this.model.evalFrame(this.timeOf(index));
        }

        const { props } = frame;
        let count = frame.count;
        if (count === 0) {
            // a frame with no active gaussians still needs valid data to
            // swap in: one fully transparent point
            count = 1;
            props.forEach((_, key) => props.set(key, new Float32Array(1)));
            props.get('opacity').fill(-20);
            props.get('scale_0').fill(-20);
            props.get('scale_1').fill(-20);
            props.get('scale_2').fill(-20);
            props.get('rot_0').fill(1);
        }

        const properties = [...props.entries()].map(([name, storage]) => ({
            type: 'float',
            name,
            storage,
            byteSize: 4
        }));

        const gsplatData = new GSplatData([{
            name: 'vertex',
            count,
            properties
        }]);
        validateGSplatData(gsplatData);

        const asset = this.scene.assetLoader.createGSplatAsset(gsplatData, this.name);
        return Promise.resolve({ asset, rotation: this.rotation });
    }

    destroy() {}
}

export { TghFrameSource };
