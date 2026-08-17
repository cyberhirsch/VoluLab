/**
 * Live preview of a training run: Brush's splat buffers drawn as soft point
 * sprites on a WebGPU canvas, with a small orbit camera.
 *
 * A port of the reference renderer shipped with brush-js. Deliberately not
 * gaussian rendering - the point is watching a reconstruction take shape,
 * and point sprites do that with no sorting and no covariance work. The
 * finished result is viewed properly in the main viewport after commit.
 */

import { SplatBuffers } from './brush-engine';

const SHADER = /* wgsl */ `
struct Uniforms {
    view_proj: mat4x4<f32>,
    inv_screen: vec2<f32>,
    point_radius_px: f32,
    transforms_stride: u32,
    sh_stride: u32,
    _pad0: u32, _pad1: u32, _pad2: u32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> transforms: array<f32>;
@group(0) @binding(2) var<storage, read> sh_coeffs: array<f32>;
@group(0) @binding(3) var<storage, read> raw_opacities: array<f32>;

const SH_C0 = 0.28209479177387814;

struct VsOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) color: vec3<f32>,
    @location(2) alpha: f32,
};

fn sigmoid(x: f32) -> f32 {
    return 1.0 / (1.0 + exp(-x));
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VsOut {
    let tbase = ii * u.transforms_stride;
    let pos_world = vec3<f32>(transforms[tbase], transforms[tbase + 1u], transforms[tbase + 2u]);

    let sbase = ii * u.sh_stride;
    let sh0 = vec3<f32>(sh_coeffs[sbase], sh_coeffs[sbase + 1u], sh_coeffs[sbase + 2u]);
    let color = clamp(vec3<f32>(0.5) + SH_C0 * sh0, vec3<f32>(0.0), vec3<f32>(1.0));
    let alpha = sigmoid(raw_opacities[ii]);

    let corner = vec2<f32>(
        f32((vi & 1u) * 2u) - 1.0,
        f32(((vi >> 1u) & 1u) * 2u) - 1.0,
    );

    let clip = u.view_proj * vec4<f32>(pos_world, 1.0);
    let offset = corner * u.point_radius_px * 2.0 * u.inv_screen * clip.w;

    var out: VsOut;
    out.pos = vec4<f32>(clip.xy + offset, clip.z, clip.w);
    out.uv = corner;
    out.color = color;
    out.alpha = alpha;
    return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
    let r2 = dot(in.uv, in.uv);
    if (r2 > 1.0) { discard; }
    let falloff = 1.0 - r2;
    let a = in.alpha * falloff;
    return vec4<f32>(in.color * a, a);
}
`;

const UNIFORM_SIZE = 96;

type Vec3 = [number, number, number];

const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]
];
const norm3 = (v: Vec3): Vec3 => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
};
const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const lookAt = (eye: Vec3, center: Vec3, up: Vec3) => {
    const f = norm3(sub3(center, eye));
    const s = norm3(cross3(f, up));
    const u = cross3(s, f);
    return new Float32Array([
        s[0], u[0], -f[0], 0,
        s[1], u[1], -f[1], 0,
        s[2], u[2], -f[2], 0,
        -dot3(s, eye), -dot3(u, eye), dot3(f, eye), 1
    ]);
};

const perspective = (fovY: number, aspect: number, near: number, far: number) => {
    const f = 1 / Math.tan(fovY / 2);
    const nf = 1 / (near - far);
    return new Float32Array([
        f / aspect, 0, 0, 0,
        0, f, 0, 0,
        0, 0, (far + near) * nf, -1,
        0, 0, 2 * far * near * nf, 0
    ]);
};

const mul = (a: Float32Array, b: Float32Array) => {
    const out = new Float32Array(16);
    for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
            let v = 0;
            for (let k = 0; k < 4; k++) v += a[k * 4 + j] * b[i * 4 + k];
            out[i * 4 + j] = v;
        }
    }
    return out;
};

class PreviewRenderer {
    private device: GPUDevice;
    private canvas: HTMLCanvasElement;
    private context: GPUCanvasContext;
    private uniformBuffer: GPUBuffer;
    private pipeline: GPURenderPipeline;
    private bindGroup: GPUBindGroup | null = null;
    private current: SplatBuffers | null = null;

