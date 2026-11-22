/**
 * The depth sort of a 4D model played on the GPU, in a worker of its own.
 *
 * The engine's sort worker is handed finished centres and sorts all of
 * them. For a model that moves that means a pass over every gaussian on
 * the main thread per frame, to build the centres, and a sort of every
 * gaussian per frame - including the ones that never move, which in a
 * captured scene is most of the background.
 *
 * This worker holds the model instead: each gaussian's centre at its own
 * temporal centre, its velocity, and the hierarchy's blocks. A request is
 * a time and a camera, nothing else. It works out the centres itself, and
 * splits the active set in two:
 *
 * - the rows that stand still and are in every active set are sorted once
 *   per view direction, and that order is kept;
 * - the rows that move are sorted per request.
 *
 * Both get their sort key from the same function, fixed for a view
 * direction, so merging the two sorted runs by key gives exactly what one
 * sort of all the rows by that key would: the order drawn is one
 * back-to-front order over both, not two layers.
 *
 * A camera that turns asks for a new direction with every frame, and
 * sorting the still rows again is the larger half of that. So a second
 * worker of the same source does it (the helper), and the first does not
 * wait: it answers with the still order it has, keys the moving rows by
 * that order's direction, and takes the new one when it is in. Such an
 * answer is of the time asked for and of a direction a little behind - as
 * every answer of a turning camera is by the time it is drawn. It says so
 * (`exact: false`), and when the still order of the direction asked for
 * last is in, the worker says `again` and is asked once more.
 *
 * "Stands still" cannot mean a velocity of zero. A trained background is
 * not at rest to the bit, and one that went through a quantised file has
 * the quantiser's nearest value to zero instead (2.5e-5 per sequence in
 * the two-layer alley, on all 1.29M of its background rows). A row counts
 * as still when everywhere it is drawn it is within one key of where it is
 * at its temporal centre - a key being a 2^20th of the scene's extent, the
 * resolution the sort has to begin with. Such a row is sorted where its
 * temporal centre is; the order can differ from a sort of the true
 * centres only between rows less than that apart in depth.
 *
 * The worker is built from `motionSortWorker`'s own source, so it needs no
 * second bundle - which is why that function must stay self-contained: no
 * imports, nothing from this module, only the globals a worker has.
 *
 * The keys - depth cut into buckets, more of them where the gaussians are
 * dense - follow the PlayCanvas engine's gsplat sort worker (MIT).
 */

/** The blocks of a hierarchy: which rows are drawn when. */
type MotionLayout = {
    // segment length per level, in normalised time
    levels: Float64Array;
    // the rows of each (level, segment), ascending. Level -1 is the global
    // set, in every active set; a row of level l, segment s is active while
    // floor(t / levels[l]) is s
    blocks: { level: number, segment: number, rows: Uint32Array }[];
    // Optional, per level, for a model made of others (a merge node): the
    // level's own time is t * scale + offset, so segment s is active while
    // floor((t * scale + offset) / levels[l]) is s - and only within the
    // level's windows, ascending (from, to) pairs, from <= t < to; null:
    // always. A level of infinite length has one segment, 0: rows that are
    // active whenever the level is.
    scale?: Float64Array;
    offset?: Float64Array;
    windows?: (Float64Array | null)[];
};

const inWindows = (windows: Float64Array | null | undefined, t: number) => {
    if (!windows) return true;
    for (let i = 0; i < windows.length; i += 2) {
        if (t >= windows[i] && t < windows[i + 1]) return true;
    }
    return false;
};

/**
 * The segment of a level active at time t, or NaN for none. The worker
 * has its own copy of this (it must stay self-contained).
 */
const layoutSegment = (layout: MotionLayout, l: number, t: number) => {
    if (!inWindows(layout.windows?.[l], t)) return NaN;
    const segLen = layout.levels[l];
    if (!Number.isFinite(segLen)) return 0;
    return Math.floor((t * (layout.scale?.[l] ?? 1) + (layout.offset?.[l] ?? 0)) / segLen);
};

/** What the worker holds of a model; rows are the splat data's. */
type MotionSortModel = {
    // xyz per row, at the row's temporal centre
    centers: Float32Array;
    // xyz: velocity per unit normalised time, w: temporal centre
    velocityTime: Float32Array;
    // 1 / (2 sigma_t^2)
    falloff: Float32Array;
    // null: every row is drawn at every time
    layout: MotionLayout | null;
};

