import type { Splat } from './splat';

/**
 * The output and inspection nodes: render passes, viewer, cache and stats.
 *
 * None of them edits the object. Render passes and the viewer are about a
 * position in the chain, as an output node is; the cache keeps what the
 * nodes above it worked out; stats measures what reaches it. Kept out of
 * edit-ops.ts so the work on them stays in files of their own (see
 * inspect-nodes.ts for what each does when asked).
 */

type PassName = 'beauty' | 'alpha' | 'depth' | 'velocity' | 'matte';

const PASS_NAMES: PassName[] = ['beauty', 'alpha', 'depth', 'velocity', 'matte'];

type RenderPassSettings = {
    passes: Record<PassName, boolean>;
    width: number;
    height: number;
    /** timeline frames, end included; null for the last frame */
    startFrame: number;
    endFrame: number | null;
    /** the files' base name; each is <base>_<pass>.<frame>.<ext> */
    filename: string;
};

const defaultRenderPassSettings = (name: string): RenderPassSettings => ({
    passes: { beauty: true, alpha: true, depth: true, velocity: true, matte: true },
    width: 960,
    height: 540,
    startFrame: 0,
    endFrame: null,
    filename: name
});

/**
 * A point in the chain that renders the scene as it stands there to image
 * sequences, one per pass, for a compositor: beauty, alpha, depth,
 * velocity and the selection matte. Like an output node it changes
 * nothing; writing winds the history to it and back.
 */
class RenderPassesOp {
    name = 'renderPasses';
    splat: Splat;
    settings: RenderPassSettings;
    bypassed?: boolean;

    constructor(splat: Splat, settings: RenderPassSettings) {
        this.splat = splat;
        this.settings = settings;
    }

    get sourceLabel() {
        return PASS_NAMES.filter(p => this.settings.passes[p]).join(', ');
    }

    do() {}

    undo() {}

    destroy() {
        this.splat = null;
    }
}

const isInspectOp = (op: unknown): op is RenderPassesOp => {
    return op instanceof RenderPassesOp;
};

export {
    type PassName,
    type RenderPassSettings,
    PASS_NAMES,
    defaultRenderPassSettings,
    RenderPassesOp,
    isInspectOp
};
