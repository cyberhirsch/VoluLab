import { BLEND_NONE, Entity, MeshInstance, ShaderMaterial } from 'playcanvas';

import { StateOp } from './edit-ops';
import { IndexRanges } from './index-ranges';
import { Splat } from './splat';
import { State } from './splat-state';

/**
 * Holdout: gaussians that are drawn to depth and not to colour, so they
 * hide what is behind them - other objects and the rest of their own -
 * and leave the picture there as it was before any splat was drawn. For
 * placing a 4D actor behind a real foreground: the foreground's gaussians
 * become a matte.
 *
 * Two parts make it. The gaussians held out carry a bit (8) in the GPU copy
 * of their state only (SplatState.overlay), which every pass of the splat
 * shader skips. And the object gets a second draw of its own, a clone of
 * its material that writes depth and no colour and draws only the
 * gaussians with that bit, where they are solid enough (alpha 0.3 and up).
 * That draw has no blending, so the splat layer draws it with its opaque
 * part, ahead of every splat, and every splat behind it fails the depth
 * test. Its parameters are copied from the object's material each frame,
 * so it moves, plays and sorts with it; its order does not matter, as it
 * writes depth only.
 *
 * Both backends keep a depth buffer for the splat pass (camera.ts), so
 * nothing here depends on WebGPU; `holdoutSupported` says so per device,
 * in case a target ever goes without one.
 */

const HOLDOUT_BIT = 8;

// SET in edit-ops' BitOp, which is a const enum and not exported
const BIT_SET = 0 as ConstructorParameters<typeof StateOp>[3];

type DepthDraw = {
    from: ShaderMaterial;
    fromKey: string;
    material: ShaderMaterial;
    meshInstance: MeshInstance;
};

type Holdouts = {
    ops: Set<HoldoutOp>;
    mask: Uint8Array | null;
    /** the state the mask was put on: a sequence frame brings a new one */
    on: object | null;
    draw: DepthDraw | null;
};

const bySplat = new Map<Splat, Holdouts>();
let listening = false;

/** whether the splat pass has a depth buffer to hold out with */
const holdoutSupported = (splat: Splat) => {
    const target = (splat.scene?.camera as any)?.splatTarget;
    return !target || !!target.depthBuffer || !!target.depth;
};

/** what a material's draw depends on besides its parameters */
const materialKey = (m: ShaderMaterial) => `${m.definesKey ?? ''}|${(m as any).shaderChunksVersion ?? ''}`;

const releaseDraw = (splat: Splat, draw: DepthDraw) => {
    splat.scene?.splatLayer?.removeMeshInstances([draw.meshInstance]);
    draw.meshInstance.destroy();
    draw.material.destroy();
};

const removeDraw = (splat: Splat, h: Holdouts) => {
    if (!h.draw) return;
    releaseDraw(splat, h.draw);
    h.draw = null;
};

// a depth draw of `entity`'s drawing of the object's data: the object's
// own, or an instance copy's
const makeDraw = (splat: Splat, from: ShaderMaterial, source: MeshInstance, entity: Entity = splat.entity): DepthDraw => {
    const material = from.clone();
    material.name = 'splatHoldoutDepth';
    material.blendType = BLEND_NONE;
    material.depthWrite = true;
    material.depthTest = true;
    material.redWrite = false;
    material.greenWrite = false;
    material.blueWrite = false;
    material.alphaWrite = false;
    material.setDefine('SPLAT_HOLDOUT_DEPTH', '');
    material.update();

    const meshInstance = new MeshInstance(source.mesh, material, entity);
    meshInstance.setInstancing(true, true);
    meshInstance.cull = false;
    meshInstance.castShadow = false;
    // not a thing to click: the picker draws the object's own instance
    meshInstance.pick = false;
    splat.scene.splatLayer.addMeshInstances([meshInstance]);
    return { from, fromKey: materialKey(from), material, meshInstance };
};

/** a depth draw brought up to date with the drawing it follows, made anew when that drawing's shader changed */
const keepDraw = (splat: Splat, draw: DepthDraw | null, instance: any, entity: Entity): DepthDraw => {
    const from = instance.material as ShaderMaterial;
    const source = instance.meshInstance as MeshInstance;
    if (draw && (draw.from !== from || draw.fromKey !== materialKey(from))) {
        releaseDraw(splat, draw);
        draw = null;
    }
    draw ??= makeDraw(splat, from, source, entity);

    const { material, meshInstance } = draw;
    const parameters = from.parameters as Record<string, { data: any }>;
    for (const name in parameters) {
        material.setParameter(name, parameters[name].data);
    }
    meshInstance.instancingCount = source.instancingCount;
    meshInstance.visible = entity.enabled && source.visible !== false;
    return draw;
};

/** bring one object's holdout up to date: its state bits and its depth draw */
const sync = (splat: Splat, h: Holdouts) => {
    const { state } = splat;
    const mask = h.mask && state && h.mask.length === state.data.length ? h.mask : null;

    // the bit, on the state the object has now
    if (state && (h.on !== state || state.overlay !== mask)) {
        state.overlay = mask;
        state.markAllDirty();
        state.flush();
        h.on = state;
        splat.scene.forceRender = true;
    }

    const instance = splat.entity?.gsplat?.instance as any;
    if (!mask || !instance) {
        removeDraw(splat, h);
        return;
    }

    h.draw = keepDraw(splat, h.draw, instance, splat.entity);
};