const motionSortWorker = () => {
    const numBins = 32;
    // keys are 20 bits, sorted in two passes of 10
    const maxKey = 2 ** 20 - 1;
    // the splat shader drops a gaussian faded below 1/255
    const fadeCut = Math.log(255);

    let numRows = 0;
    // the size of an order: the engine's order texture, which is as large
    // as the data textures and so has more texels than there are rows
    let orderBytes = 0;
    let centers: Float32Array;
    let vt: Float32Array;
    let falloff: Float32Array;
    // the state byte per row and the bit that says deleted, or null
    let state: Uint8Array | null = null;
    let deletedBit = 0;

    // the hierarchy: the global rows, in every active set - split in still
    // and moving - and per level the rows of each segment
    let globals: Uint32Array = new Uint32Array(0);
    let stillAll: Uint32Array = new Uint32Array(0);
    let movingAll: Uint32Array = new Uint32Array(0);
    // a level's own time is t * scale + offset, and it is drawn only within
    // its windows, (from, to) pairs, or always when null (see MotionLayout)
    type Level = { segLen: number, scale: number, offset: number, windows: Float64Array | null, segments: Map<number, Uint32Array> };
    let levels: Level[] = [];

    // the segment of a level active at t, or NaN for none
    const segmentOf = (level: Level, t: number) => {
        const w = level.windows;
        if (w) {
            let inside = false;
            for (let i = 0; i < w.length && !inside; i += 2) {
                inside = t >= w[i] && t < w[i + 1];
            }
            if (!inside) return NaN;
        }
        if (!Number.isFinite(level.segLen)) return 0;
        return Math.floor((t * level.scale + level.offset) / level.segLen);
    };

    // when a segment of a level can be active: from..to, empty if never.
    // Across all its windows, which is wider than it is but bounds it
    const segmentSpan = (level: Level, segment: number) => {
        const w = level.windows;
        let a = w?.length ? w[0] : -Infinity;
        let b = w?.length ? w[w.length - 1] : Infinity;
        if (Number.isFinite(level.segLen)) {
            if (level.scale === 0) {
                if (Math.floor(level.offset / level.segLen) !== segment) return [1, 0];
            } else {
                const u0 = (segment * level.segLen - level.offset) / level.scale;
                const u1 = ((segment + 1) * level.segLen - level.offset) / level.scale;
                a = Math.max(a, Math.min(u0, u1));
                b = Math.min(b, Math.max(u0, u1));
            }
        }
        return [Math.max(0, a), Math.min(1, b)];
    };

    // the same without the deleted rows
    let still = stillAll;
    let movingGlobal = movingAll;
    // the segment each level was last asked for, and its rows
    let levelSeg: number[] = [];
    let levelRows: Uint32Array[] = [];

    // where anything drawn can be, and where the rows are dense
    const boxMin = [0, 0, 0];
    const boxMax = [0, 0, 0];
    let chunks = new Float32Array(0);

    // the key function of a view direction
    type Key = {
        dx: number, dy: number, dz: number,
        minDist: number,
        invBinRange: number,
        // per depth bin: key = binOffset + binSlope * depth in bins
        binOffset: Float64Array,
        binSlope: Float64Array
    };
    // `at` is when it was asked, by the asker's clock, ms
    // k: how far the gaussians travel against how far they were trained to
    type Request = { id: number, t: number, k?: number, at?: number, px: number, py: number, pz: number, dx: number, dy: number, dz: number };

    // per view direction: the key function, the still rows in key order as
    // (key, row) pairs, and per key how many of them have that key or a
    // lower one. `key` is null while there is no order of the still rows
    // as they are now.
    let key: Key | null = null;
    const binCount = new Float64Array(numBins);
    let stillSorted = new Uint32Array(0);
    let stillCum = new Uint32Array(0);
    // counts the still orders, and whatever else makes an answer a new one
    let epoch = 0;

    // (key, row) pairs being sorted, and where each digit's keys go
    let pairs = new Uint32Array(0);
    let scratch = new Uint32Array(0);
    const low = new Uint32Array(1024);
    const high = new Uint32Array(1024);
    // per key, how many moving rows have a lower one
    const before = new Uint32Array(maxKey + 2);

    const free: ArrayBuffer[] = [];

    // The helper: a second worker that sorts the still rows. It is asked
    // when there are enough of them to be worth a message.
    const helperMin = 1 << 17;
    let helper: MessagePort | null = null;
    let helperBusy = false;
    // the set of still rows there is, and the one the helper has
    let stillSet = 0;
    let helperSet = -1;
    // a request that waits for the first still order, and the last one
    // answered without the still order of its direction
    let held: Request | null = null;
    let owed: Request | null = null;
    // what the last answer was of
    let lastT = NaN;
    let lastK = 1;
    let lastEpoch = -1;
    // for whoever measures: keys and sort of the last still order, ms
    let stillTimes: number[] | null = null;
    // How the camera turns: the direction last asked for and when, and the
    // change of direction per ms since the one before. And what the helper
    // and a sort here last took, ms.
    let seen: Request | null = null;
    const turn = [0, 0, 0];
    let helperTime = 0;
    let sortTime = 0;

    const live = (rows: Uint32Array) => {
        if (!state) {
            return rows;
        }
        const out = new Uint32Array(rows.length);
        let kept = 0;
        for (let i = 0; i < rows.length; i++) {
            if ((state[rows[i]] & deletedBit) === 0) {
                out[kept++] = rows[i];
            }
        }
        return out.subarray(0, kept);
    };

    // after the deletions change: the row lists, and everything built on them
    const applyState = () => {
        still = live(stillAll);
        movingGlobal = live(movingAll);
        levelSeg = levels.map(() => NaN);
        levelRows = levels.map((): Uint32Array => null);
        key = null;
        stillSet++;
        epoch++;
    };

    // The box of everything that can be drawn - a row is drawn between the
    // ends of its segment and of its fade, and motion is linear, so where
    // it is at those two ends bounds it - then which global rows stand
    // still, and the engine's chunk spheres over the rows, which say where
    // along a view direction the rows are dense.
    const measure = () => {
        boxMin.fill(Infinity);
        boxMax.fill(-Infinity);
        const grow = (x: number, y: number, z: number) => {
            if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
                if (x < boxMin[0]) boxMin[0] = x;
                if (y < boxMin[1]) boxMin[1] = y;
                if (z < boxMin[2]) boxMin[2] = z;
                if (x > boxMax[0]) boxMax[0] = x;
                if (y > boxMax[1]) boxMax[1] = y;
                if (z > boxMax[2]) boxMax[2] = z;
            }
        };
        // the furthest row n gets from its temporal centre, in time, while
        // it is drawn between `from` and `to`; negative if it never is
        const ends = [0, 0];
        const drawn = (n: number, from: number, to: number) => {
            const tc = vt[n * 4 + 3];
            const reach = falloff[n] > 0 ? Math.sqrt(fadeCut / falloff[n]) : Infinity;
            ends[0] = Math.max(from, tc - reach) - tc;
            ends[1] = Math.min(to, tc + reach) - tc;
            return ends[0] <= ends[1] ? Math.max(Math.abs(ends[0]), Math.abs(ends[1])) : -1;
        };
        const span = (rows: Uint32Array, from: number, to: number) => {
            for (let i = 0; i < rows.length; i++) {
                const n = rows[i];
                if (drawn(n, from, to) >= 0) {
                    for (let e = 0; e < 2; e++) {
                        grow(centers[n * 3] + vt[n * 4] * ends[e], centers[n * 3 + 1] + vt[n * 4 + 1] * ends[e], centers[n * 3 + 2] + vt[n * 4 + 2] * ends[e]);
                    }
                }
            }
        };
        span(globals, 0, 1);
        levels.forEach((level) => {
            level.segments.forEach((rows, segment) => {
                const [from, to] = segmentSpan(level, segment);
                if (from <= to) span(rows, from, to);
            });
        });
        if (!(boxMin[0] <= boxMax[0])) {
            boxMin.fill(0);
            boxMax.fill(0);
        }

        // still: never further from where it is at its temporal centre
        // than one key is deep, taken across the box
        const oneKey = Math.hypot(boxMax[0] - boxMin[0], boxMax[1] - boxMin[1], boxMax[2] - boxMin[2]) / (maxKey + 1);
        const flags = new Uint8Array(globals.length);
        let numMoving = 0;
        for (let i = 0; i < globals.length; i++) {
            const n = globals[i];
            const drift = Math.hypot(vt[n * 4], vt[n * 4 + 1], vt[n * 4 + 2]) * drawn(n, 0, 1);
            // a row never drawn has a negative drift, and may as well be still
            if (drift > oneKey) {
                flags[i] = 1;
                numMoving++;
            }
        }
        stillAll = new Uint32Array(globals.length - numMoving);
        movingAll = new Uint32Array(numMoving);
        let s = 0;
        let m = 0;
        for (let i = 0; i < globals.length; i++) {
            if (flags[i]) {
                movingAll[m++] = globals[i];
            } else {
                stillAll[s++] = globals[i];
            }
        }
        applyState();

        const numChunks = Math.ceil(numRows / 256);
        chunks = new Float32Array(numChunks * 4);
        for (let c = 0; c < numChunks; c++) {
            let mx = Infinity, my = Infinity, mz = Infinity;
            let Mx = -Infinity, My = -Infinity, Mz = -Infinity;
            const end = Math.min(numRows, (c + 1) * 256);
            for (let n = c * 256; n < end; n++) {
                const x = centers[n * 3], y = centers[n * 3 + 1], z = centers[n * 3 + 2];
                if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
                    if (x < mx) mx = x;
                    if (y < my) my = y;
                    if (z < mz) mz = z;
                    if (x > Mx) Mx = x;
                    if (y > My) My = y;
                    if (z > Mz) Mz = z;
                }
            }
            if (mx <= Mx) {
                chunks[c * 4] = (mx + Mx) * 0.5;
                chunks[c * 4 + 1] = (my + My) * 0.5;
                chunks[c * 4 + 2] = (mz + Mz) * 0.5;
                chunks[c * 4 + 3] = Math.sqrt((Mx - mx) ** 2 + (My - my) ** 2 + (Mz - mz) ** 2) * 0.5;
            } else {
                chunks[c * 4 + 3] = -1;
            }
        }
        key = null;
        epoch++;
    };

    // Sort the first `count` (key, row) pairs of `a` by key, ascending and
    // stable, with `b` as scratch. Two passes over 1024 buckets: the
    // engine's one pass over a million of them misses the cache at every
    // row, which at two million rows is most of what it costs. Counting the
    // digits in a loop of their own is quicker than in the loop that makes
    // the keys.
    const sortPairs = (a: Uint32Array, b: Uint32Array, count: number) => {
        const end = count * 2;
        low.fill(0);
        high.fill(0);
        for (let i = 0; i < end; i += 2) {
            const key = a[i];
            low[key & 1023]++;
            high[key >>> 10]++;
        }
        let lowRun = 0;
        let highRun = 0;
        for (let i = 0; i < 1024; i++) {
            const l = low[i];
            const h = high[i];
            low[i] = lowRun;
            high[i] = highRun;
            lowRun += l;
            highRun += h;
        }
        for (let i = 0; i < end; i += 2) {
            const key = a[i];
            const at = low[key & 1023]++ * 2;
            b[at] = key;
            b[at + 1] = a[i + 1];
        }
        for (let i = 0; i < end; i += 2) {
            const key = b[i];
            const at = high[key >>> 10]++ * 2;
            a[at] = key;
            a[at + 1] = b[i + 1];
        }
    };

    // The key function of a view direction. A key is the depth along the
    // direction cut into buckets, more of them where the rows are dense
    // (the engine's scheme). The density is taken from the rows at their
    // temporal centres rather than from the frame, and the range from
    // everywhere a row can be drawn, so that the function - and with it the
    // still rows' order - holds for every time. An eighth of the buckets is
    // spread evenly, so that a depth the rows only pass through still
    // resolves.
    const keyFunction = (dx: number, dy: number, dz: number): Key => {
        let maxDist = -Infinity;
        let minDist = Infinity;
        for (let i = 0; i < 8; i++) {
            const d = (i & 1 ? boxMin[0] : boxMax[0]) * dx + (i & 2 ? boxMin[1] : boxMax[1]) * dy + (i & 4 ? boxMin[2] : boxMax[2]) * dz;
            minDist = Math.min(minDist, d);
            maxDist = Math.max(maxDist, d);
        }
        const range = maxDist - minDist;

        const binOffset = new Float64Array(numBins + 1);
        const binSlope = new Float64Array(numBins + 1);
        // everything at one depth: one key
        let invBinRange = 0;
        if (range >= 1e-6) {
            invBinRange = numBins / range;
            binCount.fill(0);
            let binTotal = 0;
            for (let c = 0; c < chunks.length; c += 4) {
                const r = chunks[c + 3];
                if (r < 0) continue;
                const d = chunks[c] * dx + chunks[c + 1] * dy + chunks[c + 2] * dz - minDist;
                const binMin = Math.max(0, Math.floor((d - r) * invBinRange));
                const binMax = Math.min(numBins, Math.ceil((d + r) * invBinRange));
                for (let j = binMin; j < binMax; j++) {
                    binCount[j]++;
                    binTotal++;
                }
            }
            // each bin's keys start where the bin before ends. A depth at
            // the far end of the range is in bin numBins, which has only
            // that start: the last key, maxKey at most
            let base = 0;
            for (let i = 0; i < numBins; i++) {
                const share = binTotal > 0 ? binCount[i] / binTotal * 0.875 + 0.125 / numBins : 1 / numBins;
                binSlope[i] = Math.floor(share * maxKey);
                binOffset[i] = base - binSlope[i] * i;
                base += binSlope[i];
            }
            binOffset[numBins] = base;
        }
        return { dx, dy, dz, minDist, invBinRange, binOffset, binSlope };
    };

    // The still rows sorted by a key function, as (key, row) pairs in
    // `sorted`, and in `cum` per key the number of rows with that key or a
    // lower one. Row i's centre is at xyz[i * 3] when `packed`, at
    // xyz[rows[i] * 3] when not.
    const sortStill = (k: Key, rows: Uint32Array, xyz: Float32Array, packed: boolean, sorted: Uint32Array, cum: Uint32Array) => {
        const { dx, dy, dz, minDist, invBinRange, binOffset, binSlope } = k;
        const count = rows.length;
        const t0 = performance.now();
        if (scratch.length < count * 2) {
            scratch = new Uint32Array(count * 2);
        }
        for (let i = 0; i < count; i++) {
            const n = rows[i];
            const c = (packed ? i : n) * 3;
            const d = Math.min(numBins, Math.max(0, (xyz[c] * dx + xyz[c + 1] * dy + xyz[c + 2] * dz - minDist) * invBinRange));
            const bin = d | 0;
            sorted[i * 2] = (binOffset[bin] + binSlope[bin] * d) | 0;
            sorted[i * 2 + 1] = n;
        }
        const t1 = performance.now();
        sortPairs(sorted, scratch, count);
        cum.fill(0);
        for (let i = 0; i < count * 2; i += 2) {
            cum[sorted[i]]++;
        }
        let run = 0;
        for (let i = 0; i <= maxKey; i++) {
            run += cum[i];
            cum[i] = run;
        }
        return [t1 - t0, performance.now() - t1];
    };

    const near = (a: { dx: number, dy: number, dz: number }, b: { dx: number, dy: number, dz: number }) => {
        // the engine worker's tolerance
        const epsilon = 1e-3;
        return Math.abs(a.dx - b.dx) < epsilon && Math.abs(a.dy - b.dy) < epsilon && Math.abs(a.dz - b.dz) < epsilon;
    };

    // Have the helper sort the still rows for a request's direction. It
    // sorts one direction at a time; while it does, nothing is sent, and
    // whoever still wants one when it answers asks then.
    const askHelper = (request: Request) => {
        if (helperBusy) {
            return;
        }
        if (helperSet !== stillSet) {
            const rows = still.slice();
            const xyz = new Float32Array(rows.length * 3);
            for (let i = 0; i < rows.length; i++) {
                const n = rows[i] * 3;
                xyz[i * 3] = centers[n];
                xyz[i * 3 + 1] = centers[n + 1];
                xyz[i * 3 + 2] = centers[n + 2];
            }
            helper.postMessage({ rows, xyz, set: stillSet }, [rows.buffer, xyz.buffer]);
            helperSet = stillSet;
        }
        helperBusy = true;
        // A still order is used from when it is in until the next is, so
        // the direction it is drawn at is the one asked for now turned on
        // by the helper's time, half of it again, and a sort here. It is
        // sorted for that one: where the camera will be if it keeps
        // turning as it does. Not further than a few degrees, and a camera
        // that has stopped is asked for again and gets its own direction.
        let lead = helperTime * 1.5 + sortTime;
        const angle = Math.hypot(turn[0], turn[1], turn[2]) * lead;
        if (angle > 0.15) {
            lead *= 0.15 / angle;
        }
        let dx = request.dx + turn[0] * lead;
        let dy = request.dy + turn[1] * lead;
        let dz = request.dz + turn[2] * lead;
        const length = Math.hypot(dx, dy, dz);
        if (length > 0.5) {
            dx /= length;
            dy /= length;
            dz /= length;
        } else {
            dx = request.dx;
            dy = request.dy;
            dz = request.dz;
        }
        helper.postMessage({ key: keyFunction(dx, dy, dz) });
    };

    const sort = (request: Request) => {
        const start = performance.now();
        const { t } = request;
        const k = request.k ?? 1;

        // A direction within the engine worker's tolerance of the one the
        // still rows were sorted for keeps their order - and the moving rows
        // are sorted for that direction too: one order needs one key function.
        // Any other direction needs the still rows sorted again: here when
        // they are few, by the helper when they are many - and then this
        // answer is of the order there is.
        let exact = true;
        held = null;
        if (request !== seen) {
            const span = seen && request.at !== undefined && seen.at !== undefined ? request.at - seen.at : 0;
            // a camera asked about again after a pause has not been turning
            const turning = span > 0 && span < 250;
            turn[0] = turning ? (request.dx - seen.dx) / span : 0;
            turn[1] = turning ? (request.dy - seen.dy) / span : 0;
            turn[2] = turning ? (request.dz - seen.dz) / span : 0;
            seen = request;
        }
        if (!key || !near(request, key)) {
            if (helper && still.length >= helperMin) {
                askHelper(request);
                if (!key) {
                    // no order to go by yet: the answer waits for the first
                    held = request;
                    return;
                }
                owed = request;
                if (t === lastT && k === lastK && epoch === lastEpoch) {
                    // the order would be the one just sent
                    (self as any).postMessage({ id: request.id, t, same: true, exact: false });
                    return;
                }
                exact = false;
            } else {
                const count = still.length;
                if (stillSorted.length !== count * 2) {
                    stillSorted = new Uint32Array(count * 2);
                }
                if (stillCum.length !== maxKey + 1) {
                    stillCum = new Uint32Array(maxKey + 1);
                }
                key = keyFunction(request.dx, request.dy, request.dz);
                stillTimes = sortStill(key, still, centers, false, stillSorted, stillCum);
                epoch++;
            }
        }
        if (exact) {
            owed = null;
        }
        lastT = t;
        lastK = k;
        lastEpoch = epoch;
        const { dx, dy, dz, minDist, invBinRange, binOffset, binSlope } = key;

        // the rows that move and are drawn at t: the global ones and a
        // segment per level
        const pieces: Uint32Array[] = [movingGlobal];
        let numMoving = movingGlobal.length;
        for (let l = 0; l < levels.length; l++) {
            const segment = segmentOf(levels[l], t);
            if (segment !== levelSeg[l] && !(Number.isNaN(segment) && Number.isNaN(levelSeg[l]) && !levelRows[l])) {
                const rows = levels[l].segments.get(segment);
                levelSeg[l] = segment;
                levelRows[l] = rows ? live(rows) : null;
            }
            if (levelRows[l]) {
                pieces.push(levelRows[l]);
                numMoving += levelRows[l].length;
            }
        }
        if (pairs.length < numMoving * 2) {
            pairs = new Uint32Array(numMoving * 2);
        }
        if (scratch.length < numMoving * 2) {
            scratch = new Uint32Array(numMoving * 2);
        }

        // their keys, where they are at t
        const t0 = performance.now();
        let m = 0;
        for (let p = 0; p < pieces.length; p++) {
            const rows = pieces[p];
            for (let i = 0; i < rows.length; i++) {
                const n = rows[i];
                const dt = (t - vt[n * 4 + 3]) * k;
                const d = Math.min(numBins, Math.max(0, ((centers[n * 3] + vt[n * 4] * dt) * dx + (centers[n * 3 + 1] + vt[n * 4 + 1] * dt) * dy + (centers[n * 3 + 2] + vt[n * 4 + 2] * dt) * dz - minDist) * invBinRange));
                const bin = d | 0;
                const key = (binOffset[bin] + binSlope[bin] * d) | 0;
                pairs[m++] = key;
                pairs[m++] = n;
            }
        }
        const t1 = performance.now();
        sortPairs(pairs, scratch, numMoving);
        const t2 = performance.now();

        // One order of both runs, by key, a still row first where the keys
        // are equal. A row's place is its place in its own run and the
        // number of rows of the other run that come before it: for a moving
        // row the still rows with its key or a lower one, which the still
        // order counted per key; for a still row the moving rows with a
        // lower key, counted here. Walking the two runs and comparing gives
        // the same order at twice the time: which run is next is a guess
        // the processor loses.
        const stillEnd = stillSorted.length;
        const movingEnd = numMoving * 2;
        const total = (stillEnd + movingEnd) / 2;
        const order = new Uint32Array(free.pop() ?? new ArrayBuffer(orderBytes));
        before.fill(0);
        for (let i = 0; i < movingEnd; i += 2) {
            before[pairs[i] + 1]++;
        }
        let run = 0;
        for (let i = 0; i <= maxKey; i++) {
            run += before[i];
            before[i] = run;
        }
        for (let i = 0, s = 0; s < stillEnd; i++, s += 2) {
            order[i + before[stillSorted[s]]] = stillSorted[s + 1];
        }
        for (let i = 0, p = 0; p < movingEnd; i++, p += 2) {
            order[i + stillCum[pairs[p]]] = pairs[p + 1];
        }

        // draw what is in front of the camera: the order up to the first
        // row behind it
        const cameraDist = request.px * dx + request.py * dy + request.pz * dz;
        let lo = 0;
        let hi = total;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            const n = order[mid];
            const dt = (t - vt[n * 4 + 3]) * k;
            const d = (centers[n * 3] + vt[n * 4] * dt) * dx + (centers[n * 3 + 1] + vt[n * 4 + 1] * dt) * dy + (centers[n * 3 + 2] + vt[n * 4 + 2] * dt) * dz;
            if (d < cameraDist) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }

        (self as any).postMessage({
            id: request.id,
            t,
            order: order.buffer,
            count: lo,
            // false: sorted by the direction of the still order there was,
            // not by the one asked for; `direction` is the one sorted by
            exact,
            direction: [dx, dy, dz],
            // for whoever measures: the two runs' sizes, the time taken, of
            // it the moving rows' keys, their sort and the merge, and keys
            // and sort of the still order if this is the first answer by it
            still: stillEnd / 2,
            moving: numMoving,
            sortTime: (sortTime = performance.now() - start),
            times: [t1 - t0, t2 - t1, performance.now() - t2],
            stillTimes,
            posted: performance.timeOrigin + performance.now()
        }, [order.buffer]);
        stillTimes = null;
    };

    // the helper's still order is in
    const fromHelper = (data: { set: number, key: Key, sorted: ArrayBuffer, cum: ArrayBuffer, times: number[] }) => {
        helperBusy = false;
        if (data.set === stillSet) {
            // the order before goes back, to be the one after the next
            if (stillSorted.byteLength > 0 && stillCum.byteLength > 0) {
                helper.postMessage({ sorted: stillSorted.buffer, cum: stillCum.buffer }, [stillSorted.buffer, stillCum.buffer]);
            }
            stillSorted = new Uint32Array(data.sorted);
            stillCum = new Uint32Array(data.cum);
            key = data.key;
            stillTimes = data.times;
            helperTime = data.times[0] + data.times[1];
            epoch++;
        }
        if (held) {
            sort(held);
        } else if (owed) {
            // Not answered from here: a newer request may be on its way,
            // and that one is the one to sort.
            (self as any).postMessage({ again: owed.id });
        }
    };

    // The helper's side: the still rows as the first worker sent them,
    // and the buffers it sent back.
    let serveRows = new Uint32Array(0);
    let serveXyz = new Float32Array(0);
    let serveSet = -1;
    const spareSorted: ArrayBuffer[] = [];
    const spareCum: ArrayBuffer[] = [];
    const serve = (port: MessagePort) => {
        port.onmessage = (message: MessageEvent) => {
            const data = message.data;
            if (data.rows) {
                serveRows = data.rows;
                serveXyz = data.xyz;
                serveSet = data.set;
                spareSorted.length = 0;
            }
            if (data.sorted) {
                if (data.sorted.byteLength === serveRows.length * 8) {
                    spareSorted.push(data.sorted);
                }
                spareCum.push(data.cum);
            }
            if (data.key) {
                const sorted = new Uint32Array(spareSorted.pop() ?? new ArrayBuffer(serveRows.length * 8));
                const cum = new Uint32Array(spareCum.pop() ?? new ArrayBuffer((maxKey + 1) * 4));
                const times = sortStill(data.key, serveRows, serveXyz, true, sorted, cum);
                port.postMessage({ set: serveSet, key: data.key, sorted: sorted.buffer, cum: cum.buffer, times }, [sorted.buffer, cum.buffer]);
            }
        };
    };

    self.onmessage = (message: MessageEvent) => {
        const data = message.data;
        if (data.serve) {
            serve(data.serve);
        }
        if (data.helper) {
            helper = data.helper;
            helper.onmessage = (answer: MessageEvent) => fromHelper(answer.data);
        }
        if (data.model) {
            const model = data.model;
            centers = model.centers;
            vt = model.velocityTime;
            falloff = model.falloff;
            numRows = Math.min(Math.floor(centers.length / 3), Math.floor(vt.length / 4), falloff.length);
            orderBytes = Math.max(data.orderBytes, numRows * 4);

            globals = new Uint32Array(0);
            levels = [];
            if (model.layout) {
                const layout = model.layout;
                levels = Array.from(layout.levels as Float64Array, (segLen, l) => ({
                    segLen,
                    scale: layout.scale?.[l] ?? 1,
                    offset: layout.offset?.[l] ?? 0,
                    windows: layout.windows?.[l] ?? null,
                    segments: new Map<number, Uint32Array>()
                }));
                for (const block of model.layout.blocks) {
                    if (block.level < 0) {
                        globals = block.rows;
                    } else {
                        levels[block.level].segments.set(block.segment, block.rows);
                    }
                }
            } else {
                globals = new Uint32Array(numRows);
                for (let i = 0; i < numRows; i++) {
                    globals[i] = i;
                }
            }
            state = null;
            measure();
        }
        if (data.centers) {
            centers = data.centers;
            measure();
        }
        if (data.state !== undefined) {
            state = data.state;
            deletedBit = data.deletedBit;
            applyState();
        }
        if (data.buffer) {
            free.push(data.buffer);
        }
        if (data.sort) {
            sort(data.sort);
        }
    };
};

