import {
    BLENDEQUATION_ADD,
    BLENDMODE_ONE,
    BLENDMODE_ONE_MINUS_SRC_ALPHA,
    BLENDMODE_ZERO,
    BlendState,
    Color,
    FILTER_NEAREST,
    PIXELFORMAT_RGBA16F,
    RenderPassPicker,
    RenderTarget,
    Texture
} from 'playcanvas';

import { ElementType } from './element';
import { Events } from './events';
import type { PassName, RenderPassSettings } from './inspect-ops';
import { encodePng } from './png-writer';
import { Scene } from './scene';
import { Splat } from './splat';
import { resolveTime } from './time-map';

/**
 * Render passes: the scene rendered frame by frame to one image sequence
 * per pass, for compositing in Nuke, Resolve or After Effects.
 *
 * - beauty: what the video export renders, through the camera node's lens,
 *   on a transparent background (PNG, RGBA)
 * - alpha: the beauty's coverage (PNG, grey)
 * - depth: view depth in scene units, blended the way the colour is, so a
 *   pixel holds the coverage-weighted depth of what it shows; 0 where
 *   nothing is (EXR, 32-bit float channel Z)
 * - velocity: how far what a pixel shows moves on screen by the next
 *   frame, in pixels, x right and y up - the objects' own motion, not the
 *   camera's (EXR, float channels R and G)
 * - matte: how much of a pixel the selected gaussians cover, behind what
 *   is in front of them (PNG, grey)
 *
 * Depth, velocity and matte come from the picker's blended pass
 * (pickMode 2 and 3 in shaders/splat-shader.ts), which renders into the
 * camera's half-float colour target: colour = sum of weight * value,
 * alpha = what light is left. They see the gaussians sharp, without depth
 * of field or the lens, as data passes are.
 */

type PassSink = {
    write(name: string, bytes: Uint8Array): Promise<void>;
    close(): Promise<void>;
};

const nullClr = new Color(0, 0, 0, 0);
const passClear = new Color(0, 0, 0, 1);

// colour: added, weighted; alpha: what light is left, T = T * (1 - a)
const passBlend = new BlendState(
    true,
    BLENDEQUATION_ADD, BLENDMODE_ONE, BLENDMODE_ONE_MINUS_SRC_ALPHA,
    BLENDEQUATION_ADD, BLENDMODE_ZERO, BLENDMODE_ONE_MINUS_SRC_ALPHA
);

const half2Float = (h: number) => {
    const s = (h & 0x8000) ? -1 : 1;
    const e = (h >> 10) & 0x1f;
    const f = h & 0x3ff;
    if (e === 0) return s * f * 2 ** -24;
    if (e === 31) return f ? NaN : s * Infinity;
    return s * (1 + f / 1024) * 2 ** (e - 15);
};

/**
 * An uncompressed scanline OpenEXR file of 32-bit float channels, rows top
 * down. `channels` maps a channel name to width * height values; EXR wants
 * them in alphabetical order, which is the order they are written in.
 */
const encodeExr = (width: number, height: number, channels: Record<string, Float32Array>) => {
    const names = Object.keys(channels).sort();
    const header: number[] = [];
    const bytes = (...b: number[]) => header.push(...b);
    const int32 = (v: number) => bytes(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255);
    const str = (s: string) => {
        for (let i = 0; i < s.length; i++) bytes(s.charCodeAt(i));
        bytes(0);
    };
    const f32 = (v: number) => {
        const b = new Uint8Array(new Float32Array([v]).buffer);
        bytes(...b);
    };
    const attr = (name: string, type: string, size: number, write: () => void) => {
        str(name);
        str(type);
        int32(size);
        write();
    };

    int32(20000630);
    int32(2);
    attr('channels', 'chlist', names.reduce((n, c) => n + c.length + 1 + 16, 1), () => {
        names.forEach((c) => {
            str(c);
            int32(2);           // FLOAT
            bytes(0, 0, 0, 0);  // pLinear, reserved
            int32(1);
            int32(1);
        });
        bytes(0);
    });
    attr('compression', 'compression', 1, () => bytes(0));
    const box = () => {
        int32(0);
        int32(0);
        int32(width - 1);
        int32(height - 1);
    };
    attr('dataWindow', 'box2i', 16, box);
    attr('displayWindow', 'box2i', 16, box);
    attr('lineOrder', 'lineOrder', 1, () => bytes(0));
    attr('pixelAspectRatio', 'float', 4, () => f32(1));
    attr('screenWindowCenter', 'v2f', 8, () => {
        f32(0);
        f32(0);
    });
    attr('screenWindowWidth', 'float', 4, () => f32(1));
    bytes(0);

    const lineBytes = names.length * width * 4;
    const blockBytes = 8 + lineBytes;
    const tableAt = header.length;
    const dataAt = tableAt + height * 8;
    const out = new Uint8Array(dataAt + height * blockBytes);
    out.set(header);
    const view = new DataView(out.buffer);
    for (let y = 0; y < height; y++) {
        const at = dataAt + y * blockBytes;
        view.setUint32(tableAt + y * 8, at % 2 ** 32, true);
        view.setUint32(tableAt + y * 8 + 4, Math.floor(at / 2 ** 32), true);
        view.setInt32(at, y, true);
        view.setInt32(at + 4, lineBytes, true);
        // the header leaves the rows at any byte offset, so they go in as bytes
        names.forEach((c, k) => {
            const values = channels[c].subarray(y * width, (y + 1) * width);
            out.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), at + 8 + k * width * 4);
        });
    }
    return out;
};