/**
 * The depth draw of an instance copy (instance-ops.ts), which draws the
 * object's data and state, so its held-out gaussians are skipped by its
 * colour draw as the object's are: while the object holds out, the copy
 * holds out the same gaussians where it stands. Called as the copy
 * follows the object; returns the draw to keep, or null.
 */
const holdoutCopyDraw = (splat: Splat, draw: DepthDraw | null, entity: Entity): DepthDraw | null => {
    const h = bySplat.get(splat);
    const instance = entity?.gsplat?.instance as any;
    // the object's own draw stands for the holdout being on and supported
    if (!h?.draw || !instance || !splat.scene) {
        if (draw) releaseDraw(splat, draw);
        return null;
    }
    return keepDraw(splat, draw, instance, entity);
};

/** let go of a copy's depth draw */
const releaseCopyDraw = (splat: Splat, draw: DepthDraw | null) => {
    if (draw) releaseDraw(splat, draw);
};

const syncAll = () => {
    bySplat.forEach((h, splat) => {
        if (!splat.scene || !splat.entity) {
            removeDraw(splat, h);
            bySplat.delete(splat);
            return;
        }
        // out of the scene for now: an undo may bring it back
        if (!splat.entity.parent) {
            removeDraw(splat, h);
            return;
        }
        sync(splat, h);
    });
};

/** what the holdouts of an object hold out together, as a mask, or null */
const combinedMask = (splat: Splat, h: Holdouts) => {
    const n = splat.splatData.numSplats;
    let mask: Uint8Array | null = null;
    h.ops.forEach((op) => {
        const ranges = op.resolved;
        if (!ranges) return;
        mask ??= new Uint8Array(n);
        ranges.forEach((i) => {
            if (i < n) mask[i] = HOLDOUT_BIT;
        });
    });
    return mask;
};

const update = (splat: Splat) => {
    const h = bySplat.get(splat);
    if (!h) return;
    h.mask = combinedMask(splat, h);
    if (!h.ops.size) {
        if (splat.state) {
            splat.state.overlay = null;
            splat.state.markAllDirty();
            splat.state.flush();
        }
        removeDraw(splat, h);
        bySplat.delete(splat);
        if (splat.scene) splat.scene.forceRender = true;
        return;
    }
    sync(splat, h);
};

const attach = (op: HoldoutOp) => {
    const { splat } = op;
    if (!splat) return;
    if (!listening && splat.scene) {
        // every frame, before the layers are drawn
        splat.scene.events.on('prerender', syncAll);
        // and at once when an object leaves: a picking or capture pass can
        // draw the splat layer before the next frame, with its mesh gone
        splat.scene.events.on('scene.elementRemoved', (element: unknown) => {
            const h = bySplat.get(element as Splat);
            if (h) removeDraw(element as Splat, h);
        });
        listening = true;
    }
    let h = bySplat.get(splat);
    if (!h) bySplat.set(splat, h = { ops: new Set(), mask: null, on: null, draw: null });
    h.ops.add(op);
    update(splat);
};

const detach = (op: HoldoutOp, splat = op.splat) => {
    const h = splat && bySplat.get(splat);
    if (!h || !h.ops.delete(op)) return;
    update(splat);
};

/**
 * A holdout node: what the select nodes above it leave selected - or the
 * whole object, with nothing selected - is drawn to depth and not to
 * colour from here on. It changes no state the editor reads: its set is
 * resolved and kept like a state node's (with a mask of no bits), which is
 * what lets a project store and restore it as one.
 */
class HoldoutOp extends StateOp {
    name = 'holdoutNode';

    /** how many gaussians were selected when it last resolved, or -1 */
    selectedIn = -1;

    constructor(splat: Splat) {
        super(splat, null, 0, BIT_SET, State.selected);
        this.resolver = (s: Splat) => {
            const state = s.splatData.getProp('state') as Uint8Array;
            const n = s.splatData.numSplats;
            let selected = 0;
            for (let i = 0; i < n; ++i) {
                if (state[i] === State.selected) selected++;
            }
            this.selectedIn = selected;
            // with nothing selected, the whole object that is still there
            return selected ?
                IndexRanges.fromPredicate(n, i => state[i] === State.selected) :
                IndexRanges.fromPredicate(n, i => (state[i] & State.deleted) === 0);
        };
    }

    get supported() {
        return !!this.splat && holdoutSupported(this.splat);
    }

    get sourceLabel() {
        return this.selectedIn === 0 ? 'all' : 'selected';
    }

    async do() {
        await super.do();
        if (this.supported) attach(this);
    }

    async undo() {
        detach(this);
        await super.undo();
    }

    destroy() {
        detach(this);
        super.destroy();
    }
}

export { HoldoutOp, holdoutSupported, holdoutCopyDraw, releaseCopyDraw, HOLDOUT_BIT, type DepthDraw };