type Camera = { px: number, py: number, pz: number, dx: number, dy: number, dz: number };

/**
 * How often the sort answers, for whoever wants to see it: `motionSort.rate`
 * in the browser's console is the number of orders that came in during the
 * last second, over all 4D models; `exactRate` those of them sorted by the
 * very direction asked for, `sortTime` the worker's time for the last, ms.
 */
const motionSort = {
    stamps: [] as { at: number, exact: boolean }[],
    sortTime: 0,
    count(exact: boolean, sortTime = 0) {
        const at = performance.now();
        this.stamps.push({ at, exact });
        while (at - this.stamps[0].at > 1000) {
            this.stamps.shift();
        }
        this.sortTime = sortTime;
    },
    get rate() {
        const now = performance.now();
        return this.stamps.filter((s: { at: number }) => now - s.at <= 1000).length;
    },
    get exactRate() {
        const now = performance.now();
        return this.stamps.filter((s: { at: number, exact: boolean }) => s.exact && now - s.at <= 1000).length;
    }
};
(globalThis as any).motionSort = motionSort;

/**
 * Takes the place of the engine's sort worker on one GSplatSorter. The
 * engine keeps driving its sorter as before: `setCamera` posts to
 * `sorter.worker`, which is this now, and what the instance uploads and
 * draws is `sorter.pendingSorted`, which this fills in as the engine's own
 * message handler would.
 *
 * One request is out at a time. A time or a camera asked for meanwhile
 * replaces the one waiting, and goes out when the result is in: the worker
 * never works on a frame that is no longer wanted, and a result is always
 * of the newest request there was when it started.
 *
 * There are two workers of the one source: the one asked, and the helper
 * that sorts the still rows for it. They talk to each other.
 */
