/**
 * k-means on the GPU, for the spherical-harmonic palette of a GSV file.
 *
 * The palette clusters every primitive's rest coefficients - 45 floats at
 * SH degree 3 - into up to 65 536 centroids. Assigning a million points to
 * that many centroids is some 10^12 multiply-adds a pass, which is what a
 * GPU is for and a CPU is not; SOG's encoder does the same.
 *
 * Training runs on a random subset of the points, then one pass assigns
 * them all. Each dispatch is kept small: a single long one would trip the
 * driver's timeout (two seconds on Windows) and lose the device.
 */

// a centroid's coefficients are staged in workgroup memory; 48 covers SH
// degree 3 (45) with room to spare and keeps a 64-wide tile in 12 KB
const MAX_DIM = 48;
const TILE = 64;

// multiply-adds per dispatch, well inside a driver timeout on slow GPUs
const WORK_PER_DISPATCH = 2e10;

const SHADER = /* wgsl */`
struct Params { n: u32, k: u32, dim: u32, pad: u32 }

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> points: array<f32>;
@group(0) @binding(2) var<storage, read> centroids: array<f32>;
@group(0) @binding(3) var<storage, read_write> labels: array<u32>;

const TILE: u32 = ${TILE}u;
const MAX_DIM: u32 = ${MAX_DIM}u;

var<workgroup> tile: array<f32, ${TILE * MAX_DIM}>;

@compute @workgroup_size(${TILE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
    let i = gid.x;
    let valid = i < params.n;
    let dim = params.dim;

    var p: array<f32, ${MAX_DIM}>;
    if (valid) {
        for (var d = 0u; d < dim; d++) {
            p[d] = points[i * dim + d];
        }
    }

    var best = 3.4e38;
    var bestJ = 0u;
    for (var base = 0u; base < params.k; base += TILE) {
        // every thread stages one centroid of the tile
        let c = base + lid;
        if (c < params.k) {
            for (var d = 0u; d < dim; d++) {
                tile[lid * MAX_DIM + d] = centroids[c * dim + d];
            }
        }
        workgroupBarrier();

        let count = min(TILE, params.k - base);
        if (valid) {
            for (var j = 0u; j < count; j++) {
                var s = 0.0;
                for (var d = 0u; d < dim; d++) {
                    let df = p[d] - tile[j * MAX_DIM + d];
                    s += df * df;
                }
                if (s < best) {
                    best = s;
                    bestJ = base + j;
                }
            }
        }
        workgroupBarrier();
    }

    if (valid) {
        labels[i] = bestJ;
    }
}
`;

