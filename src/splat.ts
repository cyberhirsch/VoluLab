import {
    ADDRESS_CLAMP_TO_EDGE,
    FILTER_NEAREST,
    PIXELFORMAT_R8,
    PIXELFORMAT_R16U,
    PIXELFORMAT_R32F,
    PIXELFORMAT_RGBA32F,
    Asset,
    BoundingBox,
    Color,
    Entity,
    GSplatData,
    GSplatResource,
    Mat4,
    Quat,
    Texture,
    Vec3
} from 'playcanvas';

import { GradeParams, gradeMatrix } from './color-grade';
import { CameraSettings } from './edit-ops';
import { Element, ElementType } from './element';
import { Grade, GradePalette } from './grade-palette';
import { MotionLayout, MotionSorter } from './motion-sort';
import type { RelightSettings } from './relight/relighter';
import { Serializer } from './serializer';
import { vertexShader, fragmentShader, gsplatCenter, gsplatModify, vertexShaderWGSL, fragmentShaderWGSL, gsplatCenterWGSL, gsplatModifyWGSL } from './shaders/splat-shader';
import { DebugResolved, DebugStash, DebugView, debugChannelAvailable, resolveDebugView } from './splat-debug';
import { State, SplatState } from './splat-state';
import { TimeMap, resolveTime, timeSpan } from './time-map';
import { Transform } from './transform';
import { TransformPalette } from './transform-palette';

const vec = new Vec3();
const veca = new Vec3();
const vecb = new Vec3();
const quat = new Quat();

/**
 * A 4D gaussian model played on the GPU: the splat data holds each
 * gaussian at its own temporal centre, and a frame at time t moves it along
 * its velocity and fades it by its temporal falloff in the vertex shader.
 * Rows match the splat data's.
 */
type SplatMotion = {
    // xyz: velocity per unit normalised time, w: temporal centre
    velocityTime: Float32Array;
    // 1 / (2 sigma_t^2)
    falloff: Float32Array;
    // the rows in the active set at time t, or null for all of them. The
    // same array for as long as the set is the same: what reads it tells a
    // change of set by it (see Splat.motionActive, MotionCenters)
    activeAt?: (t: number) => Uint32Array | null;
    // the same hierarchy as blocks of rows, for the sort worker, which
    // works out the active set itself. Without it every row is always drawn
    layout?: () => MotionLayout;
    // per row, the hierarchy level it is on (-1: the global set) and whether
    // it stands still for the whole sequence. Built when asked for: only the
    // debug view reads it
    hierarchy?: () => { level: Int8Array, still: Uint8Array };
};

const boundingPoints =
    [-1, 1].map((x) => {
        return [-1, 1].map((y) => {
            return [-1, 1].map((z) => {
                return [
                    new Vec3(x, y, z), new Vec3(x * 0.75, y, z),
                    new Vec3(x, y, z), new Vec3(x, y * 0.75, z),
                    new Vec3(x, y, z), new Vec3(x, y, z * 0.75)
                ];
            });
        });
    }).flat(3);

class Splat extends Element {
    asset: Asset;
    splatData: GSplatData;
    numSplats = 0;
    numDeleted = 0;
    numLocked = 0;
    numSelected = 0;
    entity: Entity;
    changedCounter = 0;
    stateTexture: Texture;
    // encapsulates per-splat state mirror (cpu Uint8Array + gpu Texture).
    // all writes go through state.setBits/clearBits/toggleBits, then flush().
    state: SplatState;
    transformTexture: Texture;
    /** per-gaussian index into gradePalette; 0 means no colour node has touched it */
    gradeTexture: Texture;
    selectionBoundStorage: BoundingBox;
    localBoundStorage: BoundingBox;
    // what is drawn now: for a 4D model, at the time shown, while
    // localBound covers the whole sequence; otherwise the same as localBound
    shownBoundStorage = new BoundingBox();
    // the time and active set selectionBound and shownBound were measured at
    private boundsTime = NaN;
    private boundsActive: Uint32Array | null = null;
    worldBoundStorage: BoundingBox;

    _visible = true;
    transformPalette: TransformPalette;
    gradePalette: GradePalette;

    selectionAlpha = 1;

    _name = '';
    _tintClr = new Color(1, 1, 1);
    _temperature = 0;
    _saturation = 1;
    _shBandLimit = 3;

    /**
     * This object's relight node's settings while the node is applied, or
     * null. The node sets and clears it; the relighter reads it each frame.
     */
    relight: RelightSettings | null = null;
    _exposure = 0;
    _brightness = 0;
    _blackPoint = 0;
    _whitePoint = 1;
    _transparency = 1;

    measurePoints: Vec3[] = [];
    measureSelection = -1;

    orientPoints: Vec3[] = [];
    orientSelection = -1;

    // user-defined local frame (relative to the data frame), set from the
    // orient tool's picked plane: origin at the first picked point, rotation
    // aligning +y with the plane normal. the transform gizmos and panel use
    // it as the model's local coordinate space; the gaussian data is
    // unaffected. the defaults reproduce the entity's own frame
    localFrameOrigin = new Vec3();
    localFrame = new Quat();

    rebuildMaterial: (bands: number) => void;

    // GPU playback of a 4D model, if this splat is one (see setMotion)
    motion: SplatMotion | null = null;
    // the time asked for last. What is drawn follows within a sort
    motionTime = 0;
    private motionTexture: Texture | null = null;
    private falloffTexture: Texture | null = null;
    // sorts the model in a worker of its own (see motion-sort.ts)
    private motionSorter: MotionSorter | null = null;
    // the time of the order being drawn, which is the time the shader gets:
    // an order is of the active set at its own time, and drawn at another
    // time it shows gaussians outside the segment they were trained in.
    // The sorter says which time each order is of
    private shaderTime = 0;

