import { Container } from '@playcanvas/pcui';

import { EditOp, SelectOp } from '../edit-ops';
import { Events } from '../events';
import { SelectQuery, describeQuery, isParametric } from '../select-query';

/**
 * The parameters of whichever node the graph has selected.
 *
 * The pane owns no controls of its own beyond the select node's. Anything with
 * a panel already - colour being the first - has that panel mounted here, so
 * there is one place to look at a node's settings rather than a pane per kind.
 * That is what replaced the standalone colour pane.
 */

const SELECT_TOOLS: { id: string, label: string, event: string }[] = [
    { id: 'rectSelection', label: 'rectangle', event: 'tool.rectSelection' },
    { id: 'lassoSelection', label: 'lasso', event: 'tool.lassoSelection' },
    { id: 'polygonSelection', label: 'polygon', event: 'tool.polygonSelection' },
    { id: 'brushSelection', label: 'brush', event: 'tool.brushSelection' },
    { id: 'sphereSelection', label: 'sphere', event: 'tool.sphereSelection' },
    { id: 'boxSelection', label: 'box', event: 'tool.boxSelection' },
    { id: 'floodSelection', label: 'flood', event: 'tool.floodSelection' },
    { id: 'eyedropperSelection', label: 'colour', event: 'tool.eyedropperSelection' }
];

const SELECT_MODES: { mode: string, label: string }[] = [
    { mode: 'set', label: 'set' },
    { mode: 'add', label: 'add' },
    { mode: 'remove', label: 'remove' },
    { mode: 'intersect', label: 'keep' }
];

class NodePanel extends Container {
    private events: Events;

    /** long-lived panels this pane hosts, by the node kind they belong to */
    private mounts = new Map<string, HTMLElement>();
    private body: HTMLElement;
    private empty: HTMLElement;

