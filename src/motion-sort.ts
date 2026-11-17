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
    let levels: { segLen: number, segments: Map<number, Uint32Array> }[] = [];

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

    // per view direction: the key function, and the still rows in key
    // order as (key, row) pairs
    let dirValid = false;
    let cdx = 0, cdy = 0, cdz = 0;
    let minDist = 0;
    let invBinRange = 0;
    // per depth bin: key = binOffset + binSlope * depth in bins
    const binOffset = new Float64Array(numBins + 1);
    const binSlope = new Float64Array(numBins + 1);
    const binCount = new Float64Array(numBins);
    let stillSorted = new Uint32Array(0);

    // (key, row) pairs being sorted, and where each digit's keys go
    let pairs = new Uint32Array(0);
    let scratch = new Uint32Array(0);
    const low = new Uint32Array(1024);
    const high = new Uint32Array(1024);

    const free: ArrayBuffer[] = [];

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
        dirValid = false;
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
                span(rows, Math.max(0, segment * level.segLen), Math.min(1, (segment + 1) * level.segLen));
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
        dirValid = false;
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

    // The key function of a view direction, and the still rows sorted by
    // it. A key is the depth along the direction cut into buckets, more of
    // them where the rows are dense (the engine's scheme). The density is
    // taken from the rows at their temporal centres rather than from the
    // frame, and the range from everywhere a row can be drawn, so that the
    // function - and with it the still rows' order - holds for every time.
    // An eighth of the buckets is spread evenly, so that a depth the rows
    // only pass through still resolves.
    const buildDirection = (dx: number, dy: number, dz: number) => {
        cdx = dx;
        cdy = dy;
        cdz = dz;
        let maxDist = -Infinity;
        minDist = Infinity;
        for (let i = 0; i < 8; i++) {
            const d = (i & 1 ? boxMin[0] : boxMax[0]) * dx + (i & 2 ? boxMin[1] : boxMax[1]) * dy + (i & 4 ? boxMin[2] : boxMax[2]) * dz;
            minDist = Math.min(minDist, d);
            maxDist = Math.max(maxDist, d);
        }
        const range = maxDist - minDist;

        binOffset.fill(0);
        binSlope.fill(0);
        if (range < 1e-6) {
            // everything at one depth: one key
            invBinRange = 0;
        } else {
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

        const count = still.length;
        if (stillSorted.length !== count * 2) {
            stillSorted = new Uint32Array(count * 2);
        }
        if (scratch.length < count * 2) {
            scratch = new Uint32Array(count * 2);
        }
        for (let i = 0; i < count; i++) {
            const n = still[i];
            const d = Math.min(numBins, Math.max(0, (centers[n * 3] * dx + centers[n * 3 + 1] * dy + centers[n * 3 + 2] * dz - minDist) * invBinRange));
            const bin = d | 0;
            const key = (binOffset[bin] + binSlope[bin] * d) | 0;
            stillSorted[i * 2] = key;
            stillSorted[i * 2 + 1] = n;
        }
        sortPairs(stillSorted, scratch, count);
        dirValid = true;
    };

    const sort = (request: { id: number, t: number, px: number, py: number, pz: number, dx: number, dy: number, dz: number }) => {
        const start = performance.now();
        const { t } = request;

        // A direction within the engine worker's tolerance of the one the
        // still rows were sorted for keeps their order - and the moving rows
        // are sorted for that direction too: one order needs one key function.
        const epsilon = 1e-3;
        if (!dirValid || Math.abs(request.dx - cdx) >= epsilon || Math.abs(request.dy - cdy) >= epsilon || Math.abs(request.dz - cdz) >= epsilon) {
            buildDirection(request.dx, request.dy, request.dz);
        }
        const dx = cdx, dy = cdy, dz = cdz;

        // the rows that move and are drawn at t: the global ones and a
        // segment per level
        const pieces: Uint32Array[] = [movingGlobal];
        let numMoving = movingGlobal.length;
        for (let l = 0; l < levels.length; l++) {
            const segment = Math.floor(t / levels[l].segLen);
            if (segment !== levelSeg[l]) {
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
        let m = 0;
        for (let p = 0; p < pieces.length; p++) {
            const rows = pieces[p];
            for (let i = 0; i < rows.length; i++) {
                const n = rows[i];
                const dt = t - vt[n * 4 + 3];
                const d = Math.min(numBins, Math.max(0, ((centers[n * 3] + vt[n * 4] * dt) * dx + (centers[n * 3 + 1] + vt[n * 4 + 1] * dt) * dy + (centers[n * 3 + 2] + vt[n * 4 + 2] * dt) * dz - minDist) * invBinRange));
                const bin = d | 0;
                const key = (binOffset[bin] + binSlope[bin] * d) | 0;
                pairs[m++] = key;
                pairs[m++] = n;
            }
        }
        sortPairs(pairs, scratch, numMoving);

        // one order of both runs, by key
        const stillEnd = stillSorted.length;
        const movingEnd = numMoving * 2;
        const total = (stillEnd + movingEnd) / 2;
        const order = new Uint32Array(free.pop() ?? new ArrayBuffer(orderBytes));
        let s = 0;
        let o = 0;
        m = 0;
        while (s < stillEnd && m < movingEnd) {
            if (stillSorted[s] <= pairs[m]) {
                order[o++] = stillSorted[s + 1];
                s += 2;
            } else {
                order[o++] = pairs[m + 1];
                m += 2;
            }
        }
        for (; s < stillEnd; s += 2) {
            order[o++] = stillSorted[s + 1];
        }
        for (; m < movingEnd; m += 2) {
            order[o++] = pairs[m + 1];
        }

        // draw what is in front of the camera: the order up to the first
        // row behind it
        const cameraDist = request.px * dx + request.py * dy + request.pz * dz;
        let lo = 0;
        let hi = total;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            const n = order[mid];
            const dt = t - vt[n * 4 + 3];
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
            sortTime: performance.now() - start
        }, [order.buffer]);
    };

    self.onmessage = (message: MessageEvent) => {
        const data = message.data;
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
                levels = Array.from(model.layout.levels as Float64Array, segLen => ({ segLen, segments: new Map<number, Uint32Array>() }));
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
 */
class MotionSorter {
    private sorter: any;
    private worker: Worker;
    private camera: Camera | null = null;
    private time = 0;
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
        URL.revokeObjectURL(url);
        this.worker.onmessage = (message: MessageEvent) => this.result(message.data);
        // WebGL2 uploads an order as the whole texture, so every order has
        // to be as large as the one the engine made
        this.worker.postMessage({ model, orderBytes: sorter.orderData.byteLength });

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
        this.worker = null;
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
        this.worker.postMessage({ sort: { id: this.sent, t: this.time, ...this.camera } });
    }

    // What the engine's handler does with a result: the order becomes the
    // pending one, and the buffer of the order before it goes back to the
    // worker. That one has been uploaded or was never drawn; the pending one
    // stays here until the next result, whenever the instance takes it.
    private result(data: { id: number, t: number, order: ArrayBuffer, count: number }) {
        const { sorter } = this;
        if (!this.worker) {
            return;
        }
        const last = sorter.orderData as ArrayBuffer;
        sorter.orderData = data.order;
        sorter.pendingSorted = { count: data.count, data: new Uint32Array(data.order) };
        if (last?.byteLength === data.order.byteLength) {
            this.worker.postMessage({ buffer: last }, [last]);
        }
        this.waiting = false;
        this.onSorted(data.t);

        if (this.sent !== this.wanted) {
            this.send();
        } else {
            // 'updated' says the order asked for is in. A result overtaken
            // by a newer request still draws, but whoever waits for the sort
            // of what it just asked for (the video export) waits for that one
            sorter.fire('updated');
        }
    }
}

export { MotionSorter, type MotionLayout, type MotionSortModel };
