import {
    ADDRESS_CLAMP_TO_EDGE,
    PIXELFORMAT_RGBA32F,
    SEMANTIC_POSITION,
    drawQuadWithShader,
    BoundingBox,
    GraphicsDevice,
    RenderTarget,
    ScopeSpace,
    Shader,
    ShaderUtils,
    Texture,
    Vec3,
    BlendState
} from 'playcanvas';

import { vertexShader, fragmentShader } from '../shaders/bound-shader';
import { Splat } from '../splat';

const v1 = new Vec3();
const v2 = new Vec3();
const v3 = new Vec3();
const v4 = new Vec3();

const resolve = (scope: ScopeSpace, values: any) => {
    for (const key in values) {
        scope.resolve(key).setValue(values[key]);
    }
};

/**
 * Bytes of colour targets per sample the single pass needs: four RGBA32F.
 * WebGPU only guarantees 32, and an adapter at that minimum - SwiftShader
 * is one - rejects the pass outright, which leaves every splat with an
 * empty bound, culled out of sight. There the pass runs twice, one pair of
 * targets each time, rather than giving up precision to RGBA16F.
 */
const SINGLE_PASS_BYTES = 64;

class CalcBound {
    private device: GraphicsDevice;
    private splatParams = new Int32Array(3);
    private shader: Shader = null;
    private selectedShader: Shader = null;
    private visibleShader: Shader = null;
    private split: boolean;
    private selectedMinTexture: Texture = null;
    private selectedMaxTexture: Texture = null;
    private visibleMinTexture: Texture = null;
    private visibleMaxTexture: Texture = null;
    private renderTarget: RenderTarget = null;
    private selectedRenderTarget: RenderTarget = null;
    private visibleRenderTarget: RenderTarget = null;
    private selectedMinRenderTarget: RenderTarget = null;
    private selectedMaxRenderTarget: RenderTarget = null;
    private visibleMinRenderTarget: RenderTarget = null;
    private visibleMaxRenderTarget: RenderTarget = null;
    private selectedMinData: Float32Array = null;
    private selectedMaxData: Float32Array = null;
    private visibleMinData: Float32Array = null;
    private visibleMaxData: Float32Array = null;

    constructor(device: GraphicsDevice) {
        this.device = device;
        const limit = (device as any).wgpu?.limits?.maxColorAttachmentBytesPerSample;
        this.split = device.isWebGPU && (limit ?? 32) < SINGLE_PASS_BYTES;
    }

    private getResources(width: number) {
        const { device } = this;

        const createShader = (uniqueName: string, define?: string) => {
            const fragmentDefines = new Map<string, string>();
            if (define) fragmentDefines.set(define, '');
            return ShaderUtils.createShader(device, {
                uniqueName,
                attributes: {
                    vertex_position: SEMANTIC_POSITION
                },
                vertexGLSL: vertexShader,
                fragmentGLSL: fragmentShader,
                fragmentDefines
            });
        };

        if (this.split) {
            if (!this.selectedShader) {
                this.selectedShader = createShader('calcBoundSelectedShader', 'BOUND_SELECTED');
                this.visibleShader = createShader('calcBoundVisibleShader', 'BOUND_VISIBLE');
            }
        } else if (!this.shader) {
            this.shader = createShader('calcBoundShader');
        }

        if (!this.selectedMinTexture || this.selectedMinTexture.width !== width) {
            if (this.selectedMinTexture) {
                this.selectedMinTexture.destroy();
                this.selectedMaxTexture.destroy();
                this.visibleMinTexture.destroy();
                this.visibleMaxTexture.destroy();
                this.renderTarget?.destroy();
                this.selectedRenderTarget?.destroy();
                this.visibleRenderTarget?.destroy();
                this.selectedMinRenderTarget.destroy();
                this.selectedMaxRenderTarget.destroy();
                this.visibleMinRenderTarget.destroy();
                this.visibleMaxRenderTarget.destroy();
            }

            const createTexture = (name: string) => {
                return new Texture(device, {
                    name,
                    width,
                    height: 1,
                    format: PIXELFORMAT_RGBA32F,
                    mipmaps: false,
                    addressU: ADDRESS_CLAMP_TO_EDGE,
                    addressV: ADDRESS_CLAMP_TO_EDGE
                });
            };

            this.selectedMinTexture = createTexture('calcBoundSelectedMin');
            this.selectedMaxTexture = createTexture('calcBoundSelectedMax');
            this.visibleMinTexture = createTexture('calcBoundVisibleMin');
            this.visibleMaxTexture = createTexture('calcBoundVisibleMax');

            if (this.split) {
                this.renderTarget = null;
                this.selectedRenderTarget = new RenderTarget({
                    colorBuffers: [this.selectedMinTexture, this.selectedMaxTexture],
                    depth: false
                });
                this.visibleRenderTarget = new RenderTarget({
                    colorBuffers: [this.visibleMinTexture, this.visibleMaxTexture],
                    depth: false
                });
            } else {
                this.renderTarget = new RenderTarget({
                    colorBuffers: [this.selectedMinTexture, this.selectedMaxTexture, this.visibleMinTexture, this.visibleMaxTexture],
                    depth: false
                });
            }

            this.selectedMinRenderTarget = new RenderTarget({
                colorBuffer: this.selectedMinTexture,
                depth: false
            });

            this.selectedMaxRenderTarget = new RenderTarget({
                colorBuffer: this.selectedMaxTexture,
                depth: false
            });

            this.visibleMinRenderTarget = new RenderTarget({
                colorBuffer: this.visibleMinTexture,
                depth: false
            });

            this.visibleMaxRenderTarget = new RenderTarget({
                colorBuffer: this.visibleMaxTexture,
                depth: false
            });

            this.selectedMinData = new Float32Array(width * 4);
            this.selectedMaxData = new Float32Array(width * 4);
            this.visibleMinData = new Float32Array(width * 4);
            this.visibleMaxData = new Float32Array(width * 4);
        }

        return {
            shader: this.shader,
            selectedShader: this.selectedShader,
            visibleShader: this.visibleShader,
            selectedRenderTarget: this.selectedRenderTarget,
            visibleRenderTarget: this.visibleRenderTarget,
            selectedMinTexture: this.selectedMinTexture,
            selectedMaxTexture: this.selectedMaxTexture,
            visibleMinTexture: this.visibleMinTexture,
            visibleMaxTexture: this.visibleMaxTexture,
            renderTarget: this.renderTarget,
            selectedMinRenderTarget: this.selectedMinRenderTarget,
            selectedMaxRenderTarget: this.selectedMaxRenderTarget,
            visibleMinRenderTarget: this.visibleMinRenderTarget,
            visibleMaxRenderTarget: this.visibleMaxRenderTarget,
            selectedMinData: this.selectedMinData,
            selectedMaxData: this.selectedMaxData,
            visibleMinData: this.visibleMinData,
            visibleMaxData: this.visibleMaxData
        };
    }

