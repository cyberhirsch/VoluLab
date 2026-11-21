import { Mat4, Quat, Vec3 } from 'playcanvas';

import { EditOp, EntityTransformOp, PortSpec, TimeOp, TransformNodeOp, principalOp } from './edit-ops';
import { Events } from './events';
import { FrameDriven, keyableLive } from './keyframe-driver';
import { evaluate, keyable, trackOf, unpackKeys } from './keyframes';
import { fitPlane, fitRigid, icp, planeFrom3, positionsAt, rotationBetween, sampleRows } from './motion-fit';
import { Scene } from './scene';
import { Splat } from './splat';
import { pickSplatSurfacePoint } from './splat-pick';
import { State } from './splat-state';
import { TimeMap, resolveTime } from './time-map';
import { Transform } from './transform';

/**
 * The nodes that transform over time: track (and attach), stabilise, align,
 * ground plane, time warp, motion scale and motion blur.
 *
 * Track and stabilise fit a rigid transform per frame to the motion of the
 * gaussians the select nodes above them leave selected (all of them, with
 * nothing selected); track hands it to another object, stabilise takes it
 * out of its own. Both change placements per frame, which the keyframe
 * driver asks them to do (FrameDriven).
 *
 * Align and ground plane are transform nodes whose values are worked out
 * rather than typed: they are TransformNodeOps, so they compose in the chain
 * like one, and a project keeps them as one with what they came to.
 *
 * Time warp is a time node (time-map.ts) whose speed is a curve: the keys of
 * its speed parameter. Motion scale and motion blur change how the shader
 * draws a 4D model's motion (Splat.motionLooks).
 */

// ---- shared

/** Where a placement matrix stands: position, rotation and per-axis scale. */
const placementOf = (m: Mat4): Transform => {
    const d = m.data;
    const axes = [0, 4, 8].map(o => new Vec3(d[o], d[o + 1], d[o + 2]));
    const scale = new Vec3(axes[0].length(), axes[1].length(), axes[2].length());
    if (new Vec3().cross(axes[0], axes[1]).dot(axes[2]) < 0) scale.x = -scale.x;
    const r = new Mat4();
    [scale.x, scale.y, scale.z].forEach((s, k) => {
        const inv = s ? 1 / s : 0;
        r.data[k * 4] = axes[k].x * inv;
        r.data[k * 4 + 1] = axes[k].y * inv;
        r.data[k * 4 + 2] = axes[k].z * inv;
    });
    return new Transform(m.getTranslation(), new Quat().setFromMat4(r), scale);
};

const placementMatrix = (t: Transform) => new Mat4().setTRS(t.position, t.rotation, t.scale);

const placementNow = (splat: Splat) => {
    const e = splat.entity;
    return new Transform(e.getLocalPosition(), e.getLocalRotation(), e.getLocalScale());
};

const placesObject = (op: EditOp, splat: unknown) => {
    const p: any = principalOp(op);
    if (p instanceof EntityTransformOp || p instanceof TransformNodeOp) return p.splat === splat;
    // eslint-disable-next-line no-use-before-define
    return p instanceof TrackOp && p.target === splat;
};

/** The model's normalised time at a timeline frame, through its time nodes; null where it is hidden. */
const modelTimeAt = (splat: Splat, frame: number) => {
    const frames = splat.motionFrames;
    if (!splat.motion || !(frames > 0)) return null;
    const at = resolveTime(splat.timeMaps, frames, frame);
    return at === null ? null : at / frames;
};

/** A fingerprint of which rows are selected: a fit is kept while it does not change. */
const selectionPrint = (splat: Splat) => {
    const state = splat.splatData.getProp('state') as Uint8Array;
    let h = 2166136261;
    let n = 0;
    for (let i = 0; i < state.length; ++i) {
        if (state[i] & State.selected) {
            h = Math.imul(h ^ i, 16777619);
            n++;
        }
    }
    return `${n}:${h >>> 0}:${state.length}`;
};

/**
 * A rigid transform per frame of the model: frame m's matrix takes the
 * tracked gaussians from where they are at the reference frame to where
 * they are at m (model space). Fitted straight from the reference frame
 * while enough of the gaussians there are still there - a least-squares fit
 * holds their centre exactly, so a stabilised selection does not drift.
 * Further out, where those have faded and others carry the motion, it is
 * fitted from the frame before and chained on.
 */
class MotionTrack {
    frames: number;
    private mats: Mat4[];
    rows: number;
    rms: number;

    private constructor(mats: Mat4[], rows: number, rms: number) {
        this.mats = mats;
        this.frames = mats.length;
        this.rows = rows;
        this.rms = rms;
    }

