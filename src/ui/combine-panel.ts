/**
 * The node pane's faces for the combining nodes: merge and
 * switch. In a file of their own so the node pane only dispatches to
 * them; they use its rows and classes (node-panel.scss).
 */

import { i18n } from './localization';
import { fieldDefault } from './value-fields';
import { CombineOp, MergeOp, SwitchOp, type SwitchCut } from '../combine-ops';
import type { EditOp } from '../edit-ops';
import { Events } from '../events';

class Face {
    body: HTMLElement;
    events: Events;
    index: number;

    constructor(body: HTMLElement, events: Events, index: number) {
        this.body = body;
        this.events = events;
        this.index = index;
    }

    refresh(apply: () => void) {
        this.events.invoke('edit.refresh', this.index, apply);
    }

    row(label: string) {
        const row = document.createElement('div');
        row.className = 'nd-row';
        const text = document.createElement('div');
        text.className = 'nd-row-label';
        text.textContent = label;
        row.appendChild(text);
        this.body.appendChild(row);
        return row;
    }

    stat(label: string, value: string) {
        const el = document.createElement('div');
        el.className = 'nd-value';
        el.textContent = value;
        this.row(label).appendChild(el);
    }

    note(text: string) {
        const el = document.createElement('div');
        el.className = 'nd-note';
        el.textContent = text;
        this.body.appendChild(el);
    }

    choice<T extends string>(label: string, options: [T, string][], value: T, apply: (v: T) => void) {
        const choices = document.createElement('div');
        choices.className = 'nd-choices';
        options.forEach(([option, text]) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'nd-choice';
            b.textContent = text;
            if (option === value) b.classList.add('nd-choice-active');
            b.addEventListener('click', () => {
                if (option !== value) this.refresh(() => apply(option));
            });
            choices.appendChild(b);
        });
        this.row(label).appendChild(choices);
    }

    toggle(label: string, on: boolean, text: string, apply: () => void) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'nd-choice';
        b.textContent = text;
        if (on) b.classList.add('nd-choice-active');
        b.addEventListener('click', () => this.refresh(apply));
        this.row(label).appendChild(b);
    }

    number(label: string, value: number, step: number, neutral: number, apply: (v: number) => void, row?: HTMLElement) {
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'nd-num';
        input.step = String(step);
        input.value = `${+value.toFixed(4)}`;
        fieldDefault(input, neutral);
        input.addEventListener('keydown', e => e.stopPropagation());
        input.addEventListener('change', () => {
            const v = parseFloat(input.value);
            if (Number.isFinite(v)) this.refresh(() => apply(v));
        });
        (row ?? this.row(label)).appendChild(input);
        return input;
    }

    text(label: string, value: string, apply: (v: string) => void, row?: HTMLElement) {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'nd-text';
        input.value = value;
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') input.blur();
        });
        input.addEventListener('change', () => this.refresh(() => apply(input.value.trim())));
        (row ?? this.row(label)).appendChild(input);
        return input;
    }

    drop(row: HTMLElement, title: string, action: () => void) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'nd-drop';
        b.textContent = '×';
        b.title = title;
        b.addEventListener('click', action);
        row.appendChild(b);
    }
}

const count = (n: number) => n.toLocaleString();

// what every merged object says about itself: the inputs and what they came to
const buildInputs = (face: Face, op: CombineOp, names?: (i: number) => string, rename?: (i: number, v: string) => void) => {
    const built = op.built;
    op.inputs.forEach((input, i) => {
        const row = face.row(`${i + 1}`);
        if (rename) {
            face.text('', names(i), v => rename(i, v), row).placeholder = input.name ?? '';
        } else {
            const el = document.createElement('div');
            el.className = 'nd-value';
            el.textContent = input.name ?? '';
            row.appendChild(el);
        }
        const n = document.createElement('div');
        n.className = 'nd-value';
        const copies = built?.copies[i] ?? 0;
        n.textContent = built ? `${count(built.rows[i] ?? 0)}${copies > 1 ? ` ×${copies}` : ''}` : '';
        n.title = i18n.t('node.merge.rows-title');
        row.appendChild(n);
        const min = op instanceof MergeOp ? 2 : 1;
        if (op.inputs.length > min) {
            face.drop(row, i18n.t('node.merge.remove-input'), () => face.events.invoke('graph.mergeRemoveInput', face.index, i));
        }
    });
    if (built) {
        face.stat(i18n.t('node.merge.gaussians'), count(built.total));
        face.stat(i18n.t('node.merge.frames'), built.frames ? count(built.frames) : i18n.t('node.merge.still'));
        face.stat(i18n.t('node.merge.bands'), String(built.bands));
    }
};

const buildMerge = (face: Face, op: MergeOp) => {
    buildInputs(face, op, i => op.settings.names[i] ?? '', (i, v) => {
        op.settings.names[i] = v;
    });
    face.choice(i18n.t('node.merge.sh'), [
        ['pad', i18n.t('node.merge.sh-pad')],
        ['truncate', i18n.t('node.merge.sh-truncate')]
    ], op.settings.sh, (v) => {
        op.settings.sh = v;
    });
    face.note(i18n.t('node.merge.note'));
    if (op.inputs.some(s => s.motion)) face.note(i18n.t('node.merge.note-4d'));
    if (op.built?.copies.some(c => c > 1)) face.note(i18n.t('node.merge.note-copies'));
};

// "0:1, 48:2" - from frame 0 input 1, from frame 48 input 2 (1-based, as shown)
const formatCuts = (cuts: SwitchCut[]) => cuts.map(c => `${c.frame}:${c.input + 1}`).join(', ');
const parseCuts = (text: string, inputs: number): SwitchCut[] => text.split(/[,;\s]+/).filter(Boolean).map((part) => {
    const [f, i] = part.split(':').map(v => parseInt(v, 10));
    return { frame: f, input: i - 1 };
}).filter(c => Number.isFinite(c.frame) && c.frame >= 0 && Number.isFinite(c.input) && c.input >= 0 && c.input < inputs)
.sort((a, b) => a.frame - b.frame);

const buildSwitch = (face: Face, op: SwitchOp) => {
    face.choice(i18n.t('node.switch.index'), op.inputs.map((s, i) => [`${i}`, `${i + 1} ${s.name ?? ''}`.trim()] as [string, string]), `${op.settings.index}`, (v) => {
        op.settings.index = parseInt(v, 10) || 0;
    });
    face.text(i18n.t('node.switch.cuts'), formatCuts(op.settings.cuts), (v) => {
        op.settings.cuts = parseCuts(v, op.inputs.length);
    }).placeholder = '0:1, 48:2';
    const frame = face.events.invoke('timeline.frame') ?? 0;
    face.stat(i18n.t('node.switch.now'), `${op.indexAt(frame) + 1}`);
    buildInputs(face, op);
    face.note(i18n.t('node.switch.note'));
};

/**
 * Build the face of a combining node into the node pane's body. False when
 * `op` is none of them.
 */
const buildCombineFace = (op: EditOp, index: number, body: HTMLElement, events: Events) => {
    const face = new Face(body, events, index);
    if (op instanceof MergeOp) buildMerge(face, op);
    else if (op instanceof SwitchOp) buildSwitch(face, op);
    else return false;
    return true;
};

export { buildCombineFace };