    async run(splat: Splat, selectionBound: BoundingBox, localBound: BoundingBox): Promise<void> {
        const device = splat.scene.graphicsDevice;
        const { scope } = device;

        const numSplats = splat.splatData.numSplats;
        const transformA = (splat.entity.gsplat.instance.resource as any).getTexture('transformA');
        const splatTransform = splat.transformTexture;
        const transformPalette = splat.transformPalette.texture;
        const splatState = splat.stateTexture;

        this.splatParams[0] = transformA.width;
        this.splatParams[1] = transformA.height;
        this.splatParams[2] = numSplats;

        // get resources
        const resources = this.getResources(transformA.width);

        resolve(scope, {
            transformA,
            splatTransform,
            transformPalette,
            splatState,
            splat_params: this.splatParams
        });

        device.setBlendState(BlendState.NOBLEND);
        if (this.split) {
            drawQuadWithShader(device, resources.selectedRenderTarget, resources.selectedShader);
            drawQuadWithShader(device, resources.visibleRenderTarget, resources.visibleShader);
        } else {
            drawQuadWithShader(device, resources.renderTarget, resources.shader);
        }

        // read all 4 textures asynchronously using the public texture.read() API
        const [selectedMinData, selectedMaxData, visibleMinData, visibleMaxData] = await Promise.all([
            resources.selectedMinTexture.read(0, 0, transformA.width, 1, {
                renderTarget: resources.selectedMinRenderTarget,
                data: resources.selectedMinData,
                immediate: this.device.isWebGPU
            }),
            resources.selectedMaxTexture.read(0, 0, transformA.width, 1, {
                renderTarget: resources.selectedMaxRenderTarget,
                data: resources.selectedMaxData,
                immediate: this.device.isWebGPU
            }),
            resources.visibleMinTexture.read(0, 0, transformA.width, 1, {
                renderTarget: resources.visibleMinRenderTarget,
                data: resources.visibleMinData,
                immediate: this.device.isWebGPU
            }),
            resources.visibleMaxTexture.read(0, 0, transformA.width, 1, {
                renderTarget: resources.visibleMaxRenderTarget,
                data: resources.visibleMaxData,
                immediate: this.device.isWebGPU
            })
        ]);

        // resolve selected bounds
        v1.set(Infinity, Infinity, Infinity);
        v2.set(-Infinity, -Infinity, -Infinity);

        for (let i = 0; i < transformA.width; i++) {
            const a = selectedMinData[i * 4];
            const b = selectedMinData[i * 4 + 1];
            const c = selectedMinData[i * 4 + 2];
            if (isFinite(a)) v1.x = Math.min(v1.x, a);
            if (isFinite(b)) v1.y = Math.min(v1.y, b);
            if (isFinite(c)) v1.z = Math.min(v1.z, c);

            const d = selectedMaxData[i * 4];
            const e = selectedMaxData[i * 4 + 1];
            const f = selectedMaxData[i * 4 + 2];
            if (isFinite(d)) v2.x = Math.max(v2.x, d);
            if (isFinite(e)) v2.y = Math.max(v2.y, e);
            if (isFinite(f)) v2.z = Math.max(v2.z, f);
        }

        selectionBound.setMinMax(v1, v2);

        // resolve visible bounds
        v3.set(Infinity, Infinity, Infinity);
        v4.set(-Infinity, -Infinity, -Infinity);

        for (let i = 0; i < transformA.width; i++) {
            const a = visibleMinData[i * 4];
            const b = visibleMinData[i * 4 + 1];
            const c = visibleMinData[i * 4 + 2];
            if (isFinite(a)) v3.x = Math.min(v3.x, a);
            if (isFinite(b)) v3.y = Math.min(v3.y, b);
            if (isFinite(c)) v3.z = Math.min(v3.z, c);

            const d = visibleMaxData[i * 4];
            const e = visibleMaxData[i * 4 + 1];
            const f = visibleMaxData[i * 4 + 2];
            if (isFinite(d)) v4.x = Math.max(v4.x, d);
            if (isFinite(e)) v4.y = Math.max(v4.y, e);
            if (isFinite(f)) v4.z = Math.max(v4.z, f);
        }

        localBound.setMinMax(v3, v4);
    }
}

export { CalcBound };
