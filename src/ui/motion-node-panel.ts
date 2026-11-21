import { EditOp } from '../edit-ops';
import { Events } from '../events';
import { TrackOp } from '../motion-nodes';
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

const fitStats = (kit: PanelKit, op: TrackOp) => {
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

/** The face of one of these nodes, built into the kit's body; false for any other node. */
const buildMotionNode = (op: EditOp, index: number, kit: PanelKit) => {
    if (op instanceof TrackOp) buildTrack(kit, op, index);
    else return false;
    return true;
};

export { buildMotionNode, type PanelKit };
