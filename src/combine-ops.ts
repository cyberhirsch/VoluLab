/**
 * The nodes that combine objects: merge, switch, layer and instance.
 *
 * Merge and switch make one object out of several (merge-build.ts). The
 * object is made before the node exists - the first build is the node's
 * reason to be - and then again whenever what it is made from has changed
 * by the time the node applies: an edit upstream of an input, a time node
 * on one, a layer switched off. So the merged object follows its inputs
 * the way a delete node follows its selection, and stays the same object
 * for the nodes after it to stand on. Undo and bypass take it out and
 * show the inputs again.
 *
 * A layer node names a branch and switches it: visibility, solo, lock and
 * an opacity multiplier. It changes no data; what the layers come to is
 * worked out over all of them at once (combine.ts), since solo on one
 * hides the others.
 */

import { Asset } from 'playcanvas';

import { carryHoldout } from './holdout';
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

/** A cut of a switch: from this frame on, this input (0-based). */
type SwitchCut = { frame: number, input: number };

type SwitchSettings = {
    /** the input shown where no cut says otherwise (0-based) */
    index: number;
    cuts: SwitchCut[];
    sh: ShMode;
};

// a motion that moves nothing: for an object that had one and is built still
const stillMotion = (count: number): SplatMotion => ({
    velocityTime: new Float32Array(Math.max(1, count) * 4),
    falloff: new Float32Array(Math.max(1, count))
});

/**
 * Merge and switch: several inputs, one object. What differs is which
 * inputs a frame shows - all of them, or the one a switch picks.
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
    built: { rows: number[], copies: number[], limited: boolean[], frames: number, bands: number, total: number } | null = null;

    protected context: CombineContext;
    private cache: PartCache = new Map();
    // what the output's data was made from
    private signature = '';
    private wasVisible: boolean[] = [];
    // what the last build carried over from the inputs besides their gaussians
    private carried: MergeBuilt['carried'] | null = null;

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
        this.carried = built.carried;
        this.built = {
            rows: built.rows,
            copies: built.copies,
            limited: built.limited,
            frames: built.frames,
            bands: built.bands,
            total: built.rows.reduce((a, b) => a + b, 0)
        };
        return built;
    }

    // the inputs' fog, motion blur and holdouts, on the output
    private carry() {
        const { output, carried } = this;
        output.carriedFog = carried?.fog ?? null;
        output.carriedShutter = carried?.shutter ?? 0;
        output.applyMotionLook();
        carryHoldout(output, carried?.holdout ?? null);
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
        this.carry();
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
        this.carry();
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

/**
 * Switch: one of its inputs at a time. Which one is an index, and cuts
 * change it from a frame on - takes, A/B comparisons, a cut from one
 * capture to another. The inputs are built into one object, each drawn
 * only in the frames it is picked for, so a cut costs nothing when it is
 * played. With no cuts only the input picked is built.
 */
class SwitchOp extends CombineOp {
    name = 'switch';
    settings: SwitchSettings;

    constructor(scene: Scene, inputs: Splat[], output: Splat, context: CombineContext, settings?: Partial<SwitchSettings>) {
        super(scene, inputs, output, context);
        this.settings = {
            index: Math.max(0, Math.min(inputs.length - 1, Math.round(settings?.index ?? 0) || 0)),
            cuts: (settings?.cuts ?? []).filter(c => Number.isFinite(c?.frame) && Number.isFinite(c?.input)).map(c => ({
                frame: Math.max(0, Math.round(c.frame)),
                input: Math.max(0, Math.round(c.input))
            })),
            sh: settings?.sh === 'truncate' ? 'truncate' : 'pad'
        };
    }

    get sourceLabel() {
        const { cuts } = this.settings;
        return cuts.length ? `${this.inputs?.length ?? 0} inputs, ${cuts.length} cuts` : `input ${this.settings.index + 1}`;
    }

    /** the input shown at a frame of the timeline */
    indexAt(frame: number) {
        let index = this.settings.index;
        let from = -1;
        this.settings.cuts.forEach((cut) => {
            if (cut.frame <= frame && cut.frame >= from) {
                from = cut.frame;
                index = cut.input;
            }
        });
        return Math.max(0, Math.min(this.inputs.length - 1, index));
    }

    protected options(): MergeBuildOptions {
        const cuts = this.settings.cuts.filter(c => c.input < this.inputs.length);
        const base = {
            sh: this.settings.sh,
            rate: this.context.rate(),
            timelineFrames: this.context.timelineFrames()
        };
        if (!cuts.length) {
            // one input, as it is
            return { ...base, include: this.inputs.map((_, i) => i === this.indexAt(0)) };
        }
        return {
            ...base,
            pick: (input, frame) => this.indexAt(frame) === input,
            minFrames: Math.max(...cuts.map(c => c.frame)) + 1
        };
    }

    protected extra() {
        return this.settings;
    }
}

type LayerSettings = {
    name: string;
    visible: boolean;
    solo: boolean;
    locked: boolean;
    /** multiplies the opacity of every gaussian of the branch */
    opacity: number;
};

const defaultLayerSettings = (name = 'layer'): LayerSettings => ({ name, visible: true, solo: false, locked: false, opacity: 1 });

/**
 * Layer: the branch up to here, under a name, with a visibility, a solo,
 * a lock and an opacity multiplier - one row of the layer list beside the
 * graph. It changes no data: it says what it says, and combine.ts works
 * out what all the layers come to and tells the objects (Splat.layer*).
 * A merge downstream of a layer takes it in: a hidden layer's input
 * contributes nothing, and the opacity scales its gaussians'.
 */
class LayerOp {
    name = 'layer';
    splat: Splat;
    settings: LayerSettings;
    bypassed?: boolean;

    private onChange: () => void;
    private on = false;

    constructor(splat: Splat, settings: LayerSettings, onChange: () => void) {
        this.splat = splat;
        this.settings = settings;
        this.onChange = onChange;
    }

    get applied() {
        return this.on;
    }

    get sourceLabel() {
        const { settings } = this;
        const flags = [
            !settings.visible ? 'hidden' : '',
            settings.solo ? 'solo' : '',
            settings.locked ? 'locked' : '',
            settings.opacity !== 1 ? `${Math.round(settings.opacity * 100)}%` : ''
        ].filter(Boolean);
        return [settings.name, ...flags].join(' · ');
    }

    do() {
        this.on = true;
        this.onChange();
    }

    undo() {
        this.on = false;
        this.onChange();
    }

    destroy() {
        this.splat = null;
    }
}

export {
    CombineOp,
    MergeOp,
    SwitchOp,
    LayerOp,
    defaultLayerSettings,
    type CombineContext,
    type MergeSettings,
    type SwitchSettings,
    type SwitchCut,
    type LayerSettings
};