/** Read back the rows top down: WebGL reads them bottom up. */
const flipRows = <T extends Uint8Array | Uint16Array>(data: T, width: number, height: number, flip: boolean) => {
    if (!flip) return data;
    const stride = width * 4;
    const line = data.slice(0, stride) as T;
    for (let y = 0; y < height / 2; y++) {
        const top = y * stride;
        const bottom = (height - y - 1) * stride;
        line.set(data.subarray(top, top + stride));
        data.copyWithin(top, bottom, bottom + stride);
        data.set(line, bottom);
    }
    return data;
};

/** A grey PNG of one value per pixel in 0..1. */
const greyPng = (values: (i: number) => number, width: number, height: number) => {
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        const v = Math.round(Math.max(0, Math.min(1, values(i))) * 255);
        rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v;
        rgba[i * 4 + 3] = 255;
    }
    return encodePng(rgba, width, height);
};

/** How far one timeline frame moves a 4D object's model, in its normalised time. */
const motionStep = (splat: Splat, frame: number) => {
    const frames = splat.motionFrames;
    if (!(frames > 0)) return 0;
    const at = resolveTime(splat.timeMaps, frames, frame);
    const next = resolveTime(splat.timeMaps, frames, frame + 1);
    if (at !== null && next !== null) return (next - at) / frames;
    const prev = resolveTime(splat.timeMaps, frames, frame - 1);
    if (at !== null && prev !== null) return (at - prev) / frames;
    return 0;
};

const pad = (n: number) => `${n}`.padStart(4, '0');

/**
 * Render the passes asked for over the frames asked for, into `sink`.
 * Returns how many frames were written, or -1 when cancelled.
 */