// a small seeded generator, so the same model encodes the same way twice
const mulberry32 = (seed: number) => {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

class Assigner {
    private device: GPUDevice;
    private pipeline: GPUComputePipeline;
    private dim: number;

    constructor(device: GPUDevice, dim: number) {
        if (dim > MAX_DIM) {
            throw new Error(`k-means on the GPU takes at most ${MAX_DIM} dimensions, not ${dim}`);
        }
        this.device = device;
        this.dim = dim;
        this.pipeline = device.createComputePipeline({
            layout: 'auto',
            compute: { module: device.createShaderModule({ code: SHADER }), entryPoint: 'main' }
        });
    }

    /** The nearest centroid of every point. */
    async assign(points: Float32Array, centroids: Float32Array): Promise<Uint32Array> {
        const { device, dim } = this;
        const n = points.length / dim;
        const k = centroids.length / dim;

        const maxBinding = Math.min(device.limits.maxStorageBufferBindingSize, 128 * 1024 * 1024);
        const chunk = Math.max(TILE, Math.min(
            Math.floor(WORK_PER_DISPATCH / (k * dim)),
            Math.floor(maxBinding / (dim * 4)),
            (device.limits.maxComputeWorkgroupsPerDimension ?? 65535) * TILE
        ));
        const chunkN = Math.min(chunk, n);

        const params = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        const pointBuf = device.createBuffer({ size: chunkN * dim * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        const centroidBuf = device.createBuffer({ size: centroids.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        const labelBuf = device.createBuffer({ size: chunkN * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        const readBuf = device.createBuffer({ size: chunkN * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(centroidBuf, 0, centroids);

        const bindGroup = device.createBindGroup({
            layout: this.pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: params } },
                { binding: 1, resource: { buffer: pointBuf } },
                { binding: 2, resource: { buffer: centroidBuf } },
                { binding: 3, resource: { buffer: labelBuf } }
            ]
        });

        const labels = new Uint32Array(n);
        try {
            for (let start = 0; start < n; start += chunkN) {
                const count = Math.min(chunkN, n - start);
                device.queue.writeBuffer(params, 0, new Uint32Array([count, k, dim, 0]));
                device.queue.writeBuffer(pointBuf, 0, points, start * dim, count * dim);

                const encoder = device.createCommandEncoder();
                const pass = encoder.beginComputePass();
                pass.setPipeline(this.pipeline);
                pass.setBindGroup(0, bindGroup);
                pass.dispatchWorkgroups(Math.ceil(count / TILE));
                pass.end();
                encoder.copyBufferToBuffer(labelBuf, 0, readBuf, 0, count * 4);
                device.queue.submit([encoder.finish()]);

                await readBuf.mapAsync(GPUMapMode.READ, 0, count * 4);
                labels.set(new Uint32Array(readBuf.getMappedRange(0, count * 4)), start);
                readBuf.unmap();
            }
        } finally {
            [params, pointBuf, centroidBuf, labelBuf, readBuf].forEach(b => b.destroy());
        }
        return labels;
    }
}

type KmeansOptions = {
    iterations?: number;
    // points trained on; the rest are only assigned
    sample?: number;
    seed?: number;
};

/**
 * Cluster `points` (n rows of `dim` floats) into `k` centroids.
 * Returns the centroids (k rows) and every point's label.
 */
const kmeansGpu = async (device: GPUDevice, points: Float32Array, dim: number, k: number, options: KmeansOptions = {}) => {
    const { iterations = 10, sample = 262144, seed = 1 } = options;
    const n = points.length / dim;
    k = Math.max(1, Math.min(k, n));
    const random = mulberry32(seed);

    // the training subset
    const trainN = Math.min(n, Math.max(sample, k));
    let train = points;
    if (trainN < n) {
        train = new Float32Array(trainN * dim);
        for (let i = 0; i < trainN; i++) {
            const src = Math.floor(random() * n);
            train.set(points.subarray(src * dim, (src + 1) * dim), i * dim);
        }
    }

    // start from k distinct training points, picked by a partial shuffle
    const pick = new Uint32Array(trainN);
    for (let i = 0; i < trainN; i++) pick[i] = i;
    const centroids = new Float32Array(k * dim);
    for (let c = 0; c < k; c++) {
        const j = c + Math.floor(random() * (trainN - c));
        const tmp = pick[c];
        pick[c] = pick[j];
        pick[j] = tmp;
        centroids.set(train.subarray(pick[c] * dim, (pick[c] + 1) * dim), c * dim);
    }

    const assigner = new Assigner(device, dim);
    const sums = new Float64Array(k * dim);
    const counts = new Uint32Array(k);
    for (let it = 0; it < iterations; it++) {
        const labels = await assigner.assign(train, centroids);
        sums.fill(0);
        counts.fill(0);
        for (let i = 0; i < trainN; i++) {
            const c = labels[i];
            counts[c]++;
            for (let d = 0; d < dim; d++) {
                sums[c * dim + d] += train[i * dim + d];
            }
        }
        for (let c = 0; c < k; c++) {
            if (counts[c] > 0) {
                for (let d = 0; d < dim; d++) {
                    centroids[c * dim + d] = sums[c * dim + d] / counts[c];
                }
            } else {
                // an empty cluster restarts at a random point
                const src = Math.floor(random() * trainN);
                centroids.set(train.subarray(src * dim, (src + 1) * dim), c * dim);
            }
        }
    }

    const labels = await assigner.assign(points, centroids);
    return { centroids, labels, k };
};

export { kmeansGpu };
