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

import { listDirectory } from './dataset';

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

type TrainLogLevel = 'info' | 'warn' | 'error';

/** One line of the run's account of itself, for the node's log. */
type TrainLogLine = {
    /** performance.now() when the line was written */
    at: number;
    level: TrainLogLevel;
    text: string;
};

/**
 * What can be seen of a load in flight.
 *
 * The trainer says nothing until its first batch returns (see pump), so
 * everything here is measured from outside it: the clock, the wasm heap,
 * and the dataset files it has opened. Zero means not known for this
 * kind of source rather than none.
 */
type TrainLoad = {
    /** the dataset handed over */
    name: string;
    /** bytes handed over, for an in-memory source */
    sizeBytes: number;
    /** files in the dataset, for a directory source */
    fileCount: number;
    /** files the trainer has opened so far, for a directory source */
    filesOpened: number;
    /** ms since the load began */
    elapsedMs: number;
    /** the trainer's wasm heap, which grows as the dataset decodes */
    heapBytes: number;
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

// how often the load is measured from outside, and how often that
// measurement is worth a line in the log
const LOAD_TICK_MS = 1000;
const LOAD_REPORT_S = 30;

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

/**
 * ...and report the ones that still fail.
 *
 * wgpu answers a broken pipeline with "invalid due to a previous error",
 * which names nothing; the browser's own compilation messages name the
 * line. Reading them is what found the missing directive above, so the
 * reading stays in - a shader that fails now says so on the node.
 */
const enableSubgroupsInWgsl = (device: GPUDevice, onShaderError: (text: string) => void) => {
    const create = device.createShaderModule.bind(device);
    device.createShaderModule = (desc: ShaderModuleDesc) => {
        const code = desc.code;
        const module = (typeof code !== 'string' || !/subgroup[A-Z]/.test(code) || /enable\s+subgroups\s*;/.test(code)) ?
            create(desc) :
            create({ ...desc, code: `enable subgroups;\n${code}` });

        module.getCompilationInfo?.().then((info) => {
            for (const message of info.messages) {
                if (message.type === 'error') {
                    onShaderError(`shader ${desc.label ?? ''}:${message.lineNum} ${message.message}`);
                }
            }
        }).catch(() => {});
        return module;
    };
};

/**
 * Stop a clean error scope from reading as an error.
 *
 * `popErrorScope()` resolves with `null` when nothing went wrong. wgpu reads
 * that through wasm-bindgen's `JsOption`, which counts only `undefined` as
 * absent - so `null` arrives as a present error, falls through
 * `Error::from_js` (which knows GPUValidationError and GPUOutOfMemoryError
 * and nothing else) and hits its `panic!("Unexpected error")`. wgpu pops a
 * scope after ordinary work, so this fires on the first clean one: training
 * died a second after it started, with a panic naming a line that has
 * nothing to do with the cause.
 *
 * Handing back `undefined` instead is the whole fix. It is the same shape of
 * workaround as the subgroups directive above - a property of the JS side
 * that the Rust cannot see - and it is safe on any browser: a real error is
 * an object and passes through untouched.
 */
const reportCleanErrorScopeAsAbsent = () => {
    const proto = (window as any).GPUDevice?.prototype;
    const pop = proto?.popErrorScope;
    if (!pop) return;
    proto.popErrorScope = function popErrorScope(this: GPUDevice) {
        return pop.call(this).then((error: unknown) => (error === null ? undefined : error));
    };
};

// what the wasm side sounds like when it dies: the panic hook's output,
// and the trap that follows it back out through the executor
const WASM_FAILURE_RE = /panicked at|RuntimeError|unreachable executed|memory allocation of/i;

const failureHandlers = new Set<(text: string) => void>();
let failureCaptureInstalled = false;

/**
 * Listen for the trainer dying.
 *
 * A Rust panic inside the training future does not reject the trainSteps
 * promise: the task is simply dropped, so the await never settles, and
 * the run sits on "loading dataset" until the tab is closed. The only
 * trace it leaves is the panic hook's console.error - the wasm has no
 * other channel out, this build binds nothing else to the console - plus
 * the trap that surfaces as an unhandled rejection. Reading both is what
 * turns that silence into a message with a cause in it.
 */
const captureWasmFailures = (handler: (text: string) => void) => {
    failureHandlers.add(handler);
    if (failureCaptureInstalled) return;
    failureCaptureInstalled = true;

    const report = (text: string) => {
        if (text && WASM_FAILURE_RE.test(text)) {
            failureHandlers.forEach(h => h(text));
        }
    };
    const describe = (value: any) => {
        return (value instanceof Error) ? (value.stack ?? value.message) : String(value);
    };

    const consoleError = console.error.bind(console);
    console.error = (...args: any[]) => {
        consoleError(...args);
        report(args.map(describe).join(' '));
    };

    window.addEventListener('unhandledrejection', (event) => {
        report(describe(event.reason));
    });
    window.addEventListener('error', (event) => {
        report(event.message ?? describe(event.error));
    });
};

/** The message a panic carries, without the stack dump behind it. */
const summarise = (text: string) => {
    return text.split(/\n\s*Stack:/)[0].replace(/\s+/g, ' ').trim().slice(0, 300);
};

/**
 * Count the dataset files the trainer opens.
 *
 * A picked directory is read through the very handles we hand over -
 * getFile() per entry, called from inside the wasm - so the prototype is
 * the one place a host can watch that loader move. Zip and url sources
 * are read inside wasm and stay opaque; for those the heap and the clock
 * are all there is. The patch lives only as long as the load.
 */
const countFileOpens = (onOpen: () => void) => {
    // the constructor is a runtime global the dom typings do not have to
    // carry, while the interface it builds is one they do
    const proto = (window as any).FileSystemFileHandle?.prototype as FileSystemFileHandle;
    const original = proto?.getFile;
    if (!original) return () => {};

    proto.getFile = function getFile(this: FileSystemFileHandle) {
        onOpen();
        return original.call(this);
    };
    return () => {
        proto.getFile = original;
    };
};

const sourceName = (source: TrainSource) => {
    switch (source.kind) {
        case 'directory': return `${source.handle.name}/`;
        case 'bytes': return source.name;
        case 'url': return source.url;
    }
};


class BrushEngine {
    private pkg: BrushPkg | null = null;
    private app: BrushApp | null = null;
    private _device: GPUDevice | null = null;
    private memory: WebAssembly.Memory | null = null;

    private training: Training | null = null;
    private paused = false;
    private resumeFn: (() => void) | null = null;

    private progress: TrainProgress = null;
    private steps: { iter: number, at: number }[] = [];

    private _phase: TrainPhase = 'idle';

    // the run's abort channel: what a panic pulls to end a pump that is
    // waiting on a promise nothing will ever settle
    private aborted: Promise<never> | null = null;
    private abortFn: ((error: Error) => void) | null = null;
    private _starting = false;

    private load: TrainLoad | null = null;
    private loadTimer: number | null = null;
    private unhookFiles: (() => void) | null = null;

    // exportPly reads the splats back asynchronously, and the snapshot that
    // calls it is not awaited - so a run can be stopped, or fail, with a
    // read still in flight. Freeing the run's object under one is exactly
    // what "null pointer passed to rust" reports, so the free waits.
    private reads = 0;
    private freeWhenRead: Training[] = [];

    onPhase: (phase: TrainPhase) => void = () => {};
    onProgress: (progress: TrainProgress) => void = () => {};
    onSplatsUpdated: () => void = () => {};
    onWarning: (text: string) => void = () => {};
    onLog: (line: TrainLogLine) => void = () => {};
    onLoad: (load: TrainLoad | null) => void = () => {};

    get device() {
        return this._device;
    }

    get active() {
        return this.training !== null;
    }

    get isPaused() {
        return this.paused;
    }

    /** A run is being brought up: asked for, but with no Training yet. */
    get starting() {
        return this._starting;
    }

    get phase() {
        return this._phase;
    }

    /**
     * Load the wasm package and acquire the WebGPU device. Throws
     * WebGPUTrainingUnavailableError when the browser cannot train -
     * no WebGPU, or an adapter without the subgroups feature the backward
     * kernels need.
     */
    async ensureInit() {
        if (this.app) return;

        this.setPhase('initializing');

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
        enableSubgroupsInWgsl(device, text => this.write('error', text));
        reportCleanErrorScopeAsAbsent();

        // wgpu's webgpu backend panics with a bare "Unexpected error" when
        // the device hands it something it did not expect, and the message
        // that would say what it was goes to the browser's console rather
        // than to anything the run can see. These two put it on the node.
        device.addEventListener('uncapturederror', (event: any) => {
            this.write('warn', `webgpu: ${event?.error?.message ?? 'unknown error'}`);
        });
        device.lost.then((info) => {
            this.write('error', `webgpu device lost: ${info.reason ?? ''} ${info.message ?? ''}`.trim());
        }).catch(() => {});

        const info = (adapter as any).info;
        this.write('info', `gpu: ${[info?.vendor, info?.architecture, info?.description].filter(Boolean).join(' ') || 'unknown'}`);

        const base = new URL('static/brush/pkg/', document.baseURI).toString();
        const pkg = await import(`${base}brush_js.js`) as BrushPkg;
        // the trainer's heap: the one number that says a silent load is
        // still eating its dataset rather than sitting dead
        this.memory = (await pkg.default())?.memory ?? null;

        const app = new pkg.BrushApp();
        app.initExisting(adapter, device, device.queue);

        captureWasmFailures((text) => {
            const summary = summarise(text);
            // Only the first panic ends the run, but the rest still belong
            // in the log: the one that surfaces first is often the least
            // informative - a bare "Unexpected error" - while the one that
            // names the cause arrives after the run is already over, when
            // there is nothing left to fail.
            if (!this.fail(summary)) {
                this.write('error', summary);
            }
        });

        this.pkg = pkg;
        this.app = app;
        this._device = device;
        this.setPhase('idle');
    }

    /**
     * Start a run. editConfig receives Brush's defaults (or the dataset's
     * args.txt) and returns the config to train with, or null to abort.
     * Resolves when training finishes or is stopped.
     */
    async start(source: TrainSource, editConfig: (defaults: BrushConfig) => Promise<BrushConfig | null>) {
        // Bringing the wasm up takes seconds, and every await until the
        // Training exists is a window a second start can walk into. Two
        // runs inside that window free each other's Training: "attempted
        // to take ownership of Rust value while it was borrowed", then a
        // null pointer, then a panic in the futures glue. So the window
        // is closed here as well as on the button, because the engine is
        // the only place that knows how long it lasts.
        if (this._starting) return;
        this._starting = true;
        // the clock starts at the ask, not at the load: those seconds are
        // the ones that look like nothing is happening
        this.watchLoad(source);

        let training: Training;
        try {
            try {
                await this.ensureInit();
            } catch (error) {
                this.write('error', String(error?.message ?? error));
                this.setPhase('error');
                throw error;
            }
            this.stop();

            this.progress = {
                iter: 0, numSplats: 0, elapsedMs: 0, stepsPerSec: 0, trainViews: 0, evalViews: 0
            };
            this.steps = [];
            this.paused = false;
            this.aborted = new Promise<never>((resolve, reject) => {
                this.abortFn = reject;
            });
            // nothing races it until the pump does; keep it from counting as
            // an unhandled rejection in the gap
            this.aborted.catch(() => {});

            const configFn = (defaults: BrushConfig) => editConfig(defaults);

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
        } finally {
            this._starting = false;
        }

        this.write('info', `training ${sourceName(source)}`);
        this.setPhase('loading');
        this.watchLoad(source);
        await this.pump(training);
    }

    /** Pause by not pumping: the trainer back-pressures on its stream. */
    pause() {
        if (!this.training || this.paused) return;
        this.paused = true;
        this.setPhase('paused');
    }

    resume() {
        if (!this.paused) return;
        this.paused = false;
        this.resumeFn?.();
        this.resumeFn = null;
        if (this.training) {
            this.setPhase('training');
        }
    }

    /** Cancel the run; dropping the stream cancels in-flight work. */
    stop() {
        if (!this.training) return;
        const training = this.training;
        this.training = null;
        this.release(training);
        this.stopLoadWatch();
        // unblock a paused pump so it can observe the cleared training,
        // and a pump waiting on a batch that may never come back
        this.paused = false;
        this.resumeFn?.();
        this.resumeFn = null;
        this.abortFn?.(new Error('stopped'));
        this.abortFn = null;
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
        const training = this.training;
        if (!training) {
            throw new Error('no training run');
        }
        this.reads++;
        try {
            return await training.exportPly();
        } finally {
            this.reads--;
            this.release(null);
        }
    }

    /**
     * Give up a run's wasm object, once nothing is still reading from it.
     * Pass null to mean "a read finished" rather than "release this".
     */
    private release(training: Training | null) {
        if (training) this.freeWhenRead.push(training);
        if (this.reads > 0) return;
        for (const pending of this.freeWhenRead) {
            pending.free();
        }
        this.freeWhenRead = [];
    }

    private write(level: TrainLogLevel, text: string) {
        this.onLog({ at: performance.now(), level, text });
    }

    private setPhase(phase: TrainPhase) {
        // the load is only measurable while it is the thing happening
        if (phase !== 'loading' && phase !== 'initializing') {
            this.stopLoadWatch();
        }
        this._phase = phase;
        this.onPhase(phase);
    }

    /**
     * End a run the wasm has walked out on.
     *
     * The pump is waiting on a batch whose task no longer exists, so the
     * only way out is from this side: reject what it is waiting on, with
     * the panic text as the reason. Answers whether there was a run left
     * to end.
     */
    private fail(text: string) {
        if (!this.training || !this.abortFn) return false;
        const abort = this.abortFn;
        this.abortFn = null;
        abort(new Error(text));
        return true;
    }

    private heapBytes() {
        return this.memory?.buffer?.byteLength ?? 0;
    }

    /**
     * Measure a load from outside, since it says nothing from inside: the
     * clock, the heap, and - for a directory - the files it has opened
     * against the files there are.
     */
    private watchLoad(source: TrainSource) {
        this.stopLoadWatch();

        this.load = {
            name: sourceName(source),
            sizeBytes: source.kind === 'bytes' ? source.bytes.length : 0,
            fileCount: 0,
            filesOpened: 0,
            elapsedMs: 0,
            heapBytes: this.heapBytes()
        };

        if (source.kind === 'directory') {
            this.unhookFiles = countFileOpens(() => {
                if (this.load) this.load.filesOpened++;
            });
            listDirectory(source.handle).then((entries) => {
                if (this.load) this.load.fileCount = entries.length;
            }).catch(() => {});
        }

        const startedAt = performance.now();
        let reportedAt = 0;

        this.loadTimer = window.setInterval(() => {
            const load = this.load;
            if (!load) return;
            load.elapsedMs = performance.now() - startedAt;
            load.heapBytes = this.heapBytes();
            this.onLoad({ ...load });

            // a real dataset can take minutes, so this says where the load
            // has got to rather than calling it a failure
            const seconds = Math.round(load.elapsedMs / 1000);
            if (seconds - reportedAt >= LOAD_REPORT_S) {
                reportedAt = seconds;
                const opened = load.fileCount ?
                    `${load.filesOpened}/${load.fileCount} files opened` :
                    `${load.filesOpened} files opened`;
                this.write('info', `still loading after ${seconds}s - ${opened}, ${Math.round(load.heapBytes / 1e6)} MB heap`);
            }
        }, LOAD_TICK_MS);
    }

    private stopLoadWatch() {
        if (this.loadTimer !== null) {
            window.clearInterval(this.loadTimer);
            this.loadTimer = null;
        }
        this.unhookFiles?.();
        this.unhookFiles = null;
        if (this.load) {
            this.load = null;
            this.onLoad(null);
        }
    }

    private async pump(training: Training) {
        // the first batch carries the whole loading phase with it, so it
        // asks for a single step: the run leaves "loading" as soon as one
        // has actually been taken, not five
        let first = true;
        try {
            for (;;) {
                while (this.paused) {
                    await new Promise<void>((resolve) => {
                        this.resumeFn = resolve;
                    });
                }
                // stopped (or replaced) while paused - don't touch a freed object
                if (this.training !== training) return;

                const batch = training.trainSteps(first ? 1 : STEPS_PER_BATCH);
                first = false;
                const messages = await Promise.race([batch, this.aborted]);
                if (this.training !== training) return;
                if (messages.length === 0) break;
                for (const message of messages) {
                    this.apply(message);
                }
            }
            // the stream is exhausted but the Training object stays alive:
            // its splat view still answers currentBuffers/exportPly until
            // stop() or the next start() frees it
            this.setPhase('done');
        } catch (error) {
            // stop() clears training before it aborts: that is a run being
            // ended, not a run failing
            if (this.training !== training) return;
            // the reference goes; the object does not. A run that failed
            // can still have wasm work holding it - the panic killed one
            // task, not the stream - and freeing it under that work is
            // what reports "null pointer passed to rust", right after
            // start, in place of the error that actually ended the run.
            // Dropping the reference is enough: the finalizer collects it.
            this.training = null;

            const text = String(error?.message ?? error);
            this.write('error', text);
            this.onWarning(text);
            this.setPhase('error');
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
                this.setPhase(this.paused ? 'paused' : 'training');
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
                this.write('info', `dataset: ${p.trainViews} train / ${p.evalViews} eval views`);
                this.onProgress(p);
                break;
            case kind.EvalResult:
                if (message.psnr !== undefined) p.psnr = message.psnr;
                if (message.ssim !== undefined) p.ssim = message.ssim;
                this.onProgress(p);
                break;
            case kind.StartLoading:
                this.setPhase('loading');
                break;
            case kind.DoneLoading:
                this.write('info', 'dataset loaded');
                break;
            case kind.DoneTraining:
                this.write('info', 'training complete');
                break;
            case kind.Warning:
                this.write('warn', message.text ?? 'unknown warning');
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
    type TrainLoad,
    type TrainLogLevel,
    type TrainLogLine,
    type TrainPhase,
    type TrainProgress,
    type TrainSource
};