    static fit(splat: Splat, ref: number, maxRows = 20000): MotionTrack | null {
        const frames = splat.motionFrames;
        if (!splat.motion || !(frames > 1)) return null;
        const { rows } = sampleRows(splat, maxRows, 'selected');
        if (rows.length < 3) return null;
        const n = rows.length;
        const at = (m: number) => {
            const pos = new Float64Array(n * 3);
            const w = new Float64Array(n);
            positionsAt(splat, rows, m / frames, pos, w);
            return { pos, w };
        };
        const r = Math.max(0, Math.min(frames - 1, Math.round(ref)));
        const mats: Mat4[] = new Array(frames);
        mats[r] = new Mat4();
        let se = 0;
        let fits = 0;
        const W = new Float64Array(n);
        const pose = at(r);
        let there = 0;
        for (let k = 0; k < n; ++k) if (pose.w[k] > 0.15) there++;
        const weigh = (a: Float64Array, b: Float64Array) => {
            let shared = 0;
            for (let k = 0; k < n; ++k) {
                const w = a[k] * b[k];
                W[k] = w > 0.02 ? w : 0;
                if (W[k]) shared++;
            }
            return shared;
        };
        const step = (from: number, to: number) => {
            const b = at(to);
            let fit = null;
            let chained = false;
            // straight from the reference while a fifth of it is still there
            if (weigh(pose.w, b.w) >= Math.max(8, there * 0.2)) {
                fit = fitRigid(pose.pos, b.pos, W);
            }
            if (!fit) {
                const a = at(from);
                weigh(a.w, b.w);
                fit = fitRigid(a.pos, b.pos, W);
                chained = true;
            }
            // nothing to go by: the frame holds the last one's place
            if (!fit) mats[to] = mats[from].clone();
            else mats[to] = chained ? new Mat4().mul2(fit.matrix, mats[from]) : fit.matrix;
            if (fit) {
                se += fit.rms * fit.rms;
                fits++;
            }
        };
        for (let m = r + 1; m < frames; ++m) step(m - 1, m);
        for (let m = r - 1; m >= 0; --m) step(m + 1, m);
        return new MotionTrack(mats, n, fits ? Math.sqrt(se / fits) : 0);
    }

    /** The matrix at normalised time t, between frames by lerp and slerp. */
    at(t: number): Mat4 {
        const f = Math.max(0, Math.min(this.frames - 1, t * this.frames));
        const a = Math.floor(f);
        const b = Math.min(this.frames - 1, a + 1);
        const u = f - a;
        if (u < 1e-6 || a === b) return this.mats[a].clone();
        const ta = this.mats[a].getTranslation();
        const tb = this.mats[b].getTranslation();
        const qa = new Quat().setFromMat4(this.mats[a]);
        const qb = new Quat().setFromMat4(this.mats[b]);
        return new Mat4().setTRS(new Vec3().lerp(ta, tb, u), new Quat().slerp(qa, qb, u), Vec3.ONE);
    }
}

/** What track and stabilise share: a fit to the selection's motion, kept while the selection stays. */
class TrackBase {
    name: string;
    splat: Splat;
    /** the model frame the track is relative to */
    ref: number;
    bypassed?: boolean;
    track: MotionTrack | null = null;
    private print = '';

    constructor(splat: Splat, ref = 0) {
        this.splat = splat;
        this.ref = ref;
    }

    /** how many gaussians the fit used, or -1 before it ran */
    get rowsUsed() {
        return this.track ? this.track.rows : -1;
    }

    setRef(ref: number) {
        this.ref = Math.max(0, Math.round(ref));
        this.print = '';
    }

    protected fit() {
        const print = `${selectionPrint(this.splat)}:${this.ref}:${this.splat.motionFrames}`;
        if (print !== this.print || !this.track) {
            this.track = MotionTrack.fit(this.splat, this.ref);
            this.print = print;
        }
        return this.track;
    }

    /** The world-space motion of the track at a timeline frame: where the reference pose goes. */
    protected worldMotion(frame: number, base: Transform): Mat4 | null {
        const t = modelTimeAt(this.splat, frame);
        if (t === null || !this.track) return null;
        const W = placementMatrix(base);
        const inv = W.clone().invert();
        return new Mat4().mul2(W, this.track.at(t)).mul(inv);
    }
}

/**
 * Track: fits the selection's rigid motion and attaches another object to
 * it - wired into its "attach" input, that object follows the selection as
 * if it were carried by it, from where it stood at the reference frame.
 * Unwired, the node only fits, and says how well.
 */
class TrackOp extends TrackBase implements FrameDriven {
    name = 'trackNode';
    target: Splat | null = null;
    // the target's placement under it, and the tracked object's, while applied
    private targetBase: Transform | null = null;
    private sourceBase: Transform | null = null;

    get ports(): PortSpec[] {
        return [{ name: 'attach', label: 'attach', accepts: ['object'], source: this.target }];
    }

