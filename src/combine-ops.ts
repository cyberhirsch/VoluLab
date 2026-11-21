/**
 * The nodes that combine objects.
 *
 * Merge makes one object out of several (merge-build.ts). The
 * object is made before the node exists - the first build is the node's
 * reason to be - and then again whenever what it is made from has changed
 * by the time the node applies: an edit upstream of an input, a time node
 * on one, a layer switched off. So the merged object follows its inputs
 * the way a delete node follows its selection, and stays the same object
 * for the nodes after it to stand on. Undo and bypass take it out and
 * show the inputs again.
 */

import { Asset } from 'playcanvas';

import { buildMerge, mergeSignature, type MergeBuildOptions, type MergeBuilt, type PartCache, type ShMode } from './merge-build';
import { Scene } from './scene';
import { Splat, type SplatMotion } from './splat';

/** What a combining node asks of the editor when it builds. */
type CombineContext = {
    /** the timeline's frame rate and length */
    rate: () => number;
    timelineFrames: () => number;
    frame: () => number;
    /** what the layers say about an input: whether it is in, and its opacity */
    layer: (splat: Splat) => { included: boolean, opacity: number };
    /** a gsplat asset of this data */
    asset: (built: MergeBuilt, name: string) => Asset;
};

type MergeSettings = {
    sh: ShMode;
    /** per input, the name it goes by in the merge; '' for the input's own */
    names: string[];
};

// a motion that moves nothing: for an object that had one and is built still
const stillMotion = (count: number): SplatMotion => ({
    velocityTime: new Float32Array(Math.max(1, count) * 4),
    falloff: new Float32Array(Math.max(1, count))
});

/**
 * Several inputs, one object. The base of the nodes that make one object
 * of others; what a kind adds is which of the inputs a frame shows.
 */
abstract class CombineOp {
    abstract name: string;

    scene: Scene;
    /** what this node consumes - the graph draws an edge from each */
    inputs: Splat[];
    /** what it produces */
    output: Splat;
    bypassed?: boolean;

    /** what the last build came to, for the node pane */
    built: { rows: number[], copies: number[], frames: number, bands: number, total: number } | null = null;

    protected context: CombineContext;
    private cache: PartCache = new Map();
    // what the output's data was made from
    private signature = '';
    private wasVisible: boolean[] = [];

    constructor(scene: Scene, inputs: Splat[], output: Splat, context: CombineContext) {
        this.scene = scene;
        this.inputs = inputs;
        this.output = output;
        this.context = context;
    }

    /** what the graph writes under the node's title */
    get sourceLabel() {
        return `${this.inputs?.length ?? 0} inputs`;
    }

    get applied() {
        return !!this.output?.scene;
    }

    protected abstract options(): MergeBuildOptions;

    /** anything besides the inputs and the options the build depends on */
    protected extra(): unknown {
        return null;
    }

    private buildOptions() {
        const options = this.options();
        const layers = this.inputs.map(s => this.context.layer(s));
        options.include = this.inputs.map((s, i) => (options.include?.[i] ?? true) && layers[i].included);
        options.opacity = layers.map(l => l.opacity);
        return options;
    }

    /** whether the output is not what the inputs make now */
    get stale() {
        if (!this.inputs?.every(s => s?.scene)) return false;
        return mergeSignature(this.inputs, this.buildOptions(), this.extra()) !== this.signature;
    }

    /**
     * Build the output's data from the inputs as they are. Used for the
     * first build, before the node exists, and by do when they changed.
     */
    build(): MergeBuilt {
        const options = this.buildOptions();
        const built = buildMerge(this.inputs, options, this.cache);
        this.signature = mergeSignature(this.inputs, options, this.extra());
        this.built = {
            rows: built.rows,
            copies: built.copies,
            frames: built.frames,
            bands: built.bands,
            total: built.rows.reduce((a, b) => a + b, 0)
        };
        return built;
    }

    // the output's time: its own sequence, shown at the timeline's frame
    private timeOutput() {
        const { output } = this;
        if (!output.motion) return;
        output.motionFrames = Math.max(1, this.built?.frames || this.context.timelineFrames());
        output.timelineFrame = this.context.frame();
        output.retime();
    }

    async do() {
        const { output } = this;
        if (!this.inputs.every(s => s?.scene)) return;
        this.wasVisible = this.inputs.map(s => s.visible);
        this.inputs.forEach((s) => {
            s.visible = false;
        });
        await this.scene.add(output);
        this.timeOutput();
    }

    /**
     * Make the output again from the inputs as they are now, in place: the
     * same object, new data. combine.ts calls this once the history has
     * settled and the output is stale, and then has the nodes standing on
     * the output applied again to the new data.
     */
    async rebuild() {
        const { output } = this;
        if (!output?.scene) return;
        const built = this.build();
        // not drawn until the new data is whole: the motion textures
        // follow the data by a step
        output.timeHidden = true;
        const motion = built.motion ?? (output.motion ? stillMotion(built.data.numSplats) : null);
        if (motion) output.motion = motion;
        await output.replaceData(this.context.asset(built, output.name));
        if (motion) output.setMotion(motion);
        output.timeHidden = false;
        this.timeOutput();
    }

    undo() {
        if (this.output?.scene) {
            this.scene.remove(this.output);
        }
        this.inputs?.forEach((s, i) => {
            s.visible = this.wasVisible[i] ?? true;
        });
    }

    destroy() {
        this.output?.destroy();
        this.inputs = null;
        this.output = null;
        this.cache.clear();
    }
}

class MergeOp extends CombineOp {
    name = 'merge';
    settings: MergeSettings;

    constructor(scene: Scene, inputs: Splat[], output: Splat, context: CombineContext, settings?: Partial<MergeSettings>) {
        super(scene, inputs, output, context);
        this.settings = {
            sh: settings?.sh === 'truncate' ? 'truncate' : 'pad',
            names: inputs.map((_, i) => settings?.names?.[i] ?? '')
        };
    }

    /** the name an input goes by in the merge */
    inputName(i: number) {
        return this.settings.names[i] || this.inputs[i]?.name || `input ${i + 1}`;
    }

    protected options(): MergeBuildOptions {
        return {
            sh: this.settings.sh,
            rate: this.context.rate(),
            timelineFrames: this.context.timelineFrames()
        };
    }
}

export {
    CombineOp,
    MergeOp,
    type CombineContext,
    type MergeSettings
};