class MotionSorter {
    private sorter: any;
    private worker: Worker;
    private helper: Worker;
    private camera: Camera | null = null;
    private time = 0;
    private velocityScale = 1;
    // what was asked for last, and what the request out (or answered) asked for
    private wanted = 0;
    private sent = 0;
    private waiting = false;
    private onSorted: (t: number) => void;

    /**
     * @param sorter - the engine's GSplatSorter of the splat's instance.
     * @param model - the model; its arrays are copied to the worker.
     * @param onSorted - called when an order is in, with the time it was
     * sorted at: that order draws next, and only at that time is it right.
     */
    constructor(sorter: any, model: MotionSortModel, onSorted: (t: number) => void) {
        this.sorter = sorter;
        this.onSorted = onSorted;

        const url = URL.createObjectURL(new Blob([`(${motionSortWorker.toString()})()`], { type: 'text/javascript' }));
        this.worker = new Worker(url);
        this.helper = new Worker(url);
        URL.revokeObjectURL(url);
        this.worker.onmessage = (message: MessageEvent) => this.result(message.data);
        const channel = new MessageChannel();
        this.helper.postMessage({ serve: channel.port2 }, [channel.port2]);
        // WebGL2 uploads an order as the whole texture, so every order has
        // to be as large as the one the engine made
        this.worker.postMessage({ model, orderBytes: sorter.orderData.byteLength, helper: channel.port1 }, [channel.port1]);

        // the engine's worker goes; the sorter keeps talking to `worker`
        sorter.worker.terminate();
        sorter.worker = {
            postMessage: (data: any) => {
                // setCamera; the engine's other messages hand its own worker
                // centres and a mapping, which this one works out itself
                if (data.cameraPosition && data.cameraDirection) {
                    const p = data.cameraPosition;
                    const d = data.cameraDirection;
                    this.camera = { px: p.x, py: p.y, pz: p.z, dx: d.x, dy: d.y, dz: d.z };
                    this.ask();
                }
            },
            terminate: () => this.destroy()
        };
    }

