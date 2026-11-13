import {
    SEMANTIC_POSITION,
    drawQuadWithShader,
    BoundingBox,
    GraphicsDevice,
    RenderTarget,
    ScopeSpace,
    Shader,
    ShaderUtils,
    BlendState
} from 'playcanvas';

import { BufferPool } from './buffer-pool';
import { CalcBound } from './calc-bound';
import { CalcHistogram, CalcHistogramOptions } from './calc-histogram';
import { CalcPositions } from './calc-positions';
import { Intersect, IntersectOptions } from './intersect';
import { MotionCenters } from './motion-centers';
import { SelectByRange, SelectByRangeOptions } from './select-by-range';
import { Splat } from '../splat';

const scratchSelection = new BoundingBox();
const scratchFirst = new BoundingBox();
const scratchLast = new BoundingBox();

// a bound left empty by its pass has a NaN centre
const isEmpty = (b: BoundingBox) => !(isFinite(b.center.x) && isFinite(b.center.y) && isFinite(b.center.z));

const unionInto = (a: BoundingBox, b: BoundingBox, result: BoundingBox) => {
    if (isEmpty(a)) {
        result.copy(b);
    } else if (isEmpty(b)) {
        result.copy(a);
    } else {
        result.copy(a);
        result.add(b);
    }
};

const resolve = (scope: ScopeSpace, values: any) => {
    for (const key in values) {
        scope.resolve(key).setValue(values[key]);
    }
};

// gpu processor for splat data. methods are plain (no internal serialisation):
// callers that need ordering relative to other async work must run them inside
// a shared CommandQueue task. see src/command-queue.ts.
class DataProcessor {
    private device: GraphicsDevice;
    private copyShader: Shader;

    // shared pool of readback buffers used by GPU passes that hand bytes back
    // to the caller. Callers receive ownership and must call releaseMask() when
    // done.
    private bufferPool = new BufferPool();

    // a 4D model's centres moved to a time, for every pass that reads centres
    private motionCenters: MotionCenters;

    // instances
    private intersectImpl: Intersect;
    private calcBoundImpl: CalcBound;
    private calcPositionsImpl: CalcPositions;
    private calcHistogramImpl: CalcHistogram;
    private selectByRangeImpl: SelectByRange;

    constructor(device: GraphicsDevice) {
        this.device = device;

        this.copyShader = ShaderUtils.createShader(device, {
            uniqueName: 'copyShader',
            attributes: {
                vertex_position: SEMANTIC_POSITION
            },
            vertexGLSL: `
                attribute vec2 vertex_position;
                void main(void) {
                    gl_Position = vec4(vertex_position, 0.0, 1.0);
                }
            `,
            fragmentGLSL: `
                uniform sampler2D colorTex;
                void main(void) {
                    ivec2 texel = ivec2(gl_FragCoord.xy);
                    gl_FragColor = texelFetch(colorTex, texel, 0);
                }
            `
        });

        // create instances
        this.motionCenters = new MotionCenters(device);
        this.intersectImpl = new Intersect(device, this.motionCenters);
        this.calcBoundImpl = new CalcBound(device);
        this.calcPositionsImpl = new CalcPositions(device);
        this.calcHistogramImpl = new CalcHistogram(device);
        this.selectByRangeImpl = new SelectByRange(device, this.motionCenters);
    }

    // calculate the intersection of a mask canvas with splat centers.
    // returns an owned mask buffer the caller must release via releaseMask().
    intersect(options: IntersectOptions, splat: Splat) {
        return this.intersectImpl.run(options, splat, this.bufferPool);
    }

    // use gpu to calculate both selected and visible bounds in a single pass.
    // shownBound gets the visible bound of what is drawn now. For a 4D model
    // that and selectionBound are of the time shown, while localBound covers
    // every place a gaussian is drawn in the whole sequence - it is what the
    // engine culls by and what sizes the scene, so it must hold all frames.
    async calcBound(splat: Splat, selectionBound: BoundingBox, localBound: BoundingBox, shownBound?: BoundingBox): Promise<void> {
        if (!splat.motion) {
            await this.calcBoundImpl.run(splat, selectionBound, localBound);
            shownBound?.copy(localBound);
            return;
        }

        // one pass after another: they share the readback buffers
        const run = this.calcBoundImpl;
        await run.run(splat, selectionBound, shownBound ?? scratchFirst, this.motionCenters.at(splat, splat.motionTime));
        await run.run(splat, scratchSelection, scratchFirst, this.motionCenters.extent(splat, 0));
        await run.run(splat, scratchSelection, scratchLast, this.motionCenters.extent(splat, 1));
        unionInto(scratchFirst, scratchLast, localBound);
    }

    // only the bounds of the time shown, for a 4D model whose frame changed
    // since calcBound: one pass. A model without motion has nothing to update
    async calcShownBound(splat: Splat, selectionBound: BoundingBox, shownBound: BoundingBox): Promise<void> {
        if (splat.motion) {
            await this.calcBoundImpl.run(splat, selectionBound, shownBound, this.motionCenters.at(splat, splat.motionTime));
        }
    }

    // calculate world-space splat positions
    calcPositions(splat: Splat) {
        return this.calcPositionsImpl.run(splat);
    }

    // calculate histogram (bin counts + min/max) entirely on GPU
    calcHistogram(splat: Splat, mode: number, options?: CalcHistogramOptions) {
        return this.calcHistogramImpl.run(splat, mode, options);
    }

    // compute a per-splat byte mask (255 = in range and visible, 0 = not) for
    // the given histogram bucket range. mode matches the propMode dispatch in
    // src/shaders/splat-value-shader.ts (0..20 = built-in props, 21+N = f_rest_N).
    // returns an owned mask buffer the caller must release via releaseMask().
    selectByRange(splat: Splat, mode: number, options: SelectByRangeOptions) {
        return this.selectByRangeImpl.run(splat, mode, options, this.bufferPool);
    }

    // release a mask buffer returned by intersect() or selectByRange() back to
    // the pool so subsequent calls can reuse it without re-allocating.
    releaseMask(mask: Uint8Array) {
        this.bufferPool.release(mask);
    }

    copyRt(source: RenderTarget, dest: RenderTarget) {
        const { device } = this;

        resolve(device.scope, {
            colorTex: source.colorBuffer
        });

        device.setBlendState(BlendState.NOBLEND);
        drawQuadWithShader(device, dest, this.copyShader);
    }
}

export { DataProcessor };
export type { IntersectOptions, CalcHistogramOptions, SelectByRangeOptions };
export { MaskOptions, RectOptions, SphereOptions, BoxOptions } from './intersect';
