/**
 * Instance: copies of one object at other places, without copying it.
 *
 * Each copy is an entity of its own drawing the object's own gsplat data -
 * the same GPU resource, so a copy costs an order buffer and a sort, not
 * the data again. Its material is the object's, kept in step every frame
 * (colour, selection, debug view, motion), with the copy's own order. A
 * 4D object's copies are sorted by a motion sort worker each and can run
 * at a time offset of their own, through the object's time nodes, so a
 * row of copies can walk out of step.
 *
 * Copies are drawn, nothing else: picking, selecting, bounds and exports
 * see the object alone. Each copy is sorted on its own, so copies that
 * overlap in depth do not interleave - they are for things placed apart.
 * A merge node downstream takes the object without its copies.
 */

import { Entity, Quat, Vec3 } from 'playcanvas';

import { MotionSorter } from './motion-sort';
import { Splat } from './splat';
import { State } from './splat-state';
import { resolveTime } from './time-map';

type InstanceMode = 'grid' | 'list';

type InstanceSettings = {
    mode: InstanceMode;
    /** a grid: how many along x, y and z, the object itself the first */
    count: [number, number, number];
    /** and how far apart, in world units */
    spacing: [number, number, number];
    /** each copy of the grid this many frames later than the one before */
    timeStep: number;
    /** a list: one copy per entry, "x y z [turn about y, degrees] [frames later]", entries split by ';' */
    list: string;
};

const MAX_COPIES = 256;

const defaultInstanceSettings = (): InstanceSettings => ({
    mode: 'grid',
    count: [3, 1, 1],
    spacing: [1, 1, 1],
    timeStep: 0,
    list: ''
});

/** Where each copy goes: an offset, a turn about y and a time offset in frames. */
type Placement = { offset: Vec3, turn: number, frames: number };

const placements = (s: InstanceSettings): Placement[] => {
    const out: Placement[] = [];
    if (s.mode === 'list') {
        s.list.split(/[;\n]+/).map(e => e.trim()).filter(Boolean).forEach((entry) => {
            const v = entry.split(/[\s,]+/).map(parseFloat);
            if (v.length < 3 || !v.slice(0, 3).every(Number.isFinite)) return;
            out.push({ offset: new Vec3(v[0], v[1], v[2]), turn: Number.isFinite(v[3]) ? v[3] : 0, frames: Number.isFinite(v[4]) ? Math.round(v[4]) : 0 });
        });
    } else {
        const [nx, ny, nz] = s.count.map(c => Math.max(1, Math.round(c) || 1));
        let k = 0;
        for (let z = 0; z < nz; ++z) {
            for (let y = 0; y < ny; ++y) {
                for (let x = 0; x < nx; ++x, ++k) {
                    // the first is the object itself
                    if (k === 0) continue;
                    out.push({ offset: new Vec3(x * s.spacing[0], y * s.spacing[1], z * s.spacing[2]), turn: 0, frames: k * (Math.round(s.timeStep) || 0) });
                }
            }
        }
    }
    return out.slice(0, MAX_COPIES);
};

// what a copy's material does not take from the object's: its own order,
// how many of it there are, and its time
const OWN = new Set(['splatOrder', 'splatTextureSize', 'numSplats', 'motionTime']);

const turnQuat = new Quat();

class Copy {
    entity: Entity;
    placement: Placement;
    private sorter: MotionSorter | null = null;
    private time = NaN;
    private definesKey = '';
    hidden = false;

    constructor(source: Splat, placement: Placement) {
        this.placement = placement;
        const { scene } = source;
        this.entity = new Entity('splatCopy');
        this.entity.addComponent('gsplat', { asset: source.asset, unified: false });
        scene.contentRoot.addChild(this.entity);
        this.entity.gsplat.layers = [scene.splatLayer.id];

        const instance = this.entity.gsplat.instance;
        const material = instance.material;
        material.copy(source.entity.gsplat.instance.material);
        (instance as any).setMaterialOrderData(material);
        material.update();
        this.definesKey = this.keyOf(source);

        instance.sorter?.on('updated', () => {
            scene.forceRender = true;
        });

        const { motion } = source;
        if (motion) {
            this.sorter = new MotionSorter(instance.sorter, {
                centers: instance.sorter.centers,
                velocityTime: motion.velocityTime,
                falloff: motion.falloff,
                layout: motion.layout?.() ?? null
            }, (t) => {
                material.setParameter('motionTime', t);
                scene.forceRender = true;
            });
            if (source.state.numDeleted) this.sorter.setDeleted(source.state.data, State.deleted);
        }
    }