    /** Sort for normalised time t. */
    show(t: number) {
        this.time = t;
        this.ask();
    }

    /**
     * The gaussians travel k times as far as trained (a motion scale node):
     * each is sorted where the shader draws it. Sorts again if it changed.
     */
    setVelocityScale(k: number) {
        if (k === this.velocityScale) return;
        this.velocityScale = k;
        this.ask();
    }

    /**
     * The rows deleted: the state byte per row and the bit that says so,
     * or null when none is. Sorts again.
     */
    setDeleted(state: Uint8Array | null, deletedBit: number) {
        this.worker?.postMessage({ state: state ? state.slice() : null, deletedBit });
        this.ask();
    }

    /** The rows' centres (at their temporal centres) have moved. Sorts again. */
    setCenters(centers: Float32Array) {
        this.worker?.postMessage({ centers: centers.slice() });
        this.ask();
    }

    destroy() {
        this.worker?.terminate();
        this.helper?.terminate();
        this.worker = null;
        this.helper = null;
    }

    private ask() {
        this.wanted++;
        this.send();
    }

    private send() {
        // without a camera there is nothing to sort by: the first one sends
        if (this.waiting || !this.camera || !this.worker || this.sent === this.wanted) {
            return;
        }
        this.waiting = true;
        this.sent = this.wanted;
        this.worker.postMessage({ sort: { id: this.sent, t: this.time, k: this.velocityScale, at: performance.now(), ...this.camera } });
    }

