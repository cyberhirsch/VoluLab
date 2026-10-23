/**
 * Statistical outlier removal, off the main thread.
 *
 * For each live gaussian, the mean distance to its `neighbours` nearest
 * others; one is an outlier when that mean sits further than `deviations`
 * standard deviations above the average. At a million points that is
 * seconds of work, which on the main thread is seconds of a frozen editor.
 *
 * The search runs in a worker built from `findOutliers`' own source, so it
 * needs no second bundle - which is also why that function must stay
 * self-contained: no imports, nothing from the enclosing module, only its
 * arguments and the globals a worker has. If a worker cannot be made, the
 * same function runs here instead.
 */

/**
 * The search itself. `live` marks the gaussians still present; the result
 * marks those to delete.
 */
const findOutliers = (
    px: Float32Array,
    py: Float32Array,
    pz: Float32Array,
    live: Uint8Array,
    neighbours: number,
    deviations: number
): Uint8Array => {
    const n = live.length;
    const doomed = new Uint8Array(n);

    const ids: number[] = [];
    for (let i = 0; i < n; ++i) {
        if (live[i]) ids.push(i);
    }
    const k = Math.min(neighbours, ids.length - 1);
    if (k < 1) return doomed;

    // Bounds, to size the grid - trimmed, half a percent off each end of
    // each axis, from a sample. The floaters this node exists to find are
    // exactly what stretches a plain bounding box, and a box stretched a
    // hundredfold puts the whole capture in a handful of cells, where the
    // search turns quadratic. Points outside the trimmed box go to its
    // edge cells, and are measured from there like any other.
    const sample = Math.max(1, Math.floor(ids.length / 65536));
    const trimmed = (v: Float32Array) => {
        const vals: number[] = [];
        for (let m = 0; m < ids.length; m += sample) vals.push(v[ids[m]]);
        vals.sort((p, q) => p - q);
        const cut = Math.floor(vals.length * 0.005);
        return [vals[cut], vals[vals.length - 1 - cut]];
    };
    const [x0, x1] = trimmed(px);
    const [y0, y1] = trimmed(py);
    const [z0, z1] = trimmed(pz);

    // Aim for a few points per cell as a point sees it, so a 3x3x3 block
    // around a point holds comfortably more than k of them. A capture is
    // surfaces in mostly empty space, so a cell sized from the box's volume
    // holds far more than that wherever there is anything. The size is
    // refined a few rounds against the cells' real counts - weighted by
    // the points in them, sum(count^2) / N, since the dense cells are where
    // the search spends its time - and kept under a cell count the grid's
    // arrays can hold.
    const MAX_CELLS = 1 << 24;
    const span = Math.max(x1 - x0, y1 - y0, z1 - z0) || 1;
    const fits = (size: number) => {
        return (Math.floor((x1 - x0) / size) + 2) * (Math.floor((y1 - y0) / size) + 2) * (Math.floor((z1 - z0) / size) + 2) <= MAX_CELLS;
    };
    let cell = span / Math.max(1, Math.cbrt(ids.length / 4));
    const counts = new Map<number, number>();
    for (let round = 0; round < 6; ++round) {
        counts.clear();
        const gx = Math.floor((x1 - x0) / cell) + 2, gy = Math.floor((y1 - y0) / cell) + 2;
        for (const i of ids) {
            const cx = Math.max(0, Math.floor((px[i] - x0) / cell));
            const cy = Math.max(0, Math.floor((py[i] - y0) / cell));
            const cz = Math.max(0, Math.floor((pz[i] - z0) / cell));
            const key = (cz * gy + cy) * gx + cx;
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        let seen = 0;
        counts.forEach((c) => {
            seen += c * c;
        });
        const perCell = seen / ids.length;
        if (perCell < 8) break;
        // on a surface, a cell's count falls with the square of its size
        const next = cell / Math.sqrt(perCell / 4);
        if (fits(next)) {
            cell = next;
            continue;
        }
        // finer than the arrays allow: settle for the finest that fits
        let lo = next, hi = cell;
        for (let step = 0; step < 20; ++step) {
            const mid = 0.5 * (lo + hi);
            if (fits(mid)) hi = mid; else lo = mid;
        }
        cell = hi;
        break;
    }
    const dim = (lo: number, hi: number) => Math.max(1, Math.ceil((hi - lo) / cell) + 1);
    const nx = dim(x0, x1), ny = dim(y0, y1), nz = dim(z0, z1);

    // bucket the points by cell with a counting sort: every cell's points
    // sit together in one array, found through its start offset
    const numCells = nx * ny * nz;
    const cellOf = new Int32Array(ids.length);
    const cellStart = new Int32Array(numCells + 1);
    for (let idx = 0; idx < ids.length; ++idx) {
        const i = ids[idx];
        const cx = Math.max(0, Math.min(nx - 1, Math.floor((px[i] - x0) / cell)));
        const cy = Math.max(0, Math.min(ny - 1, Math.floor((py[i] - y0) / cell)));
        const cz = Math.max(0, Math.min(nz - 1, Math.floor((pz[i] - z0) / cell)));
        const c = (cz * ny + cy) * nx + cx;
        cellOf[idx] = c;
        cellStart[c + 1]++;
    }
    for (let c = 0; c < numCells; ++c) cellStart[c + 1] += cellStart[c];
    const cellItems = new Int32Array(ids.length);
    const fill = cellStart.slice(0, numCells);
    for (let idx = 0; idx < ids.length; ++idx) {
        cellItems[fill[cellOf[idx]]++] = ids[idx];
    }

    // Mean distance to the k nearest - exactly, not as far as some block
    // happens to reach. The search grows a shell of cells at a time and
    // stops once the k-th nearest so far is closer than anything outside
    // the cells searched could be, so the answer does not depend on how
    // the grid was sized - checked against a brute-force search, it is
    // the same answer. The k nearest are kept sorted as they arrive,
    // rather than sorting every candidate.
    const means = new Float64Array(ids.length);
    const best = new Float64Array(k);

    for (let idx = 0; idx < ids.length; ++idx) {
        const i = ids[idx];
        const c = cellOf[idx];
        const cx = c % nx;
        const cy = Math.floor(c / nx) % ny;
        const cz = Math.floor(c / (nx * ny));
        const xi = px[i], yi = py[i], zi = pz[i];

        let kept = 0;
        const consider = (from: number, to: number) => {
            for (let m = from; m < to; ++m) {
                const j = cellItems[m];
                if (j === i) continue;
                const ex = px[j] - xi;
                const ey = py[j] - yi;
                const ez = pz[j] - zi;
                const d = ex * ex + ey * ey + ez * ez;
                if (kept < k) {
                    let at = kept++;
                    while (at > 0 && best[at - 1] > d) {
                        best[at] = best[at - 1];
                        at--;
                    }
                    best[at] = d;
                } else if (d < best[k - 1]) {
                    let at = k - 1;
                    while (at > 0 && best[at - 1] > d) {
                        best[at] = best[at - 1];
                        at--;
                    }
                    best[at] = d;
                }
            }
        };

        for (let r = 0; ; ++r) {
            // the shell at Chebyshev distance r: whole rows where it is a
            // face in z or y, and the two end cells of the rows between
            for (let dz = -r; dz <= r; ++dz) {
                const z = cz + dz;
                if (z < 0 || z >= nz) continue;
                for (let dy = -r; dy <= r; ++dy) {
                    const y = cy + dy;
                    if (y < 0 || y >= ny) continue;
                    const row = (z * ny + y) * nx;
                    if (dz === -r || dz === r || dy === -r || dy === r) {
                        const lo = Math.max(0, cx - r), hi = Math.min(nx - 1, cx + r);
                        consider(cellStart[row + lo], cellStart[row + hi + 1]);
                    } else {
                        if (cx - r >= 0) consider(cellStart[row + cx - r], cellStart[row + cx - r + 1]);
                        if (cx + r < nx) consider(cellStart[row + cx + r], cellStart[row + cx + r + 1]);
                    }
                }
            }

            // how close a point outside the searched block could be: the
            // nearest face of the block, where a face on the grid's edge
            // has nothing beyond it
            if (kept === k) {
                let margin = Infinity;
                if (cx - r > 0) margin = Math.min(margin, xi - (x0 + (cx - r) * cell));
                if (cx + r < nx - 1) margin = Math.min(margin, x0 + (cx + r + 1) * cell - xi);
                if (cy - r > 0) margin = Math.min(margin, yi - (y0 + (cy - r) * cell));
                if (cy + r < ny - 1) margin = Math.min(margin, y0 + (cy + r + 1) * cell - yi);
                if (cz - r > 0) margin = Math.min(margin, zi - (z0 + (cz - r) * cell));
                if (cz + r < nz - 1) margin = Math.min(margin, z0 + (cz + r + 1) * cell - zi);
                if (margin > 0 && best[k - 1] <= margin * margin) break;
            }

            // the whole grid searched: there is nothing further to find
            if (cx - r <= 0 && cx + r >= nx - 1 && cy - r <= 0 && cy + r >= ny - 1 && cz - r <= 0 && cz + r >= nz - 1) break;
        }

        if (!kept) {
            // nothing anywhere near it; the emptiest possible neighbourhood
            means[idx] = Infinity;
            continue;
        }

        let sum = 0;
        for (let m = 0; m < kept; ++m) sum += Math.sqrt(best[m]);
        means[idx] = sum / kept;
    }

    // threshold at mean + deviations * sigma, over the finite values
    let sum = 0, count = 0;
    for (const m of means) {
        if (isFinite(m)) {
            sum += m;
            count++;
        }
    }
    const avg = count ? sum / count : 0;
    let varSum = 0;
    for (const m of means) {
        if (isFinite(m)) varSum += (m - avg) * (m - avg);
    }
    const sigma = count ? Math.sqrt(varSum / count) : 0;
    const limit = avg + deviations * sigma;

    for (let idx = 0; idx < ids.length; ++idx) {
        if (!isFinite(means[idx]) || means[idx] > limit) doomed[ids[idx]] = 1;
    }
    return doomed;
};

let worker: Worker | null = null;
let workerFailed = false;
let nextId = 0;
type Pending = { resolve: (doomed: Uint8Array) => void, reject: (error: Error) => void };
const waiting = new Map<number, Pending>();

const getWorker = () => {
    if (worker || workerFailed) return worker;
    try {
        const source = `const findOutliers = ${findOutliers.toString()};
onmessage = (e) => {
    const { id, px, py, pz, live, neighbours, deviations } = e.data;
    try {
        const doomed = findOutliers(px, py, pz, live, neighbours, deviations);
        postMessage({ id, doomed }, [doomed.buffer]);
    } catch (error) {
        postMessage({ id, error: String(error && error.message || error) });
    }
};`;
        const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        worker = new Worker(url);
        URL.revokeObjectURL(url);
        worker.onmessage = (e: MessageEvent) => {
            const { id, doomed, error } = e.data;
            const pending = waiting.get(id);
            if (!pending) return;
            waiting.delete(id);
            if (error) pending.reject(new Error(error)); else pending.resolve(doomed);
        };
        // a worker that dies takes its requests with it; fail them, and
        // run here from now on
        worker.onerror = () => {
            workerFailed = true;
            worker?.terminate();
            worker = null;
            waiting.forEach(p => p.reject(new Error('cleanup worker failed')));
            waiting.clear();
        };
    } catch (e) {
        workerFailed = true;
        worker = null;
    }
    return worker;
};

/**
 * Find the outliers among the live gaussians, in a worker when there is
 * one. What it reads is copied across, so the splat's own arrays stay
 * free for the frames that keep drawing meanwhile.
 */
const findOutliersAsync = async (
    px: Float32Array,
    py: Float32Array,
    pz: Float32Array,
    live: Uint8Array,
    neighbours: number,
    deviations: number
): Promise<Uint8Array> => {
    const w = getWorker();
    if (w) {
        try {
            return await new Promise<Uint8Array>((resolve, reject) => {
                const id = nextId++;
                waiting.set(id, { resolve, reject });
                // copies, so a failed worker leaves the originals for the fallback
                const copies = { px: px.slice(), py: py.slice(), pz: pz.slice(), live: live.slice() };
                w.postMessage({ id, ...copies, neighbours, deviations },
                    [copies.px.buffer, copies.py.buffer, copies.pz.buffer, copies.live.buffer]);
            });
        } catch (e) {
            // fall through and answer here
        }
    }
    return findOutliers(px, py, pz, live, neighbours, deviations);
};

export { findOutliers, findOutliersAsync };
