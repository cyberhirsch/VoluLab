import { Asset, GSplatData, Quat } from 'playcanvas';

import { validateGSplatData } from '../io';
import { Scene } from '../scene';
import { FrameData, FrameSource } from '../sequence';
import { TghModel } from './tgh-model';

/**
 * A FrameSource backed by a TGH model rather than by files: each frame is
 * the model conditioned at that frame's time, built into a gsplat asset on
 * demand. The persistent-splat swap and the edit replay in sequence.ts work
 * on it unchanged - to the rest of the app this is just another sequence.
 */
class TghFrameSource implements FrameSource {
    private model: TghModel;
    private frames: number;
    private scene: Scene;
    private name: string;

    // splat files are Z-up like the model, so frames take the same 180
    // degree flip about Z that the PLY import path applies
    private rotation = new Quat().setFromEulerAngles(0, 0, 180);

    constructor(model: TghModel, frameCount: number, scene: Scene, name: string) {
        this.model = model;
        this.frames = Math.max(1, Math.floor(frameCount));
        this.scene = scene;
        this.name = name;
    }

    get frameCount() {
        return this.frames;
    }

    getFrame(index: number): Promise<FrameData> {
        // the training code samples frame f of N at t = f / (N - 1)
        const t = index / Math.max(this.frames - 1, 1);
        const frame = this.model.evalFrame(t);

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