    /**
     * The time nodes applied to this object, in the order of its chain; the
     * nodes add and remove themselves (see time-map.ts, TimeOp). They decide
     * which frame of the model a frame of the timeline shows.
     */
    timeMaps: TimeMap[] = [];
    // how many frames the model's own sequence has; 0 until it is shown
    motionFrames = 0;
    // the timeline frame asked for last
    timelineFrame = 0;
    // a time node shows nothing of the object at that frame
    timeHidden = false;

    // What the layer nodes come to for this object (combine.ts): hidden by
    // a layer or by another's solo, its opacity multiplied, and locked
    // against the viewport's selection tools. `visible` stays the user's.
    layerHidden = false;
    layerOpacity = 1;
    layerLocked = false;

    /**
     * The debug view nodes applied to this object, in the order of its
     * chain. The last one decides what is drawn; the nodes add and remove
     * themselves (see DebugViewOp). Each holds the colour state it took the
     * place of (see addDebugView).
     */
    debugViews: DebugView[] = [];
    /** what the last of them resolved to, or null when the object draws its own colour */
    debugShown: DebugResolved | null = null;
    // one byte per gaussian, for the channels the shader cannot work out
    private debugTexture: Texture | null = null;

    constructor(asset: Asset, rotation: Quat) {
        super(ElementType.splat);

        const { device } = asset.resource as GSplatResource;

        // create the entity once. its transform persists across frame swaps so
        // an animated sequence can replace its data without losing the user's
        // transform (see replaceData).
        this.entity = new Entity('splatEntity');

        this.selectionBoundStorage = new BoundingBox();

        // create the transform palette (reused across frame swaps; index 0 is identity)
        this.transformPalette = new TransformPalette(device);

        // and the colour grade palette, on the same contract
        this.gradePalette = new GradePalette(device);

        // rebuilds material chunks/params. reads the *current* gsplat instance and
        // state/transform textures so it remains valid after a replaceData swap
        // (the 'view.bands' listener registered in add() keeps pointing at it).
        this.rebuildMaterial = (bands: number) => {
            const instance = this.entity.gsplat.instance;
            const { material } = instance;
            // both dialects: WebGL2 composes from the glsl map, WebGPU from
            // the wgsl map - an override present in only one silently reverts
            // to the engine default on the other backend
            const { glsl, wgsl } = material.shaderChunks;
            glsl.set('gsplatVS', vertexShader);
            glsl.set('gsplatPS', fragmentShader);
            glsl.set('gsplatCenterVS', gsplatCenter);
            glsl.set('gsplatModifyVS', gsplatModify);
            wgsl.set('gsplatVS', vertexShaderWGSL);
            wgsl.set('gsplatPS', fragmentShaderWGSL);
            wgsl.set('gsplatCenterVS', gsplatCenterWGSL);
            wgsl.set('gsplatModifyVS', gsplatModifyWGSL);

            // three limits meet here: what the view asks for, what this object
            // has been capped to by an sh-bands node, and what the data holds
            const available = (instance.resource as GSplatResource).shBands;
            material.setDefine('SH_BANDS', `${Math.min(bands, this._shBandLimit, available)}`);
            material.setParameter('splatState', this.stateTexture);
            material.setParameter('splatTransform', this.transformTexture);
            material.setParameter('splatGrade', this.gradeTexture);
            if (this.motionTexture) {
                material.setDefine('SPLAT_MOTION', '');
                material.setParameter('splatMotion', this.motionTexture);
                material.setParameter('splatFalloff', this.falloffTexture);
                material.setParameter('motionTime', this.shaderTime);
            }

            // the debug view: a define, so an object without one pays nothing
            const debug = this.debugShown;
            material.setDefine('SPLAT_DEBUG', debug ? '' : undefined);
            material.setDefine('SPLAT_DEBUG_TEX', debug && this.debugTexture ? '' : undefined);
            if (debug) {
                material.setParameter('debugMode', debug.mode);
                material.setParameter('debugParams', debug.params);
            }
            if (debug && this.debugTexture) {
                material.setParameter('splatDebug', this.debugTexture);
            } else {
                material.deleteParameter('splatDebug');
            }
            material.update();
        };

        // bind the initial frame's data, applying the file's load rotation
        this.bindAsset(asset, rotation);
    }

    // bind a gsplat asset onto this element's entity: creates the gsplat
    // component, the per-splat state/transform channels and their gpu textures,
    // and caches the instance bounds. When `rotation` is supplied (initial load)
    // the entity rotation is set; on a frame swap it is omitted so the user's
    // transform is preserved.
    private bindAsset(asset: Asset, rotation?: Quat) {
        const splatResource = asset.resource as GSplatResource;
        const splatData = splatResource.gsplatData as GSplatData;
        const { device } = splatResource;

        this.asset = asset;
        this.splatData = splatData;
        this.numSplats = splatData.numSplats;

        // name and orientation are set on the initial bind only; a frame swap
        // (replaceData, no rotation) keeps the element's name and transform
        if (rotation) {
            this._name = (asset.file as any).filename;
            this.entity.setLocalRotation(rotation);
        }

        this.entity.addComponent('gsplat', {
            asset,
            unified: false
        });

        const instance = this.entity.gsplat.instance;

        // added per-splat state channel
        // bit 1: selected
        // bit 2: deleted
        // bit 3: locked
        if (!splatData.getProp('state')) {
            splatData.getElement('vertex').properties.push({
                type: 'uchar',
                name: 'state',
                storage: new Uint8Array(splatData.numSplats),
                byteSize: 1
            });
        }

        // per-splat transform matrix
        splatData.getElement('vertex').properties.push({
            type: 'ushort',
            name: 'transform',
            storage: new Uint16Array(splatData.numSplats),
            byteSize: 2
        });

        const { x: width, y: height } = (splatResource as any).textureDimensions;

        // pack spherical harmonic data
        const createTexture = (name: string, format: number) => {
            return new Texture(device, {
                name: name,
                width: width,
                height: height,
                format: format,
                mipmaps: false,
                minFilter: FILTER_NEAREST,
                magFilter: FILTER_NEAREST,
                addressU: ADDRESS_CLAMP_TO_EDGE,
                addressV: ADDRESS_CLAMP_TO_EDGE
            });
        };

        // create the state texture and the SplatState mirror that owns it.
        // splatData.getProp('state') aliases state.data so existing read-only
        // consumers (serialize, status-bar, etc) keep working unchanged.
        this.stateTexture = createTexture('splatState', PIXELFORMAT_R8);
        this.state = new SplatState(splatData.getProp('state') as Uint8Array, this.stateTexture);
        this.transformTexture = createTexture('splatTransform', PIXELFORMAT_R16U);
        this.gradeTexture = createTexture('splatGrade', PIXELFORMAT_R16U);

        this.localBoundStorage = instance.resource.aabb;
        // @ts-ignore
        this.worldBoundStorage = instance.meshInstance._aabb;

        // @ts-ignore
        instance.meshInstance._updateAabb = false;

        // when sort changes, re-render the scene
        instance.sorter.on('updated', () => {
            this.changedCounter++;
        });

        // a 4D model whose data was swapped: the new instance has the
        // engine's sort worker again
        if (this.motion) {
            this.attachMotionSorter();
        }
    }

