import { count, type FieldNode, type FieldSpec, type LookSpec } from './fields';
import { framesOf, lifeOf, rowWindows, scopeRows } from './measure';
import { StateOp } from '../edit-ops';
import { IndexRanges } from '../index-ranges';
import { Splat } from '../splat';
import { State } from '../splat-state';

/**
 * Flicker removal: deletes the gaussians of a 4D model that are drawn for
 * fewer than `frames` frames - at half their peak opacity or more, within
 * the sequence and their place in the hierarchy - the 4D counterpart of
 * floaters, which pop in and out. Like cleanup it only ever adds to what is
 * deleted, and a project stores it as a node (doc-nodes.ts).
 *
 * A sequence of one frame (or one not on the timeline yet) has nothing that
 * flickers: every gaussian is drawn for at most one frame, so the node does
 * nothing there rather than delete the model. The threshold is clamped to
 * the sequence's length, so a gaussian drawn the whole sequence stays.
 */
class FlickerRemovalOp extends StateOp implements FieldNode {
    name = 'flickerRemoval';
    frames: number;
    /** the sequence was too short to tell flicker, when it last resolved */
    tooShort = false;

    constructor(splat: Splat, frames = 2) {
        // BitOp.SET: deleting only ever adds to what is deleted
        super(splat, null, State.deleted, 0 as any, State.deleted);
        this.frames = frames;
        this.resolver = (s: Splat) => {
            const n = s.splatData.numSplats;
            const { motion } = s;
            if (!motion) return IndexRanges.fromPredicate(0, () => false);
            const total = framesOf(s);
            this.tooShort = total < 2;
            if (this.tooShort) return IndexRanges.fromPredicate(0, () => false);
            const limit = Math.min(this.frames, total);
            const { rows } = scopeRows(s);
            const { lo, hi } = rowWindows(motion, n);
            const doomed = new Uint8Array(n);
            const { velocityTime: vt, falloff } = motion;
            for (let k = 0; k < rows.length; ++k) {
                const r = rows[k];
                const [a, b] = lifeOf(vt[r * 4 + 3], falloff[r], lo[r], hi[r], 0.5);
                if ((b - a) * total < limit) doomed[r] = 1;
            }
            return IndexRanges.fromPredicate(n, i => doomed[i] === 1);
        };
    }

    setFrames(frames: number) {
        this.frames = frames;
        this.invalidate();
    }

    get settings() {
        return { frames: this.frames };
    }

    get sourceLabel() {
        return `< ${this.frames} f`;
    }

    fields(): FieldSpec[] {
        if (!this.splat?.motion) return [{ kind: 'note', text: 'node.look.still3d' }];
        return [
            { kind: 'slider',
                label: 'node.flicker.frames',
                value: this.frames,
                min: 0.5,
                max: 30,
                step: 0.5,
                apply: (v) => {
                    this.setFrames(v);
                } },
            { kind: 'stat', label: 'node.look.removed', value: count(this.affected), raw: this.affected >= 0 },
            { kind: 'note', text: this.tooShort ? 'node.flicker.too-short' : 'node.flicker.note' }
        ];
    }
}

/** stored with the select and delete nodes (doc-nodes.ts), as a state node */
const flickerRemoval: LookSpec = {
    kind: 'flickerRemoval',
    label: 'flicker removal',
    hint: 'gaussians drawn for only a few frames removed',
    create: splat => new FlickerRemovalOp(splat)
};

export { FlickerRemovalOp, flickerRemoval };
