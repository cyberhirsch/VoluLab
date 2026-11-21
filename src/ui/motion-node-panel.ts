import { EditOp } from '../edit-ops';
import { Events } from '../events';
import { AlignOp, GroundPlaneOp, ObjectPoint, StabiliseOp, TimeWarpOp, TrackOp } from '../motion-nodes';
import { Splat } from '../splat';
import { i18n } from './localization';

/**
 * The node pane's faces for the nodes that transform over time
 * (motion-nodes.ts). The pane hands over the few things it builds rows with;
 * the faces are here so the pane itself only needs to know to ask.
 */
type PanelKit = {
    events: Events;
    body: HTMLElement;
    row: (label: string) => HTMLElement;
    stat: (label: string, value: string) => void;
    note: (text: string) => void;
    number: (label: string, value: number, step: number, neutral: number, index: number, apply: (v: number) => void, key?: { op: EditOp, param: string }) => void;
    choice: <T extends string>(label: string, options: [T, string][], value: T, index: number, apply: (v: T) => void) => void;
};

const t = (key: string) => i18n.t(key);

const button = (kit: PanelKit, text: string, onClick: () => void, disabled = false) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'nd-action';
    b.textContent = text;
    b.disabled = disabled;
    b.addEventListener('click', onClick);
    kit.body.appendChild(b);
    return b;
};

/** The other objects in the scene, to pick one by name; '' is none. */
const objectChoice = (kit: PanelKit, label: string, self: Splat, current: Splat | null, index: number, apply: (s: Splat | null) => void) => {
    const others = (kit.events.invoke('scene.allSplats') as Splat[]).filter(s => s !== self);
    const ids = new Map<string, Splat>();
    const options: [string, string][] = [['', t('node.motion.none')]];
    others.forEach((s, i) => {
        ids.set(`${i}`, s);
        options.push([`${i}`, s.name]);
    });
    const value = current ? `${others.indexOf(current)}` : '';
    kit.choice(label, options, value, index, v => apply(ids.get(v) ?? null));
};

const fmt = (v: number, digits = 3) => (Number.isFinite(v) ? `${+v.toFixed(digits)}` : '-');

const trio = (v: { x: number, y: number, z: number }) => `${fmt(v.x)}, ${fmt(v.y)}, ${fmt(v.z)}`;

const fitStats = (kit: PanelKit, op: TrackOp | StabiliseOp) => {
    const n = op.rowsUsed;
    kit.stat(t('node.track.used'), n < 0 ? t('node.motion.not-fitted') : n.toLocaleString());
    if (op.track) kit.stat(t('node.track.rms'), fmt(op.track.rms, 4));
};

const buildTrack = (kit: PanelKit, op: TrackOp, index: number) => {
    kit.number(t('node.track.ref'), op.ref, 1, 0, index, v => op.setRef(v));
    objectChoice(kit, t('node.track.attach'), op.splat, op.target, index, (s) => {
        op.target = s;
    });
    fitStats(kit, op);
    if (!op.splat.motion) kit.note(t('node.motion.needs-4d'));
    kit.note(t('node.track.note'));
};

const buildStabilise = (kit: PanelKit, op: StabiliseOp, index: number) => {
    kit.number(t('node.track.ref'), op.ref, 1, 0, index, v => op.setRef(v));
    kit.number(t('node.stabilise.strength'), op.strength, 0.05, 1, index, (v) => {
        op.strength = Math.max(0, Math.min(1, v));
    }, { op, param: 'strength' });
    fitStats(kit, op);
    if (!op.splat.motion) kit.note(t('node.motion.needs-4d'));
    kit.note(t('node.stabilise.note'));
};

/** Pick a point on an object, then hand it over inside the node's refresh. */
const pickInto = async (kit: PanelKit, op: EditOp, splat: Splat, set: (p: ObjectPoint) => void, solve: () => void) => {
    const p = await kit.events.invoke('motion.pickPoint', splat) as ObjectPoint | null;
    if (!p) return;
    const index = (kit.events.invoke('edit.history') as { ops: EditOp[] }).ops.indexOf(op);
    if (index < 0) return;
    kit.events.invoke('edit.refresh', index, () => {
        set(p);
        solve();
    });
};