    // put the model's own sort worker in the place of the engine's
    private attachMotionSorter() {
        const instance = this.entity.gsplat.instance;
        const { sorter, material } = instance;
        this.motionSorter?.destroy();
        this.motionSorter = new MotionSorter(sorter, {
            centers: sorter.centers,
            velocityTime: this.motion.velocityTime,
            falloff: this.motion.falloff,
            layout: this.motion.layout?.() ?? null
        }, (t) => {
            // the order that draws next is of time t
            this.shaderTime = t;
            material.setParameter('motionTime', t);
            this.changedCounter++;
        });
        if (this.state.numDeleted) {
            this.motionSorter.setDeleted(this.state.data, State.deleted);
        }
        this.motionSorter.show(this.motionTime);
        // The instance tells its sorter the camera only when it has moved,
        // and only when it is drawn; what it told so far went to the
        // engine's worker. Without a camera nothing is sorted, and without
        // a sort nothing asks for a frame - so it is told again, now.
        (instance as any).lastCameraPosition.set(NaN, NaN, NaN);
        if (this.scene) {
            this.scene.forceRender = true;
        }
    }

    // wait for the next scene render to complete, with a safety timeout so a
    // stalled render loop (e.g. a backgrounded tab where rAF is paused) can't
    // block frame swapping forever. In a live app postrender fires within a
    // frame, so the timeout never matters.
    private waitForRender(): Promise<void> {
        return new Promise((resolve) => {
            // single finish() removes the listener and clears the timeout, so the
            // common case (postrender fires first) doesn't leave a pending timer.
            const handles: { off?: { off: () => void }, timer?: ReturnType<typeof setTimeout> } = {};
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                handles.off?.off();
                clearTimeout(handles.timer);
                resolve();
            };
            handles.off = this.scene.events.on('postrender', finish);
            // safety: don't block frame swapping forever if the render loop is stalled
            handles.timer = setTimeout(finish, 200);
        });
    }

    // swap in a new frame's gsplat data while preserving this element's identity,
    // transform and visual properties. used by animated sequence playback so each
    // frame doesn't recreate the whole element.
    //
    // The gsplat lives on this.entity (read in many places), so we can't double
    // buffer on a child. Instead we bind the new frame to a *fresh* entity, sort
    // it, and let it render once alongside the still-present old entity before
    // destroying the old one. This overlap avoids a blank/unsorted frame
    // flickering on screen during the swap (the old frame masks the new one's
    // first sort), matching the previous per-frame load behaviour. The user's
    // transform is carried across so it persists.
    async replaceData(asset: Asset) {
        const oldEntity = this.entity;
        const oldAsset = this.asset;
        const oldStateTexture = this.stateTexture;
        const oldTransformTexture = this.transformTexture;
        const oldGradeTexture = this.gradeTexture;
        // the old frame is drawn once more, with its debug texture
        const oldDebugTexture = this.debugTexture;
        this.debugTexture = null;

        // carry the current transform onto the new entity
        const position = oldEntity.getLocalPosition().clone();
        const rotation = oldEntity.getLocalRotation().clone();
        const scale = oldEntity.getLocalScale().clone();

        this.entity = new Entity('splatEntity');
        this.entity.setLocalPosition(position);
        this.entity.setLocalRotation(rotation);
        this.entity.setLocalScale(scale);

        // bind the new frame (no rotation: transform already applied above)
        this.bindAsset(asset);

        // the debug view is of the data, so it is worked out again for these
        this.buildDebugView();

        // add the new entity to the scene and configure its instance
        this.scene.contentRoot.addChild(this.entity);
        this.entity.gsplat.layers = [this.scene.splatLayer.id];
        this.rebuildMaterial(this.scene.events.invoke('view.bands'));

        // refresh gpu state/counts/bounds, then wait for the new frame to render
        // before removing the old entity, which keeps the previous frame on screen
        // in the meantime. Skip the wait during offline video render
        // (lockedRenderMode): renders are gated on scene.lockedRender there, so
        // blocking on a render would deadlock — and the render loop sorts+captures
        // each frame deterministically anyway.
        await this.updateState(State.deleted);
        if (!this.scene.lockedRenderMode) {
            await this.waitForRender();
        }

        // notify dependents (e.g. the centers overlay, which parents itself under
        // this.entity) to re-bind to the new entity/instance before the old entity
        // is destroyed — otherwise they're torn down with it and never re-attach
        // (no selection.changed fires on a frame swap).
        this.scene.events.fire('splat.replaced', this);

        // tear down the previous frame
        oldEntity.destroy();
        oldStateTexture.destroy();
        oldTransformTexture.destroy();
        oldGradeTexture?.destroy();
        oldDebugTexture?.destroy();
        oldAsset.registry?.remove(oldAsset);
        oldAsset.unload();

        this.changedCounter++;
        this.scene.forceRender = true;
    }

    /**
     * Make this splat a 4D model played on the GPU. Its data must hold every
     * gaussian at its temporal centre; showTime then picks the frame.
     */
    setMotion(motion: SplatMotion) {
        const { device } = this.asset.resource as GSplatResource;
        const { x: width, y: height } = (this.asset.resource as any).textureDimensions;
        const texture = (name: string, format: number, data: Float32Array, stride: number) => {
            const padded = new Float32Array(width * height * stride);
            padded.set(data.subarray(0, Math.min(data.length, padded.length)));
            return new Texture(device, {
                name,
                width,
                height,
                format,
                mipmaps: false,
                minFilter: FILTER_NEAREST,
                magFilter: FILTER_NEAREST,
                addressU: ADDRESS_CLAMP_TO_EDGE,
                addressV: ADDRESS_CLAMP_TO_EDGE,
                levels: [padded]
            });
        };
        this.motionTexture?.destroy();
        this.falloffTexture?.destroy();
        this.motion = motion;
        this.motionTexture = texture('splatMotion', PIXELFORMAT_RGBA32F, motion.velocityTime, 4);
        this.falloffTexture = texture('splatFalloff', PIXELFORMAT_R32F, motion.falloff, 1);
        this.attachMotionSorter();
        // a debug node asking for a motion channel had nothing to show until now
        if (this.debugViews.length) {
            this.debugTexture?.destroy();
            this.buildDebugView();
            this.scene?.events.fire('splat.debugView', this);
        }
        // set before the splat is added (sequence.ts does, so it is never
        // drawn without its motion), add() builds the material instead
        if (this.scene) {
            this.rebuildMaterial(this.scene.events.invoke('view.bands'));
        }
    }

    /**
     * Show the 4D model at normalised time t. The GPU moves and fades the
     * gaussians; the depth order at t comes from the sort worker, which
     * holds the model, so a frame costs the main thread one message. The
     * shader's time follows when that order is in (see shaderTime).
     */
    showTime(t: number) {
        this.motionTime = t;
        this.motionSorter.show(t);
    }

    /** How many frames the object's sequence has, as its time nodes leave it. */
    get timeSpan() {
        return timeSpan(this.timeMaps, this.motionFrames);
    }

    /**
     * Show the 4D model at a frame of the timeline. This is where the time
     * nodes apply: the frame goes through them and comes out as a frame of
     * the model, which is the time the shader and the sort worker get.
     * Asked for the time it already shows, it does nothing - except in the
     * video export, which waits for a sort of every frame it steps to.
     */
    showFrame(frame: number, frames = this.motionFrames) {
        const stepped = frame !== this.timelineFrame || frames !== this.motionFrames;
        this.motionFrames = frames;
        this.timelineFrame = frame;
        if (!this.motion || !(frames > 0)) return;
        const at = resolveTime(this.timeMaps, frames, frame);
        if ((at === null) !== this.timeHidden) {
            this.timeHidden = at === null;
            if (this.scene) this.scene.forceRender = true;
        }
        if (at !== null && (at / frames !== this.motionTime || (stepped && this.scene?.lockedRenderMode))) {
            this.showTime(at / frames);
        }
    }

    /** The time nodes changed: show the frame again through them, and say so. */
    retime() {
        this.showFrame(this.timelineFrame);
        this.scene?.events.fire('splat.timeMaps', this);
    }

    /**
     * The gaussians in the active set at motionTime, or null for all of
     * them. Worked out when asked for - playback alone never asks - and the
     * same array until the set changes.
     */
    get motionActive(): Uint32Array | null {
        return this.motion?.activeAt ? this.motion.activeAt(this.motionTime) : null;
    }

    destroy() {
        super.destroy();
        this.motionSorter?.destroy();
        this.motionTexture?.destroy();
        this.falloffTexture?.destroy();
        this.debugTexture?.destroy();
        this.entity.destroy();
        this.stateTexture.destroy();
        this.transformTexture.destroy();
        this.gradeTexture.destroy();
        this.transformPalette.texture.destroy();
        this.gradePalette.texture.destroy();
        this.asset.registry?.remove(this.asset);
        this.asset.unload();
    }

    /**
     * A debug view node, applied: it is the last, so it is what is drawn.
     *
     * From here on the false colour is the object's colour, so the colour
     * chain starts again at this node. The grades put on so far - the
     * object's own and the slot each gaussian is on - graded the colour the
     * node replaces; they are set aside (view.stash) and the object is left
     * with none. Whatever colour node applies after this one then grades the
     * false colour, through the same two places every colour node writes
     * to, and the shader and the file writers need no second chain.
     * removeDebugView hands back what was set aside. History applies and
     * reverses in order, so by then everything put on since is off again.
     *
     * A node on a channel the object does not have takes nothing: the
     * object goes on drawing its own colour, with its own grades.
     */
    addDebugView(view: DebugView) {
        view.stash = null;
        if (debugChannelAvailable(this, view.channel)) {
            const slots = this.gradeTexture.lock() as Uint16Array;
            view.stash = this.colourState(slots);
            // What the false colour starts with: nothing - unless the node
            // came off with grades no node holds, which only a project's
            // node does (see removeDebugView), and then those.
            const { kept } = view;
            view.kept = null;
            slots.fill(0);
            if (kept?.slots.length === slots.length) {
                slots.set(kept.slots);
            }
            this.gradeTexture.unlock();
            this.setGrade(kept?.grade ?? {
                tintClr: new Color(1, 1, 1),
                temperature: 0,
                saturation: 1,
                exposure: 0,
                brightness: 0,
                blackPoint: 0,
                whitePoint: 1,
                transparency: 1
            });
        }
        this.debugViews.push(view);
        this.updateDebugView();
    }

    // the object's grade and the slot each gaussian is on, as they stand
    private colourState(slots: Uint16Array): DebugStash {
        return {
            grade: {
                tintClr: this._tintClr.clone(),
                temperature: this._temperature,
                saturation: this._saturation,
                exposure: this._exposure,
                brightness: this._brightness,
                blackPoint: this._blackPoint,
                whitePoint: this._whitePoint,
                transparency: this._transparency
            },
            slots: new Uint16Array(slots)
        };
    }

    /** A debug view node, undone or bypassed: the one before it shows again, or the colour. */
    removeDebugView(view: DebugView) {
        const index = this.debugViews.lastIndexOf(view);
        if (index !== -1) {
            this.debugViews.splice(index, 1);
            const { stash } = view;
            view.stash = null;
            if (stash) {
                const slots = this.gradeTexture.lock() as Uint16Array;
                // The colour nodes after this one are off by now and have
                // taken their grades with them. What is still on the false
                // colour is held by no node: the grades a project stored
                // with this one (docDeserializeDebugGrade). They stay with
                // it, for when it is applied again.
                const c = this._tintClr;
                const graded = c.r !== 1 || c.g !== 1 || c.b !== 1 || this._temperature !== 0 || this._saturation !== 1 ||
                    this._exposure !== 0 || this._brightness !== 0 || this._blackPoint !== 0 || this._whitePoint !== 1 ||
                    this._transparency !== 1;
                view.kept = graded || slots.some(slot => slot !== 0) ? this.colourState(slots) : null;
                // a sequence's next frame comes with slots of its own, all
                // unset, and the nodes that set them are applied again
                slots.fill(0);
                if (stash.slots.length === slots.length) {
                    slots.set(stash.slots);
                }
                this.gradeTexture.unlock();
                this.setGrade(stash.grade);
            }
            this.updateDebugView();
        }
    }

    /**
     * The grades on the object's own colour while a debug view node has
     * taken the colour chain over, or null when none has: what the first
     * such node set aside. A project and a training seed store the object's
     * own colour, and the histogram counts it.
     */
    get ownColour(): DebugStash | null {
        return this.debugViews.find(view => view.stash)?.stash ?? null;
    }

    /** The object's own grade: the one on its own colour, whatever a debug view shows. */
    get ownGrade(): GradeParams {
        return this.ownColour?.grade ?? this;
    }

    /**
     * For a project: the grades on the false colour - what colour nodes
     * after the last debug view node put on - or null when no debug view
     * holds the colour chain. A project keeps no colour nodes, so it keeps
     * what they came to: the object's grade as it stands, and per gaussian
     * the grade it is on, as an entry of `palette` plus one (0: none), one
     * per row the project's file has - the rows not deleted, in order.
     */
    docSerializeDebugGrade() {
        const last = this.debugViews[this.debugViews.length - 1];
        if (!last?.stash) return null;

        const state = this.state.data;
        const slots = new Uint16Array(this.gradeTexture.lock() as Uint16Array);
        this.gradeTexture.unlock();

        const palette: Grade[] = [];
        const entryOf = new Map<number, number>();
        const rows = new Uint16Array(state.length - this.state.numDeleted);
        let row = 0;
        for (let i = 0; i < state.length; i++) {
            if (state[i] & State.deleted) continue;
            const slot = slots[i];
            if (slot) {
                let entry = entryOf.get(slot);
                if (!entry) {
                    entry = palette.push(this.gradePalette.getGrade(slot));
                    entryOf.set(slot, entry);
                }
                rows[row] = entry;
            }
            row++;
        }

        const c = this._tintClr;
        return {
            grade: {
                tintClr: [c.r, c.g, c.b, c.a],
                temperature: this._temperature,
                saturation: this._saturation,
                exposure: this._exposure,
                brightness: this._brightness,
                blackPoint: this._blackPoint,
                whitePoint: this._whitePoint,
                transparency: this._transparency
            },
            palette,
            rows: palette.length ? rows : null
        };
    }

    /**
     * What docSerializeDebugGrade stored, put back on once the project's
     * debug view nodes are applied. Nothing is done when the last of them
     * shows nothing here - the object then draws its own colour, which
     * these grades were not for.
     */
    docDeserializeDebugGrade(stored: any, rows: Uint16Array | null) {
        const last = this.debugViews[this.debugViews.length - 1];
        const g = stored?.grade;
        if (!last?.stash || !g) return;

        this.setGrade({
            tintClr: new Color(g.tintClr[0], g.tintClr[1], g.tintClr[2], g.tintClr[3]),
            temperature: g.temperature ?? 0,
            saturation: g.saturation ?? 1,
            exposure: g.exposure ?? 0,
            brightness: g.brightness ?? 0,
            blackPoint: g.blackPoint ?? 0,
            whitePoint: g.whitePoint ?? 1,
            transparency: g.transparency ?? 1
        });

        const palette = (stored.palette ?? []) as Grade[];
        if (rows && palette.length && rows.length === this.splatData.numSplats) {
            const first = this.gradePalette.alloc(palette.length);
            palette.forEach((grade, k) => this.gradePalette.setGrade(first + k, grade));
            const slots = this.gradeTexture.lock() as Uint16Array;
            for (let i = 0; i < rows.length; i++) {
                slots[i] = rows[i] ? first + rows[i] - 1 : 0;
            }
            this.gradeTexture.unlock();
        }
        this.scene.forceRender = true;
    }

    // the object's grade, all eight at once
    private setGrade(grade: GradeParams) {
        this.tintClr = grade.tintClr;
        this.temperature = grade.temperature;
        this.saturation = grade.saturation;
        this.exposure = grade.exposure ?? 0;
        this.brightness = grade.brightness;
        this.blackPoint = grade.blackPoint;
        this.whitePoint = grade.whitePoint;
        this.transparency = grade.transparency;
    }

    /**
     * Work out again what the debug view shows. Called when a node comes or
     * goes or changes its channel - never per frame: the ranges are of the
     * data, and a frame of a 4D model changes none of it.
     */
    updateDebugView() {
        this.debugTexture?.destroy();
        this.buildDebugView();
        if (this.scene) {
            this.rebuildMaterial(this.scene.events.invoke('view.bands'));
            this.scene.forceRender = true;
            this.scene.events.fire('splat.debugView', this);
        }
    }

    // resolve the last debug view against the data as it is now and upload
    // what it needs; whoever calls this has dealt with the texture before
    private buildDebugView() {
        const view = this.debugViews[this.debugViews.length - 1];
        const resolved = view ? resolveDebugView(this, view.channel) : null;
        this.debugTexture = null;
        if (resolved?.values) {
            const { device } = this.asset.resource as GSplatResource;
            const { x: width, y: height } = (this.asset.resource as any).textureDimensions;
            const padded = new Uint8Array(width * height);
            padded.set(resolved.values.subarray(0, Math.min(resolved.values.length, padded.length)));
            this.debugTexture = new Texture(device, {
                name: 'splatDebug',
                width,
                height,
                format: PIXELFORMAT_R8,
                mipmaps: false,
                minFilter: FILTER_NEAREST,
                magFilter: FILTER_NEAREST,
                addressU: ADDRESS_CLAMP_TO_EDGE,
                addressV: ADDRESS_CLAMP_TO_EDGE,
                levels: [padded]
            });
            // the bytes are on the GPU now; the legend does not need them
            resolved.values = null;
        }
        this.debugShown = resolved;
    }

    async updateState(changedState = State.selected) {
        // uploads dirty range + refreshes counts in one pass.
        this.state.flush();
        this.numSplats = this.state.data.length - this.state.numDeleted;
        this.numLocked = this.state.numLocked;
        this.numSelected = this.state.numSelected;
        this.numDeleted = this.state.numDeleted;

        // handle splats being added or removed
        if (changedState & State.deleted) {
            await this.updateSorting();
        } else {
            await this.updateLocalBounds();
        }

        this.scene.forceRender = true;
        this.scene.events.fire('splat.stateChanged', this);
    }

    async updatePositions() {
        const data = await this.scene.dataProcessor.calcPositions(this);

        // update the splat centers which are used for render-time sorting
        const state = this.splatData.getProp('state') as Uint8Array;
        const { sorter } = this.entity.gsplat.instance;
        const { centers } = sorter;
        for (let i = 0; i < this.splatData.numSplats; ++i) {
            if (state[i] === State.selected) {
                centers[i * 3 + 0] = data[i * 4];
                centers[i * 3 + 1] = data[i * 4 + 1];
                centers[i * 3 + 2] = data[i * 4 + 2];
            }
        }
        this.motionSorter?.setCenters(centers);

        await this.updateSorting();

        this.scene.forceRender = true;
        this.scene.events.fire('splat.positionsChanged', this);
    }

    async updateSorting() {
        const state = this.splatData.getProp('state') as Uint8Array;

        if (this.motionSorter) {
            // a 4D model's sort worker leaves the deleted rows out itself
            this.motionSorter.setDeleted(this.numSplats !== state.length ? state : null, State.deleted);
        } else {
            let mapping;

            // create a sorter mapping to remove deleted splats
            if (this.numSplats !== state.length) {
                mapping = new Uint32Array(this.numSplats);
                let idx = 0;
                for (let i = 0; i < state.length; ++i) {
                    if ((state[i] & State.deleted) === 0) {
                        mapping[idx++] = i;
                    }
                }
            }

            // update sorting instance
            this.entity.gsplat.instance.sorter.setMapping(mapping);
        }

        // recalculate bounds after sorting changes
        await this.updateLocalBounds();
    }

    get worldTransform() {
        return this.entity.getWorldTransform();
    }

    set name(newName: string) {
        if (newName !== this.name) {
            this._name = newName;
            this.scene.events.fire('splat.name', this);
        }
    }

    get name() {
        return this._name;
    }

    get filename() {
        return (this.asset.file as any).filename;
    }

    calcSplatWorldPosition(splatId: number, result: Vec3) {
        if (splatId >= this.splatData.numSplats) {
            return false;
        }

        // use centers data, which are updated when edits occur
        const { sorter } = this.entity.gsplat.instance;
        const { centers } = sorter;

        result.set(
            centers[splatId * 3 + 0],
            centers[splatId * 3 + 1],
            centers[splatId * 3 + 2]
        );

        this.worldTransform.transformPoint(result, result);

        return true;
    }

    async add() {
        // add the entity to the scene
        this.scene.contentRoot.addChild(this.entity);

        // assign splat to the dedicated splat layer (rendered by splat camera with MRT)
        this.entity.gsplat.layers = [this.scene.splatLayer.id];

        this.scene.events.on('view.bands', this.rebuildMaterial, this);
        this.rebuildMaterial(this.scene.events.invoke('view.bands'));

        // we must update state in case the state data was loaded from ply
        await this.updateState();
    }

    remove() {
        this.scene.events.off('view.bands', this.rebuildMaterial, this);

        this.scene.contentRoot.removeChild(this.entity);
        this.scene.boundDirty = true;
    }

    serialize(serializer: Serializer) {
        serializer.packa(this.entity.getWorldTransform().data);
        serializer.pack(this.changedCounter);
        serializer.pack(this.visible);
        serializer.pack(this.tintClr.r, this.tintClr.g, this.tintClr.b);
        serializer.pack(this.temperature, this.saturation, this.exposure, this.brightness, this.blackPoint, this.whitePoint, this.transparency);
    }

    onPreRender() {
        const events = this.scene.events;
        const selected = this.scene.camera.renderOverlays && events.invoke('selection') === this;
        const cameraMode = events.invoke('camera.mode');
        const cameraOverlay = events.invoke('camera.overlay');

        // configure rings rendering
        const material = this.entity.gsplat.instance.material;
        material.setParameter('outlineMode', events.invoke('view.outlineSelection') ? 1 : 0);
        material.setParameter('ringSize', (selected && cameraOverlay && cameraMode === 'rings') ? 0.04 : 0);

        // configure colors
        const selectedClr = events.invoke('selectedClr');
        const unselectedClr = events.invoke('unselectedClr');
        const lockedClr = events.invoke('lockedClr');

        if (!selected) {
            material.setParameter('selectedClr', [0, 0, 0, 0]);
        } else if (events.invoke('view.outlineSelection')) {
            material.setParameter('selectedClr', [0, 0, 0, 0]);
        } else {
            material.setParameter('selectedClr', [selectedClr.r, selectedClr.g, selectedClr.b, selectedClr.a * this.selectionAlpha]);
        }
        material.setParameter('unselectedClr', [unselectedClr.r, unselectedClr.g, unselectedClr.b, unselectedClr.a]);
        material.setParameter('lockedClr', [lockedClr.r, lockedClr.g, lockedClr.b, lockedClr.a]);

        // the whole grade as one matrix and one translation - worked out in
        // color-grade.ts so the renderer, the histogram, the range selector and
        // the export path cannot drift apart
        const grade = gradeMatrix(this);

        material.setParameter('clrMatrix', grade.m);
        material.setParameter('clrOffset', [grade.t, grade.t, grade.t]);
        material.setParameter('clrAlpha', grade.alpha * this.layerOpacity);

        material.setParameter('transformPalette', this.transformPalette.texture);
        material.setParameter('gradePalette', this.gradePalette.texture);
        material.setParameter('splatGrade', this.gradeTexture);

        // the camera node's exposure and depth of field. The blur needs to
        // know how a scene unit maps to pixels, which is a property of the
        // projection and the target, so it is worked out here rather than
        // guessed at in the shader.
        const cam = events.invoke('camera.effects') as CameraSettings;
        if (cam) {
            const { camera } = this.scene;
            const pxPerUnit = 0.5 * camera.mainTarget.width * camera.camera.projectionMatrix.data[0];

            // the cap is set in viewport pixels; an offscreen render at
            // another size scales it with the frame, along the axis the
            // field of view is fixed on, so an export blurs as the view did
            const view = this.scene.targetSize;
            const target = camera.targetSize;
            const fit = camera.camera.horizontalFov ?
                target.width / Math.max(view.width, 1) :
                target.height / Math.max(view.height, 1);

            material.setParameter('camExposure', Math.pow(2, cam.exposure));
            material.setParameter('camDof', [cam.aperture, cam.focusDistance, cam.maxBlur * fit, pxPerUnit]);
        }

        if (this.visible && selected) {
            // render bounding box
            if (events.invoke('camera.bound')) {
                const bound = this.localBound;
                const scale = new Mat4().setTRS(bound.center, Quat.IDENTITY, bound.halfExtents);
                scale.mul2(this.entity.getWorldTransform(), scale);

                for (let i = 0; i < boundingPoints.length / 2; i++) {
                    const a = boundingPoints[i * 2];
                    const b = boundingPoints[i * 2 + 1];
                    scale.transformPoint(a, veca);
                    scale.transformPoint(b, vecb);

                    this.scene.app.drawLine(veca, vecb, Color.WHITE, true, this.scene.worldLayer);
                }
            }
        }

        this.entity.enabled = this.visible && !this.timeHidden && !this.layerHidden;
    }

    focalPoint() {
        // GSplatData has a function for calculating an weighted average of the splat positions
        // to get a focal point for the camera, but we use bound center instead
        return this.worldBound.center;
    }

    move(position?: Vec3, rotation?: Quat, scale?: Vec3) {
        const entity = this.entity;
        if (position) {
            entity.setLocalPosition(position);
        }
        if (rotation) {
            entity.setLocalRotation(rotation);
        }
        if (scale) {
            entity.setLocalScale(scale);
        }

        this.updateWorldBound();

        this.scene.events.fire('splat.moved', this);
    }

    // calculate both selection and local bounds (async, callers must await)
    async updateLocalBounds(): Promise<void> {
        const time = this.motionTime;
        const active = this.motionActive;
        await this.scene.dataProcessor.calcBound(this, this.selectionBoundStorage, this.localBoundStorage, this.shownBoundStorage);
        this.boundsTime = time;
        this.boundsActive = active;
        this.updateWorldBound();
    }

    /**
     * The selection bound and the bound of what is drawn, local space, at the
     * time shown. A 4D model's frame changes do not measure them - that would
     * be a pass per frame of playback - so they are measured here, on demand,
     * when the frame has changed since. Run it in the command queue.
     */
    async shownBounds(): Promise<{ selection: BoundingBox, shown: BoundingBox }> {
        if (this.motion && (this.boundsTime !== this.motionTime || this.boundsActive !== this.motionActive)) {
            const time = this.motionTime;
            const active = this.motionActive;
            await this.scene.dataProcessor.calcShownBound(this, this.selectionBoundStorage, this.shownBoundStorage);
            this.boundsTime = time;
            this.boundsActive = active;
        }
        return { selection: this.selectionBoundStorage, shown: this.shownBoundStorage };
    }

    // update world bound from local bound (synchronous)
    private updateWorldBound() {
        this.worldBoundStorage.setFromTransformedAabb(this.localBoundStorage, this.entity.getWorldTransform());
        this.scene.boundDirty = true;
    }

    // get the selection bound - for a 4D model, at the time of the last
    // measure; shownBounds() brings it up to the time shown
    get selectionBound() {
        return this.selectionBoundStorage;
    }

    // get local space bound - for a 4D model, of the whole sequence
    get localBound() {
        return this.localBoundStorage;
    }

    // get world space bound
    get worldBound() {
        return this.worldBoundStorage;
    }

    set visible(value: boolean) {
        if (value !== this.visible) {
            this._visible = value;
            this.scene?.events.fire('splat.visibility', this);
        }
    }

    get visible() {
        return this._visible;
    }

    set tintClr(value: Color) {
        if (!this._tintClr.equals(value)) {
            this._tintClr.set(value.r, value.g, value.b);
            this.scene.events.fire('splat.tintClr', this);
        }
    }

    get tintClr() {
        return this._tintClr;
    }

    set temperature(value: number) {
        if (value !== this._temperature) {
            this._temperature = value;
            this.scene.events.fire('splat.temperature', this);
        }
    }

    get temperature() {
        return this._temperature;
    }

    set saturation(value: number) {
        if (value !== this._saturation) {
            this._saturation = value;
            this.scene.events.fire('splat.saturation', this);
        }
    }

    get saturation() {
        return this._saturation;
    }

    /**
     * How many spherical-harmonic bands this object shows and exports, capped
     * further by the view setting and by what the file actually contains.
     */
    set shBandLimit(value: number) {
        if (value !== this._shBandLimit) {
            this._shBandLimit = value;
            this.rebuildMaterial(this.scene.events.invoke('view.bands'));
            this.scene.events.fire('splat.shBandLimit', this);
            this.scene.forceRender = true;
        }
    }

    get shBandLimit() {
        return this._shBandLimit;
    }

    /** stops, not a factor: +1 doubles the light, -1 halves it */
    set exposure(value: number) {
        if (value !== this._exposure) {
            this._exposure = value;
            this.scene.events.fire('splat.exposure', this);
        }
    }

    get exposure() {
        return this._exposure;
    }

    set brightness(value: number) {
        if (value !== this._brightness) {
            this._brightness = value;
            this.scene.events.fire('splat.brightness', this);
        }
    }

    get brightness() {
        return this._brightness;
    }

    set blackPoint(value: number) {
        if (value !== this._blackPoint) {
            this._blackPoint = value;
            this.scene.events.fire('splat.blackPoint', this);
        }
    }

    get blackPoint() {
        return this._blackPoint;
    }

    set whitePoint(value: number) {
        if (value !== this._whitePoint) {
            this._whitePoint = value;
            this.scene.events.fire('splat.whitePoint', this);
        }
    }

    get whitePoint() {
        return this._whitePoint;
    }

    set transparency(value: number) {
        if (value !== this._transparency) {
            this._transparency = value;
            this.scene.events.fire('splat.transparency', this);
        }
    }

    get transparency() {
        return this._transparency;
    }

    // get pivot position/rotation/scale (caller should have awaited operation that changed data)
    getPivot(result: Transform) {
        const { entity } = this;
        // the pivot is the model's local frame: the entity's own frame
        // amended by the user-defined local frame (identity by default, so
        // the pivot then lands exactly on the entity transform)
        quat.mul2(entity.getLocalRotation(), this.localFrame);
        entity.getLocalTransform().transformPoint(this.localFrameOrigin, vec);
        result.set(vec, quat, entity.getLocalScale());
    }

    setLocalFrame(origin: Vec3, rotation: Quat) {
        this.localFrameOrigin.copy(origin);
        this.localFrame.copy(rotation);
        this.scene.events.fire('splat.localFrame', this);
    }

    get hasLocalFrame() {
        return !this.localFrameOrigin.equals(Vec3.ZERO) || !this.localFrame.equals(Quat.IDENTITY);
    }

    docSerialize() {
        const pack3 = (v: Vec3) => [v.x, v.y, v.z];
        const pack4 = (q: Quat) => [q.x, q.y, q.z, q.w];
        const packC = (c: Color) => [c.r, c.g, c.b, c.a];
        // the object's own grade: under a debug view node the object's
        // properties hold the grade on the false colour, which the project
        // stores with the node (see doc.ts)
        const grade = this.ownGrade;
        return {
            name: this.name,
            position: pack3(this.entity.getLocalPosition()),
            rotation: pack4(this.entity.getLocalRotation()),
            scale: pack3(this.entity.getLocalScale()),
            localFrameOrigin: pack3(this.localFrameOrigin),
            localFrame: pack4(this.localFrame),
            visible: this.visible,
            tintClr: packC(grade.tintClr),
            temperature: grade.temperature,
            saturation: grade.saturation,
            exposure: grade.exposure ?? 0,
            shBandLimit: this.shBandLimit,
            brightness: grade.brightness,
            blackPoint: grade.blackPoint,
            whitePoint: grade.whitePoint,
            transparency: grade.transparency
        };
    }

    docDeserialize(doc: any) {
        const { name, position, rotation, scale, visible, tintClr, temperature, saturation, brightness, blackPoint, whitePoint, transparency } = doc;

        this.name = name;
        this.move(new Vec3(position), new Quat(rotation), new Vec3(scale));
        // older documents predate the local frame
        this.localFrameOrigin = doc.localFrameOrigin ? new Vec3(doc.localFrameOrigin) : new Vec3();
        this.localFrame = doc.localFrame ? new Quat(doc.localFrame) : new Quat();
        this.visible = visible;
        this.tintClr = new Color(tintClr[0], tintClr[1], tintClr[2], tintClr[3]);
        this.temperature = temperature ?? 0;
        this.saturation = saturation ?? 1;
        // older documents predate exposure and the band limit
        this.exposure = doc.exposure ?? 0;
        this.shBandLimit = doc.shBandLimit ?? 3;
        this.brightness = brightness;
        this.blackPoint = blackPoint;
        this.whitePoint = whitePoint;
        this.transparency = transparency;
    }
}

export { Splat, type SplatMotion };