    private selected: number | null = null;

    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'node-panel',
            class: 'panel'
        };

        super(args);

        this.events = events;

        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((name) => {
            this.dom.addEventListener(name, (event: Event) => event.stopPropagation());
        });

        this.body = document.createElement('div');
        this.body.className = 'nd-body';
        this.dom.appendChild(this.body);

        this.empty = document.createElement('div');
        this.empty.className = 'nd-empty';
        this.empty.textContent = 'no node selected';
        this.dom.appendChild(this.empty);

        events.on('graph.selected', (index: number | null) => {
            this.selected = index;
            this.rebuild();
        });
        events.on('edit.changed', () => this.rebuild());
        events.on('tool.activated', () => this.rebuild());

        queueMicrotask(() => this.rebuild());
    }

    /**
     * Hand the pane a panel to show for a node kind. The element is long-lived
     * and simply moved in and out, the same contract the workspace uses, so a
     * panel keeps its wiring and its state across selections.
     */
    mount(kind: string, element: HTMLElement) {
        this.mounts.set(kind, element);
        element.remove();
    }

    /** The op the graph currently has selected, if it is still there. */
    private currentOp(): { op: EditOp, index: number } | null {
        if (this.selected === null) return null;
        const history = this.events.invoke('edit.history') as { ops: EditOp[] };
        const op = history?.ops?.[this.selected];
        return op ? { op, index: this.selected } : null;
    }

    private rebuild() {
        // take mounted panels out before clearing, or they are destroyed with
        // the chrome around them
        this.mounts.forEach(el => el.remove());
        this.body.replaceChildren();

        const current = this.currentOp();
        if (!current) {
            this.empty.hidden = false;
            this.empty.textContent = 'no node selected';
            return;
        }

        const { op, index } = current;

        if (op.name === 'setSplatColor') {
            const panel = this.mounts.get('colour');
            if (panel) {
                this.empty.hidden = true;
                this.body.appendChild(panel);
                return;
            }
        }

        if (op instanceof SelectOp) {
            this.empty.hidden = true;
            this.buildSelect(op, index);
            return;
        }

        this.empty.hidden = false;
        this.empty.textContent = `${op.name} has no settings`;
    }

    private row(label: string): HTMLElement {
        const row = document.createElement('div');
        row.className = 'nd-row';
        const text = document.createElement('div');
        text.className = 'nd-row-label';
        text.textContent = label;
        row.appendChild(text);
        return row;
    }

    /**
     * A select node's settings: which tool authors it, how it combines with
     * what is already selected, and what it currently resolves by.
     *
     * The tool buttons fire the same events the viewport toolbar does - there
     * is one set of selection controls, reachable from either place.
     */
    private buildSelect(op: SelectOp, index: number) {
        const active = this.events.invoke('tool.active');

        const toolRow = this.row('tool');
        const tools = document.createElement('div');
        tools.className = 'nd-choices';
        SELECT_TOOLS.forEach(({ id, label, event }) => {
            const b = document.createElement('button');
            b.className = 'nd-choice';
            b.type = 'button';
            b.textContent = label;
            if (active === id) b.classList.add('nd-choice-active');
            b.addEventListener('click', () => this.events.fire(event));
            tools.appendChild(b);
        });
        toolRow.appendChild(tools);
        this.body.appendChild(toolRow);

        const modeRow = this.row('mode');
        const modes = document.createElement('div');
        modes.className = 'nd-choices';
        SELECT_MODES.forEach(({ mode, label }) => {
            const b = document.createElement('button');
            b.className = 'nd-choice';
            b.type = 'button';
            b.textContent = label;
            if (op.mode === mode) b.classList.add('nd-choice-active');
            b.addEventListener('click', () => {
                // the bit operation follows the mode, so both move together;
                // re-running the query is what applies the change
                op.setMode(mode as typeof op.mode);
                this.events.invoke('edit.reselect', index, op.query);
            });
            modes.appendChild(b);
        });
        modeRow.appendChild(modes);
        this.body.appendChild(modeRow);

        const byRow = this.row('by');
        const by = document.createElement('div');
        by.className = 'nd-value';
        by.textContent = describeQuery(op.query);
        byRow.appendChild(by);
        this.body.appendChild(byRow);

        if (isParametric(op.query)) {
            this.buildQueryFields(op, index);
        } else {
            const note = document.createElement('div');
            note.className = 'nd-note';
            note.textContent = 'a stored hit set - draw again with a tool above to replace it';
            this.body.appendChild(note);
        }
    }

    /** Numeric fields for the query kinds that have any. */
    private buildQueryFields(op: SelectOp, index: number) {
        const query = op.query;

        const slider = (label: string, value: number, min: number, max: number, step: number, apply: (v: number) => SelectQuery) => {
            const row = this.row(label);
            const input = document.createElement('input');
            input.type = 'range';
            input.className = 'nd-slider';
            input.min = `${min}`;
            input.max = `${max}`;
            input.step = `${step}`;
            input.value = `${value}`;

            const readout = document.createElement('div');
            readout.className = 'nd-value';
            readout.textContent = value.toFixed(3);

            // live while dragging would re-run the whole tail of the history on
            // every pixel, so the query is only replaced when the drag ends
            input.addEventListener('input', () => {
                readout.textContent = parseFloat(input.value).toFixed(3);
            });
            input.addEventListener('change', () => {
                this.events.invoke('edit.reselect', index, apply(parseFloat(input.value)));
            });

            row.appendChild(input);
            row.appendChild(readout);
            this.body.appendChild(row);
        };

        if (query.kind === 'color') {
            slider('threshold', query.threshold, 0, 1, 0.001, v => ({ ...query, threshold: v }));

            const swatch = this.row('reference');
            const chip = document.createElement('div');
            chip.className = 'nd-swatch';
            chip.style.backgroundColor = `rgb(${Math.round(query.ref.r * 255)}, ${Math.round(query.ref.g * 255)}, ${Math.round(query.ref.b * 255)})`;
            swatch.appendChild(chip);
            this.body.appendChild(swatch);
        }

        if (query.kind === 'point') {
            slider('radius', query.size, 1, 64, 1, v => ({ ...query, size: v }));
        }

        if (query.kind === 'range') {
            slider('from', query.rangeStart, 0, query.numBins, 1, v => ({ ...query, rangeStart: Math.round(v) }));
            slider('to', query.rangeEnd, 0, query.numBins, 1, v => ({ ...query, rangeEnd: Math.round(v) }));
        }

        if (query.kind === 'sphere' || query.kind === 'box') {
            const note = document.createElement('div');
            note.className = 'nd-note';
            note.textContent = 'move the gizmo in the viewport to change the volume';
            this.body.appendChild(note);
        }
    }
}

export { NodePanel };
