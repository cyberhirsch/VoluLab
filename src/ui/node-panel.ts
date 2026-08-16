import { Container } from '@playcanvas/pcui';

import { EditOp, SelectMode, SelectOp, SplatRenameOp } from '../edit-ops';
import { Events } from '../events';
import { SelectQuery, describeQuery, isParametric } from '../select-query';
import { Splat } from '../splat';

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

    /** set when the graph has an import node open - its settings are the object */
    private importSplat: Splat | null = null;

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

        events.on('graph.selected', (selected: { index: number | null, splat: Splat | null, isImport: boolean }) => {
            this.selected = selected?.index ?? null;
            this.importSplat = selected?.isImport ? selected.splat : null;
            this.rebuild();
        });
        events.on('splat.name', () => this.rebuild());
        events.on('splat.visibility', () => this.rebuild());
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

        if (this.importSplat) {
            this.empty.hidden = true;
            this.buildImport(this.importSplat);
            return;
        }

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

    /** A read-only figure, right-aligned against its label. */
    private stat(label: string, value: string) {
        const row = this.row(label);
        const el = document.createElement('div');
        el.className = 'nd-value';
        el.textContent = value;
        row.appendChild(el);
        this.body.appendChild(row);
    }

    /**
     * An import node's settings are the object it brought in: what it is
     * called, whether it is showing, and what it contains.
     */
    private buildImport(splat: Splat) {
        const nameRow = this.row('name');
        const name = document.createElement('input');
        name.type = 'text';
        name.className = 'nd-text';
        name.value = splat.name ?? '';
        const commitName = () => {
            const next = name.value.trim();
            if (next && next !== splat.name) {
                this.events.fire('edit.add', new SplatRenameOp(splat, next));
            }
        };
        name.addEventListener('change', commitName);
        name.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') name.blur();
        });
        nameRow.appendChild(name);
        this.body.appendChild(nameRow);

        const visRow = this.row('visible');
        const vis = document.createElement('button');
        vis.type = 'button';
        vis.className = 'nd-choice';
        vis.textContent = splat.visible ? 'shown' : 'hidden';
        if (splat.visible) vis.classList.add('nd-choice-active');
        vis.addEventListener('click', () => {
            splat.visible = !splat.visible;
        });
        visRow.appendChild(vis);
        this.body.appendChild(visRow);

        const total = splat.splatData?.numSplats ?? 0;
        this.stat('gaussians', total.toLocaleString());
        this.stat('selected', (splat.numSelected ?? 0).toLocaleString());
        this.stat('hidden', (splat.numLocked ?? 0).toLocaleString());
        this.stat('deleted', (splat.numDeleted ?? 0).toLocaleString());
    }

    /**
     * A select node's settings: which tool authors it, and the gestures it is
     * made of. Every gesture lands in the node being worked on, so the list
     * grows rather than the graph.
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

        if (!op.steps.length) {
            const note = document.createElement('div');
            note.className = 'nd-note';
            note.textContent = 'empty - pick a tool and draw in the viewport';
            this.body.appendChild(note);
            return;
        }

        // The steps, oldest first. Each is a gesture that went into this node,
        // with the mode it combined by and a way to drop it again.
        op.steps.forEach((step, i) => {
            const row = this.row(i === 0 ? 'steps' : '');
            row.classList.add('nd-step');

            const modes = document.createElement('div');
            modes.className = 'nd-choices';
            SELECT_MODES.forEach(({ mode, label }) => {
                // the first step has nothing before it to combine with, so it
                // is a plain replacement whatever it was drawn as
                if (i === 0 && mode !== 'set') return;
                const b = document.createElement('button');
                b.className = 'nd-choice';
                b.type = 'button';
                b.textContent = label;
                if (step.mode === mode) b.classList.add('nd-choice-active');
                b.addEventListener('click', () => {
                    const steps = op.steps.map((s, j) => (j === i ? { ...s, mode: mode as SelectMode } : s));
                    this.events.invoke('edit.reselect', index, steps);
                });
                modes.appendChild(b);
            });
            row.appendChild(modes);

            const by = document.createElement('div');
            by.className = 'nd-value nd-step-by';
            by.textContent = describeQuery(step.query);
            by.title = describeQuery(step.query);
            row.appendChild(by);

            const drop = document.createElement('button');
            drop.type = 'button';
            drop.className = 'nd-drop';
            drop.textContent = '×';
            drop.title = 'remove this step';
            drop.addEventListener('click', () => {
                this.events.invoke('edit.reselect', index, op.steps.filter((_, j) => j !== i));
            });
            row.appendChild(drop);

            this.body.appendChild(row);
        });

        // parameters belong to the last step, which is the one just drawn
        const last = op.steps[op.steps.length - 1];
        if (isParametric(last.query)) {
            this.buildQueryFields(op, index);
        } else {
            const note = document.createElement('div');
            note.className = 'nd-note';
            note.textContent = 'a stored hit set - draw again to replace it';
            this.body.appendChild(note);
        }
    }

    /** Numeric fields for the last step, where its query kind has any. */
    private buildQueryFields(op: SelectOp, index: number) {
        const at = op.steps.length - 1;
        const query = op.steps[at].query;

        // a field edits one step in place, leaving the rest of the list alone
        const withQuery = (next: SelectQuery) => {
            return op.steps.map((s, j) => (j === at ? { ...s, query: next } : s));
        };

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
                this.events.invoke('edit.reselect', index, withQuery(apply(parseFloat(input.value))));
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
