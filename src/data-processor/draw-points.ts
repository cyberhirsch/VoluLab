import {
    BINDGROUP_MESH,
    BINDGROUP_MESH_UB,
    BINDGROUP_VIEW,
    PRIMITIVE_POINTS,
    QuadRender,
    RenderPass,
    SEMANTIC_POSITION,
    TYPE_FLOAT32,
    BlendState,
    DepthState,
    GraphicsDevice,
    RenderTarget,
    Shader,
    VertexBuffer,
    VertexFormat
} from 'playcanvas';

/**
 * Dispatch N points through a shader into a render target - the vertex
 * pulling pattern the histogram binning uses.
 *
 * Built on the engine's QuadRender rather than poking the device
 * directly: updateBegin/updateEnd and raw viewport state are WebGL-only
 * internals, while a RenderPass with a processed shader and bind groups
 * is what WebGPU requires. QuadRender's constructor does all of that
 * processing; only the draw itself is swapped from a quad to points.
 */

let cachedDevice: GraphicsDevice = null;
let cachedVB: VertexBuffer = null;

const getInstancingVB = (device: GraphicsDevice) => {
    if (cachedVB && cachedDevice === device) {
        return cachedVB;
    }
    const format = new VertexFormat(device, [
        { semantic: SEMANTIC_POSITION, components: 1, type: TYPE_FLOAT32 }
    ]);
    (format as any).instancing = true;
    cachedVB = new VertexBuffer(device, format, 1);
    cachedVB.lock();
    cachedVB.unlock();
    cachedDevice = device;
    return cachedVB;
};

// the shape UniformBuffer.update fills in - the engine's DynamicBindGroup
// is exactly this and is not exported
const dynamicBindGroup: { bindGroup: any, offsets: number[] } = { bindGroup: null, offsets: [] };

/** QuadRender's processed shader and bind groups, drawing points instead */
class PointRender extends QuadRender {
    renderPoints(vb: VertexBuffer, count: number) {
        const shader = (this as any).shader as Shader;
        const device = shader.device as any;

        device.setVertexBuffer(vb);
        device.setShader(shader);

        if (device.supportsUniformBuffers) {
            device.setBindGroup(BINDGROUP_VIEW, device.emptyBindGroup);
            const bindGroup = (this as any).bindGroup;
            bindGroup.update();
            device.setBindGroup(BINDGROUP_MESH, bindGroup);
            const uniformBuffer = (this as any).uniformBuffer;
            if (uniformBuffer) {
                uniformBuffer.update(dynamicBindGroup);
                device.setBindGroup(BINDGROUP_MESH_UB, dynamicBindGroup.bindGroup, dynamicBindGroup.offsets);
            } else {
                device.setBindGroup(BINDGROUP_MESH_UB, device.emptyBindGroup);
            }
        }

        device.draw({
            type: PRIMITIVE_POINTS,
            base: 0,
            count,
            indexed: false
        });
    }
}

// processed state is cached per source shader - shader processing and bind
// group creation are not per-dispatch work
const pointRenders = new WeakMap<Shader, PointRender>();

class RenderPassPoints extends RenderPass {
    pointRender: PointRender;
    vb: VertexBuffer;
    count: number;
    blendState: BlendState;

    execute() {
        const device = this.device as any;
        const rt = this.renderTarget;
        const w = rt ? rt.width : device.width;
        const h = rt ? rt.height : device.height;
        device.setViewport(0, 0, w, h);
        device.setScissor(0, 0, w, h);
        device.setBlendState(this.blendState);
        device.setDepthState(DepthState.NODEPTH);
        this.pointRender.renderPoints(this.vb, this.count);
    }
}

const drawPointsWithShader = (
    device: GraphicsDevice,
    target: RenderTarget,
    shader: Shader,
    count: number,
    blendState: BlendState
) => {
    let pointRender = pointRenders.get(shader);
    if (!pointRender) {
        pointRender = new PointRender(shader);
        pointRenders.set(shader, pointRender);
    }

    const pass = new RenderPassPoints(device);
    pass.pointRender = pointRender;
    pass.vb = getInstancingVB(device);
    pass.count = count;
    pass.blendState = blendState;
    pass.init(target);
    pass.colorOps.clear = false;
    pass.depthStencilOps.clearDepth = false;
    pass.render();
};

export { drawPointsWithShader };