    // What the engine's handler does with a result: the order becomes the
    // pending one, and the buffer of the order before it goes back to the
    // worker. That one has been uploaded or was never drawn; the pending one
    // stays here until the next result, whenever the instance takes it.
    private result(data: { id: number, t: number, order: ArrayBuffer, count: number, exact?: boolean, same?: boolean, again?: number, sortTime?: number }) {
        const { sorter } = this;
        if (!this.worker) {
            return;
        }
        if (data.again !== undefined) {
            // the still order of a direction answered without it is in:
            // unless something newer is out already, ask once more
            if (!this.waiting) {
                this.ask();
            }
            return;
        }
        this.waiting = false;
        if (!data.same) {
            const last = sorter.orderData as ArrayBuffer;
            sorter.orderData = data.order;
            sorter.pendingSorted = { count: data.count, data: new Uint32Array(data.order) };
            if (last?.byteLength === data.order.byteLength) {
                this.worker.postMessage({ buffer: last }, [last]);
            }
            this.onSorted(data.t);
            motionSort.count(data.exact !== false, data.sortTime);
        }

        if (this.sent !== this.wanted) {
            this.send();
        } else if (data.exact !== false) {
            // 'updated' says the order asked for is in. A result overtaken
            // by a newer request still draws, and so does one sorted by a
            // direction a little behind, but whoever waits for the sort of
            // what it just asked for (the video export) waits for that one
            sorter.fire('updated');
        }
    }
}

export { MotionSorter, layoutSegment, inWindows, type MotionLayout, type MotionSortModel };