    private keyOf(source: Splat) {
        const m = source.entity.gsplat.instance.material;
        return [...m.defines.entries()].map(([k, v]) => `${k}=${v}`).join(';');
    }

    /** The object's material as it is this frame, and the copy where the object is. */
    follow(source: Splat) {
        const { entity } = this;
        const main = source.entity.gsplat.instance.material;
        const material = entity.gsplat.instance.material;

        // the shader the object's material builds changed (bands, a debug view, motion)
        const key = this.keyOf(source);
        if (key !== this.definesKey) {
            this.definesKey = key;
            material.defines.clear();
            main.defines.forEach((v, k) => material.defines.set(k, v));
            if (main.hasShaderChunks) material.shaderChunks.copy(main.shaderChunks);
            material.update();
        }
        for (const name in main.parameters) {
            if (!OWN.has(name)) material.setParameter(name, (main.parameters as Record<string, any>)[name].data);
        }

        // the object's place, then this copy's offset and turn on top
        const { offset, turn } = this.placement;
        entity.setLocalScale(source.entity.getLocalScale());
        turnQuat.setFromEulerAngles(0, turn, 0);
        entity.setLocalRotation(turnQuat.clone().mul(source.entity.getLocalRotation()));
        const p = source.entity.getLocalPosition();
        entity.setLocalPosition(p.x + offset.x, p.y + offset.y, p.z + offset.z);
        entity.enabled = source.entity.enabled && !this.hidden;
    }

    /** A 4D object's copy at a frame of the timeline, this copy's frames later. */
    showFrame(source: Splat, frame: number) {
        if (!this.sorter || !(source.motionFrames > 0)) return;
        const at = resolveTime(source.timeMaps, source.motionFrames, frame - this.placement.frames);
        // a copy that has not started yet, or has ended, is not there
        const span = source.timeSpan;
        const outside = frame - this.placement.frames < 0 || frame - this.placement.frames > span - 1;
        this.hidden = at === null || (this.placement.frames !== 0 && outside);
        if (at === null) return;
        const t = at / source.motionFrames;
        if (t !== this.time) {
            this.time = t;
            this.sorter.show(t);
        }
    }

    setDeleted(source: Splat) {
        this.sorter?.setDeleted(source.state.numDeleted ? source.state.data : null, State.deleted);
    }

    destroy() {
        this.sorter?.destroy();
        this.sorter = null;
        this.entity.destroy();
    }
}

/**
 * The node: settings, and the copies while it is applied. combine.ts
 * keeps them in step with the object (`follow`, frame by frame).
 */
class InstanceOp {
    name = 'instance';
    splat: Splat;
    settings: InstanceSettings;
    bypassed?: boolean;

    copies: Copy[] = [];

    constructor(splat: Splat, settings: InstanceSettings) {
        this.splat = splat;
        this.settings = settings;
    }

    get applied() {
        return this.copies.length > 0;
    }

    get copyCount() {
        return placements(this.settings).length;
    }

    get sourceLabel() {
        return `${this.copyCount} copies`;
    }

    do() {
        this.undo();
        const { splat } = this;
        if (!splat?.scene) return;
        this.copies = placements(this.settings).map(p => new Copy(splat, p));
        this.follow();
        this.showFrame(splat.timelineFrame);
        splat.scene.forceRender = true;
    }

    undo() {
        this.copies.forEach(c => c.destroy());
        this.copies = [];
        if (this.splat?.scene) this.splat.scene.forceRender = true;
    }

    /** the object's data was swapped: copies of the new data */
    rebind() {
        if (this.copies.length) this.do();
    }

    follow() {
        const { splat } = this;
        if (!splat?.scene) return;
        this.copies.forEach(c => c.follow(splat));
    }

    showFrame(frame: number) {
        this.copies.forEach(c => c.showFrame(this.splat, frame));
    }

    setDeleted() {
        this.copies.forEach(c => c.setDeleted(this.splat));
    }

    destroy() {
        this.undo();
        this.splat = null;
    }
}

/** A scene's instance nodes, applied. */
const appliedInstances = (ops: unknown[], cursor: number) => ops.slice(0, cursor).filter(o => o instanceof InstanceOp && o.applied) as InstanceOp[];

export { InstanceOp, defaultInstanceSettings, appliedInstances, placements, type InstanceSettings, type InstanceMode };
