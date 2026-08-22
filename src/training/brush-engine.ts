/**
 * The training engine: a thin owner of the Brush WASM trainer.
 *
 * Brush trains on its own WebGPU device, entirely separate from the WebGL2
 * context the rest of VoluLab renders with. The wasm package is loaded
 * lazily through a computed-URL dynamic import so rollup never has to
 * understand wasm - the artifacts sit under static/brush/pkg and are built
 * by scripts/build-brush.mjs from the volulab branch of
 * github.com/cyberhirsch/brush.
 *
 * One engine instance lives for the whole session (device + wasm survive
 * across runs); each start() produces a fresh Training which is pumped
 * until done, paused by not pumping, and cancelled by dropping it.
 */

type BrushPkg = typeof import('brush-pkg');
type BrushApp = import('brush-pkg').BrushApp;
type Training = import('brush-pkg').Training;
type BrushMessage = import('brush-pkg').BrushMessage;

type TrainSource =
    | { kind: 'directory'; handle: FileSystemDirectoryHandle }
    | { kind: 'bytes'; bytes: Uint8Array; name: string }
    | { kind: 'url'; url: string };

// the kebab-case TrainStreamConfig, passed through mostly untouched
type BrushConfig = Record<string, unknown>;

type TrainPhase = 'idle' | 'initializing' | 'loading' | 'training' | 'paused' | 'done' | 'error';

type TrainProgress = {
    iter: number;
    numSplats: number;
    elapsedMs: number;
    stepsPerSec: number;
    trainViews: number;
    evalViews: number;
    psnr?: number;
    ssim?: number;
};

type SplatBuffers = {
    transforms: GPUBuffer;
    shCoeffs: GPUBuffer;
    rawOpacities: GPUBuffer;
    count: number;
    shStride: number;
};

class WebGPUTrainingUnavailableError extends Error {}

// steps per trainSteps round trip: larger amortises the JS-wasm boundary,
// smaller keeps pause snappy. Messages arrive every 5 iterations anyway.
const STEPS_PER_BATCH = 5;

// sliding window of TrainStep arrivals for the steps/s readout
const PERF_WINDOW = 32;

/**
 * Let the trainer's sort kernels compile.
 *
 * The kernels use subgroup builtins, and WGSL demands `enable subgroups;`
 * at the top of any module that calls one - the device feature alone is
 * not enough. The generator omits the directive because it asks wgpu what
 * the device supports, and a device handed to wgpu as a raw JS handle (as
 * ours is, so trainer and viewport can share buffers) reports no features
 * back. So every sort kernel failed to compile with "cannot call built-in
 * function 'subgroupAdd' without extension 'subgroups'", the pipelines
 * built from them were invalid, and training stopped at "loading" with a
 * wasm panic instead of an error anyone could read.
 *
 * Prepending the directive here is the smallest place to put it: it is a
 * property of the module text, this device belongs to the trainer alone,
 * and the guard only fires for modules that use subgroups and are missing
 * the line.
 */
type ShaderModuleDesc = Parameters<GPUDevice['createShaderModule']>[0];

const enableSubgroupsInWgsl = (device: GPUDevice) => {
    const create = device.createShaderModule.bind(device);
    device.createShaderModule = (desc: ShaderModuleDesc) => {
        const code = desc.code;
        if (typeof code !== 'string' || !/subgroup[A-Z]/.test(code) || /enable\s+subgroups\s*;/.test(code)) {
            return create(desc);
        }
        return create({ ...desc, code: `enable subgroups;\n${code}` });
    };
};


class BrushEngine {
    private pkg: BrushPkg | null = null;
    private app: BrushApp | null = null;
    private _device: GPUDevice | null = null;

    private training: Training | null = null;
    private paused = false;
    private resumeFn: (() => void) | null = null;

    private progress: TrainProgress = null;
    private steps: { iter: number, at: number }[] = [];

    onPhase: (phase: TrainPhase) => void = () => {};
    onProgress: (progress: TrainProgress) => void = () => {};
    onSplatsUpdated: () => void = () => {};
    onWarning: (text: string) => void = () => {};

    get device() {
        return this._device;
    }

    get active() {
        return this.training !== null;
    }

    get isPaused() {
        return this.paused;
    }

    /**
     * Load the wasm package and acquire the WebGPU device. Throws
     * WebGPUTrainingUnavailableError when the browser cannot train -
     * no WebGPU, or an adapter without the subgroups feature the backward
     * kernels need.
     */
    async ensureInit() {
        if (this.app) return;

        this.onPhase('initializing');

        if (!('gpu' in navigator)) {
            throw new WebGPUTrainingUnavailableError('WebGPU is not available in this browser');
        }
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (!adapter) {
            throw new WebGPUTrainingUnavailableError('No WebGPU adapter available');
        }
        if (!adapter.features.has('subgroups' as GPUFeatureName)) {
            throw new WebGPUTrainingUnavailableError('This GPU/browser lacks WebGPU subgroups, which training requires');
        }

        // Brush wants the adapter's full capabilities - notably subgroups and
        // maxed limits for large storage buffers. mappable-primary-buffers is
        // a Chrome-experimental feature some adapters report but reject.
        const features = [...adapter.features].filter(f => f !== 'mappable-primary-buffers') as GPUFeatureName[];
        const requiredLimits: Record<string, number> = {};
        for (const k in adapter.limits) {
            const v = (adapter.limits as unknown as Record<string, number>)[k];
            if (typeof v === 'number') requiredLimits[k] = v;
        }
        const device = await adapter.requestDevice({ requiredFeatures: features, requiredLimits });
        enableSubgroupsInWgsl(device);

        const base = new URL('static/brush/pkg/', document.baseURI).toString();
        const pkg = await import(`${base}brush_js.js`) as BrushPkg;
        await pkg.default();

        const app = new pkg.BrushApp();
        app.initExisting(adapter, device, device.queue);

        this.pkg = pkg;
        this.app = app;
        this._device = device;
        this.onPhase('idle');
    }

