/**
 * Time nodes: what a 4D model shows at a frame of the timeline.
 *
 * A 4D model is drawn at a time of its own - the shader moves and fades
 * each gaussian for it, the sort worker orders them for it - and without a
 * time node that time is the timeline's. A time node changes which of the
 * model's frames a timeline frame shows, and nothing else: the model's
 * data, its velocities and its lifetimes stay as trained, so a gaussian is
 * drawn where it was at the frame that is shown, however fast or in which
 * direction the timeline gets there.
 *
 * Each node is a map from a frame of the sequence it leaves to a frame of
 * the sequence it was given, and says how long the sequence it leaves is.
 * An object holds the maps of its applied time nodes in the order of its
 * chain (Splat.timeMaps); a timeline frame goes through them from the last
 * to the first and comes out as a frame of the model (resolveTime). That
 * is the one place the mapping is applied - Splat.showFrame - so a node
 * that is undone or bypassed is simply not in the list.
 */

interface TimeMap {
    /** How many frames the sequence this leaves has, given one of `frames`. */
    span(frames: number): number;

    /**
     * The frame of the sequence it was given that frame `f` of its own
     * shows, or null for nothing at all. `f` is within its own sequence;
     * `outside` says the frame asked for was not, and `f` is the nearest
     * that is. The answer may be between two frames, and may lie outside
     * the sequence it was given: the map under it is told so.
     */
    at(f: number, frames: number, outside: boolean): number | null;

    /**
     * It shows a frame of its own choosing whatever frame is asked for, so
     * a frame asked for outside its sequence is not outside for the maps
     * under it.
     */
    readonly holds?: boolean;

    /**
     * What decides its answers, as a string, for a map that holds more
     * than plain settings (a node, a curve). Without it, its own fields are
     * taken.
     */
    key?(): string;
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** The length each map leaves, from the model's own (first) to the object's (last). */
const spans = (maps: TimeMap[], frames: number) => {
    const out = [Math.max(1, frames)];
    maps.forEach((map) => {
        out.push(Math.max(1, Math.round(map.span(out[out.length - 1])) || 1));
    });
    return out;
};

/** How many frames an object's sequence has once its time nodes are through with it. */
const timeSpan = (maps: TimeMap[], frames: number) => {
    const s = spans(maps, frames);
    return s[s.length - 1];
};

/**
 * The frame of the model shown at timeline frame `f`, or null when a node
 * hides the object there. A frame outside a sequence holds its nearest end
 * unless a node says otherwise.
 */
const resolveTime = (maps: TimeMap[], frames: number, f: number): number | null => {
    const s = spans(maps, frames);
    let x = f;
    let outside = false;
    for (let i = maps.length - 1; i >= 0; --i) {
        const last = s[i + 1] - 1;
        if (x < 0 || x > last) {
            outside = true;
            x = clamp(x, 0, last);
        }
        x = maps[i].at(x, s[i], outside);
        if (x === null) return null;
        if (maps[i].holds) {
            outside = false;
            x = clamp(x, 0, s[i] - 1);
        }
    }
    return clamp(x, 0, s[0] - 1);
};

/** Frames in..out of the sequence, and nothing else. */
class TrimMap implements TimeMap {
    in: number;
    out: number;

    constructor(inFrame = 0, outFrame = Infinity) {
        this.in = inFrame;
        this.out = outFrame;
    }

    /** the range as it holds for a sequence of `frames` */
    range(frames: number) {
        const a = clamp(Math.round(this.in) || 0, 0, frames - 1);
        const b = clamp(Number.isFinite(this.out) ? Math.round(this.out) : frames - 1, a, frames - 1);
        return [a, b];
    }

    span(frames: number) {
        const [a, b] = this.range(frames);
        return b - a + 1;
    }

    at(f: number, frames: number) {
        const [a, b] = this.range(frames);
        return Math.min(a + f, b);
    }
}

/** The sequence faster or slower, forwards or backwards. */
class RetimeMap implements TimeMap {
    speed: number;
    reverse: boolean;

    constructor(speed = 1, reverse = false) {
        this.speed = speed;
        this.reverse = reverse;
    }

    get factor() {
        return this.speed > 0 && Number.isFinite(this.speed) ? this.speed : 1;
    }

    span(frames: number) {
        return Math.max(1, Math.round(frames / this.factor));
    }

    at(f: number, frames: number) {
        const x = Math.min(f * this.factor, frames - 1);
        return this.reverse ? frames - 1 - x : x;
    }
}

type LoopMode = 'none' | 'loop' | 'pingpong';

/** The sequence several times over, or there and back. */
class LoopMap implements TimeMap {
    mode: LoopMode;
    count: number;

    constructor(mode: LoopMode = 'loop', count = 2) {
        this.mode = mode;
        this.count = count;
    }

    get repeats() {
        return Math.max(1, Math.round(this.count) || 1);
    }

    // there and back without showing either end twice, so that it joins
    // up with itself: 0 1 2 3 2 1 | 0 1 2 3 2 1
    private period(frames: number) {
        return this.mode === 'pingpong' ? Math.max(1, 2 * frames - 2) : frames;
    }

    span(frames: number) {
        return this.mode === 'none' ? frames : this.period(frames) * this.repeats;
    }

    at(f: number, frames: number) {
        if (this.mode === 'none') return f;
        const period = this.period(frames);
        const m = f - Math.floor(f / period) * period;
        return this.mode === 'pingpong' && m > frames - 1 ? period - m : m;
    }
}

/** One frame of the sequence, for as long as the sequence was. */
class FreezeMap implements TimeMap {
    frame: number;

    constructor(frame = 0) {
        this.frame = frame;
    }

    readonly holds = true;

    span(frames: number) {
        return frames;
    }

    at(f: number, frames: number) {
        return clamp(Math.round(this.frame) || 0, 0, frames - 1);
    }
}

type OffsetOutside = 'hold' | 'hide';

/** The sequence later or earlier on the timeline. */
class OffsetMap implements TimeMap {
    frames: number;
    outside: OffsetOutside;

    constructor(frames = 0, outside: OffsetOutside = 'hide') {
        this.frames = frames;
        this.outside = outside;
    }

    get shift() {
        return Math.round(this.frames) || 0;
    }

    get holds() {
        return this.outside === 'hold';
    }

    // moved later it ends later; moved earlier, what falls before the
    // timeline's start is gone and it ends earlier
    span(frames: number) {
        return Math.max(1, frames + this.shift);
    }

    at(f: number, frames: number, outside: boolean) {
        const x = f - this.shift;
        if (this.outside === 'hide' && (outside || x < 0 || x > frames - 1)) {
            return null;
        }
        return x;
    }
}

export {
    type TimeMap,
    type LoopMode,
    type OffsetOutside,
    TrimMap,
    RetimeMap,
    LoopMap,
    FreezeMap,
    OffsetMap,
    resolveTime,
    timeSpan
};