    // orbit state
    private azimuth = 0.6;
    private elevation = 0.4;
    private distance = 6;
    private target: Vec3 = [0, 0, 0];
    private dragging = false;
    private lastX = 0;
    private lastY = 0;

    pointRadiusPx = 3;

    constructor(device: GPUDevice, canvas: HTMLCanvasElement) {
        this.device = device;
        this.canvas = canvas;

        const context = canvas.getContext('webgpu');
        if (!context) {
            throw new Error('WebGPU canvas context unavailable');
        }
        this.context = context;
        const format = navigator.gpu.getPreferredCanvasFormat();
        this.context.configure({ device, format, alphaMode: 'opaque' });

        const module = device.createShaderModule({ code: SHADER });
        this.pipeline = device.createRenderPipeline({
            layout: 'auto',
            vertex: { module, entryPoint: 'vs' },
            fragment: {
                module,
                entryPoint: 'fs',
                targets: [{
                    format,
                    blend: {
                        color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }
                    }
                }]
            },
            primitive: { topology: 'triangle-strip' }
        });

        this.uniformBuffer = device.createBuffer({
            size: UNIFORM_SIZE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });

        canvas.addEventListener('pointerdown', (e) => {
            this.dragging = true;
            this.lastX = e.clientX;
            this.lastY = e.clientY;
            canvas.setPointerCapture(e.pointerId);
        });
        canvas.addEventListener('pointermove', (e) => {
            if (!this.dragging) return;
            this.azimuth -= (e.clientX - this.lastX) * 0.008;
            this.elevation += (e.clientY - this.lastY) * 0.008;
            this.elevation = Math.max(-1.5, Math.min(1.5, this.elevation));
            this.lastX = e.clientX;
            this.lastY = e.clientY;
        });
        canvas.addEventListener('pointerup', (e) => {
            this.dragging = false;
            canvas.releasePointerCapture(e.pointerId);
        });
        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            this.distance *= Math.exp(e.deltaY * 0.001);
            this.distance = Math.max(0.2, Math.min(100, this.distance));
        }, { passive: false });
    }

    bindExternal(buffers: SplatBuffers) {
        const same = this.current &&
            this.current.transforms === buffers.transforms &&
            this.current.shCoeffs === buffers.shCoeffs &&
            this.current.rawOpacities === buffers.rawOpacities;

        if (!same) {
            this.bindGroup = this.device.createBindGroup({
                layout: this.pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: this.uniformBuffer } },
                    { binding: 1, resource: { buffer: buffers.transforms } },
                    { binding: 2, resource: { buffer: buffers.shCoeffs } },
                    { binding: 3, resource: { buffer: buffers.rawOpacities } }
                ]
            });
        }
        this.current = buffers;
    }

    render() {
        const w = Math.max(1, this.canvas.clientWidth | 0);
        const h = Math.max(1, this.canvas.clientHeight | 0);
        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w;
            this.canvas.height = h;
        }

        const ce = Math.cos(this.elevation);
        const eye: Vec3 = [
            this.target[0] + this.distance * ce * Math.sin(this.azimuth),
            this.target[1] + this.distance * Math.sin(this.elevation),
            this.target[2] + this.distance * ce * Math.cos(this.azimuth)
        ];

        const view = lookAt(eye, this.target, [0, 1, 0]);
        const proj = perspective(1.0, w / h, 0.02, 500);
        const uniforms = new ArrayBuffer(UNIFORM_SIZE);
        const f32 = new Float32Array(uniforms);
        const u32 = new Uint32Array(uniforms);
        f32.set(mul(proj, view), 0);
        f32[16] = 1 / w;
        f32[17] = 1 / h;
        f32[18] = this.pointRadiusPx;
        u32[19] = this.current ? 10 : 0;
        u32[20] = this.current ? this.current.shStride : 0;
        this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);

        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: this.context.getCurrentTexture().createView(),
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: 0.05, g: 0.05, b: 0.06, a: 1 }
            }]
        });

        if (this.current && this.bindGroup) {
            pass.setPipeline(this.pipeline);
            pass.setBindGroup(0, this.bindGroup);
            pass.draw(4, this.current.count, 0, 0);
        }
        pass.end();
        this.device.queue.submit([encoder.finish()]);
    }
}

export { PreviewRenderer };