    /**
     * Start a run. editConfig receives Brush's defaults (or the dataset's
     * args.txt) and returns the config to train with, or null to abort.
     * Resolves when training finishes or is stopped.
     */
    async start(source: TrainSource, editConfig: (defaults: BrushConfig) => Promise<BrushConfig | null>) {
        await this.ensureInit();
        this.stop();

        this.progress = {
            iter: 0, numSplats: 0, elapsedMs: 0, stepsPerSec: 0, trainViews: 0, evalViews: 0
        };
        this.steps = [];
        this.paused = false;

        const configFn = (defaults: BrushConfig) => editConfig(defaults);

        let training: Training;
        switch (source.kind) {
            case 'directory':
                training = this.app.startTrainingFromDirectory(source.handle, configFn);
                break;
            case 'bytes':
                training = this.app.startTrainingFromBytes(source.bytes, source.name, configFn);
                break;
            case 'url':
                training = this.app.startTrainingFromUrl(source.url, configFn);
                break;
        }
        this.training = training;

        this.onPhase('loading');
        await this.pump(training);
    }

    /** Pause by not pumping: the trainer back-pressures on its stream. */
    pause() {
        if (!this.training || this.paused) return;
        this.paused = true;
        this.onPhase('paused');
    }

    resume() {
        if (!this.paused) return;
        this.paused = false;
        this.resumeFn?.();
        this.resumeFn = null;
        if (this.training) {
            this.onPhase('training');
        }
    }

    /** Cancel the run; dropping the stream cancels in-flight work. */
    stop() {
        if (!this.training) return;
        this.training.free();
        this.training = null;
        // unblock a paused pump so it can observe the cleared training
        this.paused = false;
        this.resumeFn?.();
        this.resumeFn = null;
    }

    /**
     * The GPU buffers of the latest splats, on the training device. Rebind
     * after every onSplatsUpdated - buffer identity changes as training
     * refines.
     */
    currentBuffers(): SplatBuffers | null {
        if (!this.training) return null;
        const splats = this.training.currentSplats();
        if (!splats || splats.numSplats === 0) return null;
        const buffers = splats.buffers();
        if (!buffers) return null;
        return {
            transforms: buffers.transforms as GPUBuffer,
            shCoeffs: buffers.shCoeffs as GPUBuffer,
            rawOpacities: buffers.rawOpacities as GPUBuffer,
            count: splats.numSplats,
            shStride: (splats.shDegree + 1) * (splats.shDegree + 1) * 3
        };
    }

    /** The latest splats as a standard 3DGS binary PLY. */
    async exportPly(): Promise<Uint8Array> {
        if (!this.training) {
            throw new Error('no training run');
        }
        return await this.training.exportPly();
    }

    private async pump(training: Training) {
        try {
            for (;;) {
                while (this.paused) {
                    await new Promise<void>((resolve) => {
                        this.resumeFn = resolve;
                    });
                }
                // stopped (or replaced) while paused - don't touch a freed object
                if (this.training !== training) return;

                const messages = await training.trainSteps(STEPS_PER_BATCH);
                if (this.training !== training) return;
                if (messages.length === 0) break;
                for (const message of messages) {
                    this.apply(message);
                }
            }
            // the stream is exhausted but the Training object stays alive:
            // its splat view still answers currentBuffers/exportPly until
            // stop() or the next start() frees it
            this.onPhase('done');
        } catch (error) {
            if (this.training === training) {
                this.onWarning(String(error?.message ?? error));
                this.onPhase('error');
            }
        }
    }

    private apply(message: BrushMessage) {
        const kind = this.pkg.BrushMessageKind;
        const p = this.progress;

        switch (message.kind) {
            case kind.TrainStep:
                if (message.iter !== undefined) {
                    p.iter = message.iter;
                    this.steps.push({ iter: message.iter, at: performance.now() });
                    if (this.steps.length > PERF_WINDOW) this.steps.shift();
                    const first = this.steps[0];
                    const last = this.steps[this.steps.length - 1];
                    if (this.steps.length > 1 && last.iter > first.iter) {
                        p.stepsPerSec = ((last.iter - first.iter) * 1000) / (last.at - first.at);
                    }
                }
                if (message.elapsedMs !== undefined) p.elapsedMs = message.elapsedMs;
                this.onPhase(this.paused ? 'paused' : 'training');
                this.onProgress(p);
                this.onSplatsUpdated();
                break;
            case kind.SplatsUpdated:
            case kind.RefineStep:
                if (message.numSplats !== undefined) p.numSplats = message.numSplats;
                this.onProgress(p);
                this.onSplatsUpdated();
                break;
            case kind.DatasetLoaded:
                p.trainViews = message.trainViews ?? 0;
                p.evalViews = message.evalViews ?? 0;
                this.onProgress(p);
                break;
            case kind.EvalResult:
                if (message.psnr !== undefined) p.psnr = message.psnr;
                if (message.ssim !== undefined) p.ssim = message.ssim;
                this.onProgress(p);
                break;
            case kind.StartLoading:
                this.onPhase('loading');
                break;
            case kind.Warning:
                this.onWarning(message.text ?? 'unknown warning');
                break;
            default:
                break;
        }
    }
}

export {
    BrushEngine,
    WebGPUTrainingUnavailableError,
    type BrushConfig,
    type SplatBuffers,
    type TrainPhase,
    type TrainProgress,
    type TrainSource
};
