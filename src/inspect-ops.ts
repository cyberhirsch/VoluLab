import { IndexRanges } from './index-ranges';
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

/**
 * A tap that shows the stream at this point in the viewport, the object
 * alone, without moving where the chain ends. Showing it is the editor's
 * business (inspect-nodes.ts); the node only marks the place.
 */
class ViewerOp {
    name = 'viewer';
    splat: Splat;
    /** show the object alone while viewing */
    isolate = true;
    bypassed?: boolean;

    constructor(splat: Splat) {
        this.splat = splat;
    }

    do() {}

    undo() {}

    destroy() {
        this.splat = null;
    }
}

type CacheSettings = {
    /** also write each entry to a folder picked by the user */
    disk: boolean;
};

/** What one cached frame holds: the set each node above resolved to. */
type CacheEntry = Map<object, IndexRanges>;

/**
 * Keeps what the nodes above it on this object resolved to - a selection, a
 * cleanup, a decimate - per frame of the object's data, so a frame shown
 * again, or the same frame after an edit further down, does not ask them
 * again. An edit above it, or anything that makes those nodes ask again on
 * a frame they already answered, empties it. inspect-nodes.ts does the
 * work: it puts itself between each node above and its question.
 */
class CacheOp {
    name = 'cache';
    splat: Splat;
    settings: CacheSettings;
    bypassed?: boolean;

    /** by frame key (see inspect-nodes.ts frameKey) */
    frames = new Map<string, CacheEntry>();
    hits = 0;
    misses = 0;
    clears = 0;
    /** the folder entries also go to, while disk is on; not stored */
    dir: FileSystemDirectoryHandle | null = null;
    destroyed = false;

    constructor(splat: Splat, settings: CacheSettings) {
        this.splat = splat;
        this.settings = settings;
    }

    get sourceLabel() {
        return `${this.frames.size} frame${this.frames.size === 1 ? '' : 's'}`;
    }

    get bytes() {
        let n = 0;
        this.frames.forEach(entry => entry.forEach((r) => {
            n += r.data.byteLength;
        }));
        return n;
    }

    clear() {
        if (this.frames.size) this.clears++;
        this.frames.clear();
    }

    do() {}

    undo() {}

    destroy() {
        this.destroyed = true;
        this.frames.clear();
        this.splat = null;
    }
}

/** What a stats node measured as the chain passed through it. */
type StatsSnapshot = {
    total: number;
    live: number;
    selected: number;
    hidden: number;
    /** 4D only: live gaussians that stand still for the whole sequence */
    still: number | null;
    /** bytes of the object's data on the CPU, its motion included */
    bytes: number;
    /** object space, of the live gaussians' centres; null when none */
    min: number[] | null;
    max: number[] | null;
    /** what the data was when measured: a frame of a sequence, or the model */
    key: string;
};

/** Per frame of a 4D model: how many gaussians are drawn, and how many came and went. */
type FrameChange = { frame: number, drawn: number, appeared: number, gone: number };

/**
 * Measures the object at this point in the chain: how many gaussians, how
 * many still and moving, how much memory, the bounds, and per frame how
 * many are drawn and how that changes. Measured when the chain passes
 * through it, so it always says what this point holds.
 */
class StatsOp {
    name = 'stats';
    splat: Splat;
    bypassed?: boolean;

    snapshot: StatsSnapshot | null = null;
    /** a PLY sequence: live count per frame seen, by frame key */
    seen = new Map<string, number>();
    /** a 4D model: worked out when asked for */
    perFrame: FrameChange[] | null = null;

    // set by inspect-nodes.ts: does the measuring
    measure: ((op: StatsOp) => void) | null = null;

    constructor(splat: Splat) {
        this.splat = splat;
    }

    get sourceLabel() {
        return this.snapshot ? `${this.snapshot.live.toLocaleString()} gaussians` : '';
    }

    do() {
        this.measure?.(this);
    }

    undo() {}

    destroy() {
        this.splat = null;
    }
}

const isInspectOp = (op: unknown): op is RenderPassesOp | ViewerOp | CacheOp | StatsOp => {
    return op instanceof RenderPassesOp || op instanceof ViewerOp || op instanceof CacheOp || op instanceof StatsOp;
};

export {
    type PassName,
    type RenderPassSettings,
    type CacheSettings,
    type CacheEntry,
    type StatsSnapshot,
    type FrameChange,
    PASS_NAMES,
    defaultRenderPassSettings,
    RenderPassesOp,
    ViewerOp,
    CacheOp,
    StatsOp,
    isInspectOp
};