    /** for the history: the attached object is changed by the node too */
    get inputs() {
        return this.target ? [this.target] : [];
    }

    get sourceLabel() {
        return this.target ? `→ ${this.target.name}` : `ref ${this.ref}`;
    }

    get applied() {
        return this.sourceBase !== null;
    }

    /** where the attached object stands under the node, while it is applied */
    get attachedBase() {
        return this.targetBase;
    }

    do() {
        this.fit();
        this.sourceBase = placementNow(this.splat);
        if (this.target?.scene) {
            this.targetBase = placementNow(this.target);
            this.place(this.splat.timelineFrame);
        }
    }

    private place(frame: number) {
        if (!this.target?.scene || !this.targetBase) return;
        const M = this.worldMotion(frame, this.sourceBase);
        if (!M) return;
        const t = placementOf(M.mul(placementMatrix(this.targetBase)));
        this.target.move(t.position, t.rotation, t.scale);
    }

    animate(frame: number, later: EditOp[]) {
        if (!this.applied || !this.target || !this.targetBase) return false;
        // a later node placing either object stands on this one's placement
        if (later.some(o => placesObject(o, this.target) || placesObject(o, this.splat))) return true;
        this.place(frame);
        return false;
    }

    undo() {
        if (this.target?.scene && this.targetBase) {
            this.target.move(this.targetBase.position, this.targetBase.rotation, this.targetBase.scale);
        }
        this.targetBase = null;
        this.sourceBase = null;
    }

    destroy() {
        this.splat = null;
        this.target = null;
        this.track = null;
    }
}

// ---- keyable parameters

const registerMotionParams = () => {
};

// ---- adding them

type MotionNodeSettings = Record<string, any> & { kind: string };

/** A node's settings for a project, beside its place and bypass. */
const motionSettings = (op: EditOp): MotionNodeSettings | null => {
    if (op instanceof TrackOp) return { kind: 'track', ref: op.ref };
    return null;
};

const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** And a node made from them; null for a kind not known. */
const motionNodeFrom = (splat: Splat, stored: MotionNodeSettings): EditOp | null => {
    switch (stored?.kind) {
        case 'track': return new TrackOp(splat, num(stored.ref, 0));
    }
    return null;
};

const registerMotionNodes = (events: Events, scene: Scene, canvas: HTMLElement) => {
    registerMotionParams();

    const history = () => events.invoke('edit.history') as { ops: EditOp[], cursor: number };
    const add = (make: (splat: Splat) => EditOp | null) => (target?: Splat) => events.fire('graph.addNodeFor', make, target);
    const frameOf = (splat: Splat) => Math.max(0, Math.min(Math.round(events.invoke('timeline.frame') ?? 0), Math.max(0, splat.motionFrames - 1)));

    events.on('graph.addTrackNode', add(splat => new TrackOp(splat, frameOf(splat))));

    // a wire into an attach or reference input
    events.on('graph.connect', (op: EditOp, port: string, source: object) => {
        const index = history().ops.indexOf(op);
        if (index < 0 || !(source instanceof Splat)) return;
        if (op instanceof TrackOp && port === 'attach' && source !== op.splat) {
            events.invoke('edit.refresh', index, () => {
                op.target = source;
            });
        }
    });
    events.on('graph.disconnect', (op: EditOp, port: string) => {
        const index = history().ops.indexOf(op);
        if (index < 0) return;
        if (op instanceof TrackOp && port === 'attach' && op.target) {
            events.invoke('edit.refresh', index, () => {
                op.target = null;
            });
        }
    });

    // a project's nodes come back through here
    events.function('motion.settings', (op: EditOp) => motionSettings(op));
    events.function('motion.addNode', (splat: Splat, stored: MotionNodeSettings & { bypassed?: boolean }) => {
        const op = splat ? motionNodeFrom(splat, stored) : null;
        if (!op) return null;
        op.bypassed = !!stored.bypassed;
        unpackKeys(op, stored.keys);
        if (op instanceof TrackOp && stored.targetSplat instanceof Splat) op.target = stored.targetSplat;
        events.fire('edit.add', op);
        return op;
    });

    // The first applied node that places an object per frame - a stabilise
    // on it, a track attaching it - and the placement it stands on, which is
    // what a project stores the object at: the node puts its motion back
    // on top when the project opens.
    events.function('motion.placedFrom', (splat: Splat, ops: EditOp[], cursor: number) => {
        for (let at = 0; at < cursor; ++at) {
            const op = principalOp(ops[at]);
            if (ops[at].bypassed) continue;
            if (op instanceof TrackOp && op.target === splat && op.attachedBase) return { at, base: op.attachedBase };
        }
        return null;
    });
};

export {
    TrackOp,
    registerMotionNodes,
    motionSettings,
};
