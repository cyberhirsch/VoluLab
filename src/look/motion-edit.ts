import { count, type FieldNode, type FieldSpec } from './fields';
import { scopeRows } from './measure';
import { Scene } from '../scene';
import { Splat, type SplatMotion } from '../splat';

/**
 * A node that changes a 4D model's motion: velocities, temporal centres and
 * falloffs, copied and edited, then handed to the object as its motion.
 * Undo hands back the motion it replaced - only while the object still has
 * the motion it gave it: data made again since (a merge rebuilt) comes with
 * its own motion, which must not be swapped for one of the old data. On a 3D
 * object it does nothing.
 */
abstract class MotionEditOp implements FieldNode {
    name: string;
    splat: Splat;
    bypassed?: boolean;

    /** how many gaussians it changed when it last applied, or -1 */
    affected = -1;
    private before: SplatMotion | null = null;
    // the motion it gave the object, to tell whether it still has it
    private after: SplatMotion | null = null;

    constructor(splat: Splat) {
        this.splat = splat;
    }

    /** edit the copies `vt` and `falloff` for `rows`, and say how many rows changed */
    protected abstract edit(splat: Splat, motion: SplatMotion, rows: Uint32Array, vt: Float32Array, falloff: Float32Array): number;

    abstract get settings(): Record<string, any>;

    abstract fields(scene: Scene): FieldSpec[];

    do() {
        const { splat } = this;
        const motion = splat?.motion;
        if (!motion) {
            this.affected = 0;
            return;
        }
        const vt = motion.velocityTime.slice();
        const falloff = motion.falloff.slice();
        const { rows } = scopeRows(splat);
        this.affected = this.edit(splat, motion, rows, vt, falloff);
        if (!this.affected) return;
        this.before = motion;
        this.after = { ...motion, velocityTime: vt, falloff };
        splat.setMotion(this.after);
        splat.retime();
    }

    undo() {
        const { splat, before, after } = this;
        if (!before) return;
        this.before = null;
        this.after = null;
        if (!splat?.scene && !splat?.motion) return;
        // replaced since: the object's motion is not this node's to undo
        if (splat.motion !== after) return;
        splat.setMotion(before);
        splat.retime();
    }

    /** the motion it replaced while applied, which a project stores under the node (doc-motion.ts) */
    get base(): SplatMotion | null {
        return this.before;
    }

    destroy() {
        this.splat = null;
        this.before = null;
        this.after = null;
    }

    protected common(note: string): FieldSpec[] {
        if (!this.splat?.motion) return [{ kind: 'note', text: 'node.look.still3d' }];
        return [
            { kind: 'stat', label: 'node.look.changed', value: count(this.affected), raw: this.affected >= 0 },
            { kind: 'note', text: note }
        ];
    }
}

export { MotionEditOp };