const renderPasses = async (scene: Scene, events: Events, settings: RenderPassSettings, sink: PassSink) => {
    const { passes, width, height, filename } = settings;
    const device = scene.graphicsDevice;
    const lastFrame = Math.max(0, (events.invoke('timeline.frames') ?? 1) - 1);
    const start = Math.max(0, Math.min(lastFrame, Math.round(settings.startFrame)));
    const end = Math.max(start, Math.min(lastFrame, settings.endFrame === null ? lastFrame : Math.round(settings.endFrame)));
    const wanted = (p: PassName) => !!passes[p];
    const dataPass = wanted('depth') || wanted('velocity');

    const visible = () => (scene.getElementsByType(ElementType.splat) as Splat[]).filter(s => s.visible && !s.timeHidden);
    const postRender = () => new Promise<void>((resolve) => {
        const handle = scene.events.on('postrender', () => {
            handle.off();
            resolve();
        });
    });
    const sortAndWait = (splats: Splat[]) => Promise.all(splats.map(splat => new Promise<void>((resolve) => {
        const { instance } = splat.entity.gsplat;
        instance.sorter.once('updated', resolve);
        instance.sort(scene.camera.mainCamera);
        setTimeout(resolve, 1000);
    })));

    let cancelled = false;
    const cancel = events.on('progressCancel', () => {
        cancelled = true;
    });
    events.fire('progressStart', 'Render passes', true);

    const picker = new RenderPassPicker(device, scene.app.renderer);
    const flip = !device.isWebGPU;

    // the data passes' own half-float target, so the frame's is left alone
    const dataTexture = new Texture(device, {
        name: 'renderPassData',
        width,
        height,
        format: PIXELFORMAT_RGBA16F,
        mipmaps: false,
        minFilter: FILTER_NEAREST,
        magFilter: FILTER_NEAREST
    });
    const dataTarget = new RenderTarget({ colorBuffer: dataTexture, depth: false, autoResolve: false });

    // one blended pass of the picker's into the half-float colour target
    const blended = async (mode: number, frame: number) => {
        visible().forEach((s) => {
            if (s.motion) s.entity.gsplat.instance.material.setParameter('passMotionStep', motionStep(s, frame));
        });
        device.scope.resolve('pickOp').setValue(2);
        device.scope.resolve('pickMode').setValue(mode);
        const target = dataTarget;
        picker.blendState = passBlend;
        picker.init(target);
        picker.setClearColor(passClear);
        picker.update(scene.camera.camera, scene.app.scene, [scene.splatLayer], new Map(), false);
        picker.render();
        device.scope.resolve('pickMode').setValue(0);
        // the read lands with the next frame's submit: one is rendered for it
        const read = target.colorBuffer.read(0, 0, width, height, { renderTarget: target, immediate: device.isWebGPU });
        scene.lockedRender = true;
        await postRender();
        const pixels = await read as Uint16Array;
        return flipRows(pixels.slice(), width, height, flip);
    };

    let written = 0;
    try {
        scene.camera.startOffscreenMode(width, height);
        scene.camera.renderOverlays = false;
        scene.gizmoLayer.enabled = false;
        scene.camera.clearPass.setClearColor(nullClr);
        scene.lockedRenderMode = true;

        const rgba = new Uint8Array(width * height * 4);
        const count = width * height;

        for (let frame = start; frame <= end; frame++) {
            if (cancelled) break;

            // the frame, the camera at it, and every object's order for it
            events.fire('timeline.time', frame);
            scene.camera.onUpdate(0);
            await events.invoke('plysequence.setFrameAsync', frame);
            scene.camera.onUpdate(0);
            await sortAndWait(visible());

            scene.lockedRender = true;
            await postRender();
            for (let i = 0; i < 4 && events.invoke('relight.settled') === false; i++) {
                scene.lockedRender = true;
                await postRender();
            }

            const name = (pass: PassName, ext: string) => `${filename}_${pass}.${pad(frame)}.${ext}`;

            if (wanted('beauty') || wanted('alpha')) {
                const { workTarget } = scene.camera;
                scene.camera.blitWithLens(workTarget);
                await workTarget.colorBuffer.read(0, 0, width, height, { renderTarget: workTarget, data: rgba, immediate: device.isWebGPU });
                flipRows(rgba, width, height, flip);
                if (wanted('beauty')) await sink.write(name('beauty', 'png'), await encodePng(rgba, width, height));
                if (wanted('alpha')) await sink.write(name('alpha', 'png'), await greyPng(i => rgba[i * 4 + 3] / 255, width, height));
            }

            if (dataPass) {
                const px = await blended(2, frame);
                const z = new Float32Array(count);
                const vx = new Float32Array(count);
                const vy = new Float32Array(count);
                for (let i = 0; i < count; i++) {
                    const cover = 1 - half2Float(px[i * 4 + 3]);
                    if (cover < 1e-4) continue;
                    z[i] = half2Float(px[i * 4]) / cover;
                    vx[i] = half2Float(px[i * 4 + 1]) / cover * width * 0.5;
                    vy[i] = half2Float(px[i * 4 + 2]) / cover * height * 0.5;
                }
                if (wanted('depth')) await sink.write(name('depth', 'exr'), encodeExr(width, height, { Z: z }));
                if (wanted('velocity')) await sink.write(name('velocity', 'exr'), encodeExr(width, height, { R: vx, G: vy }));
            }

            if (wanted('matte')) {
                const px = await blended(3, frame);
                await sink.write(name('matte', 'png'), await greyPng(i => half2Float(px[i * 4]), width, height));
            }

            written++;
            events.fire('progressUpdate', {
                text: `frame ${frame - start + 1} of ${end - start + 1}`,
                progress: 100 * (frame - start + 1) / (end - start + 1)
            });
        }
        await sink.close();
    } finally {
        cancel.off();
        picker.destroy();
        dataTarget.destroy();
        dataTexture.destroy();
        scene.camera.endOffscreenMode();
        scene.camera.renderOverlays = true;
        scene.gizmoLayer.enabled = true;
        scene.camera.clearPass.setClearColor(nullClr);
        scene.lockedRenderMode = false;
        scene.forceRender = true;
        events.fire('progressEnd');
    }
    return cancelled ? -1 : written;
};

export { type PassSink, renderPasses, encodeExr, half2Float };