const buildAlign = (kit: PanelKit, op: AlignOp, index: number) => {
    kit.choice(t('node.align.mode'), [
        ['icp', t('node.align.icp')],
        ['points', t('node.align.points')]
    ], op.mode, index, (v) => {
        op.mode = v;
    });
    objectChoice(kit, t('node.align.reference'), op.splat, op.reference, index, (s) => {
        op.reference = s;
    });

    const solve = () => kit.events.invoke('edit.refresh', index, () => op.solve());

    if (op.mode === 'icp') {
        kit.number(t('node.align.radius'), op.radius, 0.01, 0.1, index, (v) => {
            op.radius = Math.max(1e-4, v);
        });
        kit.choice(t('node.align.start'), [
            ['near', t('node.align.as-is')],
            ['rough', t('node.align.centres')]
        ], op.rough ? 'rough' : 'near', index, (v) => {
            op.rough = v === 'rough';
        });
    } else {
        op.pairs.forEach((pair, k) => {
            const row = kit.row(`${t('node.align.pair')} ${k + 1}`);
            const mk = (text: string, done: boolean, splat: Splat | null, set: (p: ObjectPoint) => void) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = `nd-choice${done ? ' nd-choice-active' : ''}`;
                b.textContent = text;
                b.disabled = !splat;
                b.addEventListener('click', () => {
                    b.textContent = t('node.motion.click');
                    pickInto(kit, op, splat, set, () => op.solve());
                });
                row.appendChild(b);
            };
            mk(t('node.align.on-this'), !!pair.from, op.splat, (p) => {
                pair.from = p;
            });
            mk(t('node.align.on-reference'), !!pair.to, op.reference, (p) => {
                pair.to = p;
            });
            kit.body.appendChild(row);
        });
        button(kit, t('node.align.add-pair'), () => {
            kit.events.invoke('edit.refresh', index, () => op.pairs.push({ from: null, to: null }));
        });
        if (op.pairs.length) {
            button(kit, t('node.align.clear'), () => {
                kit.events.invoke('edit.refresh', index, () => {
                    op.pairs = [];
                    op.reset();
                });
            });
        }
    }

    button(kit, t('node.align.solve'), solve, !op.reference);
    if (op.result) {
        kit.stat(t('node.align.pairs'), op.result.pairs.toLocaleString());
        kit.stat(t('node.align.rms'), fmt(op.result.rms, 4));
    }
    kit.stat(t('node.motion.moved'), trio(op.newt.position));
    kit.stat(t('node.motion.turned'), trio(op.euler));
    kit.note(t(op.mode === 'icp' ? 'node.align.note-icp' : 'node.align.note-points'));
};

const buildGround = (kit: PanelKit, op: GroundPlaneOp, index: number) => {
    kit.choice(t('node.ground.mode'), [
        ['fit', t('node.ground.fit')],
        ['points', t('node.ground.points')]
    ], op.mode, index, (v) => {
        op.mode = v;
        op.solve();
    });

    if (op.mode === 'points') {
        const row = kit.row(t('node.ground.floor'));
        op.points.forEach((p, k) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = `nd-choice${p ? ' nd-choice-active' : ''}`;
            b.textContent = `${k + 1}`;
            b.addEventListener('click', () => {
                b.textContent = t('node.motion.click');
                pickInto(kit, op, op.splat, (q) => {
                    op.points[k] = q;
                }, () => op.solve());
            });
            row.appendChild(b);
        });
        kit.body.appendChild(row);
    } else {
        kit.number(t('node.ground.tolerance'), op.tolerance, 0.005, 0.01, index, (v) => {
            op.tolerance = Math.max(1e-4, v);
            op.solve();
        });
    }
    kit.number(t('node.ground.height'), op.height, 0.01, 0, index, (v) => {
        op.height = v;
        op.solve();
    }, { op, param: 'height' });
    kit.choice(t('node.ground.up'), [
        ['normal', t('node.ground.as-found')],
        ['flip', t('node.ground.flipped')]
    ], op.flip ? 'flip' : 'normal', index, (v) => {
        op.flip = v === 'flip';
        op.solve();
    });
    button(kit, t('node.ground.solve'), () => kit.events.invoke('edit.refresh', index, () => op.solve()));

    if (op.result) {
        if (op.mode === 'fit') kit.stat(t('node.ground.on-plane'), `${op.result.inliers.toLocaleString()} / ${op.result.of.toLocaleString()}`);
        kit.stat(t('node.ground.tilt'), `${fmt(op.result.tilt, 2)}°`);
    } else {
        kit.note(t('node.ground.none'));
    }
    kit.stat(t('node.motion.moved'), trio(op.newt.position));
    kit.stat(t('node.motion.turned'), trio(op.euler));
    kit.note(t('node.ground.note'));
};

const buildTimeWarp = (kit: PanelKit, op: TimeWarpOp, index: number) => {
    kit.number(t('node.warp.speed'), op.speed, 0.05, 1, index, (v) => {
        op.speed = v;
    }, { op, param: 'speed' });
    if (!op.moving) {
        kit.note(t('node.time.still'));
        return;
    }
    const frames = op.framesIn;
    kit.stat(t('node.time.frames'), frames < 0 ? t('node.time.not-applied') : `${frames} → ${op.framesOut}`);
    kit.note(t('node.warp.note'));
};

/** The face of one of these nodes, built into the kit's body; false for any other node. */
const buildMotionNode = (op: EditOp, index: number, kit: PanelKit) => {
    if (op instanceof TrackOp) buildTrack(kit, op, index);
    else if (op instanceof StabiliseOp) buildStabilise(kit, op, index);
    else if (op instanceof AlignOp) buildAlign(kit, op, index);
    else if (op instanceof GroundPlaneOp) buildGround(kit, op, index);
    else if (op instanceof TimeWarpOp) buildTimeWarp(kit, op, index);
    else return false;
    return true;
};

export { buildMotionNode, type PanelKit };
