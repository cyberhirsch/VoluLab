import { Container } from '@playcanvas/pcui';
import { Mat4, Quat, Vec3 } from 'playcanvas';

import { CleanupOp, CropOp, DecimateOp, EditOp, EntityTransformOp, OutputFileType, OutputOp, ScopedColorOp, SelectMode, SelectOp, SetShBandsOp, SplatRenameOp, SplatsTransformOp, StateOp, principalOp } from '../edit-ops';
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

        const { op: outer, index } = current;
        // A transform arrives wrapped with the pivot placement that went with
        // it, so the node's settings are the ones inside the bundle.
        const op = principalOp(outer);

        // Both colour nodes show the same panel; what differs is whether it
        // edits the object's grade or the node's own.
        if (op.name === 'setSplatColor' || op instanceof ScopedColorOp) {
            const panel = this.mounts.get('colour');
            if (panel) {
                this.empty.hidden = true;
                (panel as any).bindNode?.(op instanceof ScopedColorOp ? op : null, index);
                this.body.appendChild(panel);
                if (op instanceof ScopedColorOp) {
                    this.stat('scope', `${op.affected < 0 ? 'not applied' : op.affected.toLocaleString()} selected`);
                }
                return;
            }
        }

        if (op instanceof SelectOp) {
            this.empty.hidden = true;
            this.buildSelect(op, index);
            return;
        }

        if (op instanceof EntityTransformOp) {
            this.empty.hidden = true;
            this.buildTransform(op, index);
            return;
        }

        if (op instanceof CropOp) {
            this.empty.hidden = true;
            this.buildCrop(op, index);
            return;
        }

        if (op instanceof CleanupOp) {
            this.empty.hidden = true;
            this.buildCleanup(op, index);
            return;
        }

        if (op instanceof DecimateOp) {
            this.empty.hidden = true;
            this.buildDecimate(op, index);
            return;
        }

        if (op instanceof SetShBandsOp) {
            this.empty.hidden = true;
            this.buildShBands(op, index);
            return;
        }

        if (op instanceof SplatsTransformOp) {
            this.empty.hidden = true;
            this.buildSplatsTransform(op);
            return;
        }

        // Last of the state ops, because crop, cleanup and decimate are all
        // StateOps too and each has real parameters - this is the fallback for
        // the ones that have none: delete, hide, and their inverses. What they
        // do have is a result, and how much they touched is worth knowing.
        if (op instanceof StateOp) {
            this.empty.hidden = true;
            this.buildStateOp(op);
            return;
        }

        if (op instanceof OutputOp) {
            this.empty.hidden = true;
            this.buildOutput(op, index);
            return;
        }

        if (op instanceof SplatRenameOp) {
            this.empty.hidden = true;
            this.stat('from', op.oldName);
            this.stat('to', op.newName);
            return;
        }

        this.empty.hidden = false;
        this.empty.textContent = `${op.name} has no settings`;
    }

    /**
     * What an output node writes, and the button that writes it.
     *
     * Nothing here is an edit, so the settings are changed in place and the
     * pane simply redrawn - there is no history to replay for a node that
     * changes nothing.
     */
    private buildOutput(op: OutputOp, index: number) {
        const FORMATS: { type: OutputFileType, label: string, ext: string }[] = [
            { type: 'ply', label: 'ply', ext: '.ply' },
            { type: 'compressedPly', label: 'ply (compressed)', ext: '.compressed.ply' },
            { type: 'splat', label: 'splat', ext: '.splat' },
            { type: 'sog', label: 'sog', ext: '.sog' },
            { type: 'spz', label: 'spz', ext: '.spz' }
        ];

        const formatRow = this.row('format');
        const formats = document.createElement('div');
        formats.className = 'nd-choices';
        FORMATS.forEach(({ type, label, ext }) => {
            const b = document.createElement('button');
            b.className = 'nd-choice';
            b.type = 'button';
            b.textContent = label;
            if (op.settings.fileType === type) b.classList.add('nd-choice-active');
            b.addEventListener('click', () => {
                op.settings.fileType = type;
                // carry the name across, since the extension is the format's
                const base = op.settings.filename.replace(/(\.compressed)?\.(ply|splat|sog|spz)$/i, '');
                op.settings.filename = base + ext;
                this.rebuild();
            });
            formats.appendChild(b);
        });
        formatRow.appendChild(formats);
        this.body.appendChild(formatRow);

        const nameRow = this.row('file');
        const name = document.createElement('input');
        name.type = 'text';
        name.className = 'nd-text';
        name.value = op.settings.filename;
        name.addEventListener('keydown', e => e.stopPropagation());
        name.addEventListener('change', () => {
            op.settings.filename = name.value.trim() || op.settings.filename;
        });
        nameRow.appendChild(name);
        this.body.appendChild(nameRow);

        const bandsRow = this.row('sh bands');
        const bands = document.createElement('input');
        bands.type = 'range';
        bands.className = 'nd-slider';
        bands.min = '0';
        bands.max = '3';
        bands.step = '1';
        bands.value = `${op.settings.maxSHBands}`;
        const bandsOut = document.createElement('div');
        bandsOut.className = 'nd-value';
        bandsOut.textContent = `${op.settings.maxSHBands}`;
        bands.addEventListener('input', () => {
            bandsOut.textContent = bands.value;
        });
        bands.addEventListener('change', () => {
            op.settings.maxSHBands = parseInt(bands.value, 10);
        });
        bandsRow.appendChild(bands);
        bandsRow.appendChild(bandsOut);
        this.body.appendChild(bandsRow);

        const scopeRow = this.row('scope');
        const scope = document.createElement('button');
        scope.type = 'button';
        scope.className = 'nd-choice';
        scope.textContent = op.settings.selectedOnly ? 'selected only' : 'everything';
        if (op.settings.selectedOnly) scope.classList.add('nd-choice-active');
        scope.addEventListener('click', () => {
            op.settings.selectedOnly = !op.settings.selectedOnly;
            this.rebuild();
        });
        scopeRow.appendChild(scope);
        this.body.appendChild(scopeRow);

        const write = document.createElement('button');
        write.type = 'button';
        write.className = 'nd-action';
        write.textContent = 'write file';
        write.addEventListener('click', () => this.events.invoke('output.write', index));
        this.body.appendChild(write);

        const note = document.createElement('div');
        note.className = 'nd-note';
        note.textContent = 'writes the object as it stands at this point in the chain, not as it stands now';
        this.body.appendChild(note);
    }

    /**
     * A transform of the selected gaussians rather than of the object.
     *
     * Read-only. The op carries the matrix it applied along with a map of the
     * transform-palette slots it moved things between, and those two have to
     * agree - so changing the matrix here would mean rebuilding the map, which
     * is the gizmo's job rather than a text field's.
     */
    private buildSplatsTransform(op: SplatsTransformOp) {
        const m = op.transform;
        const t = new Vec3();
        const s = new Vec3();
        const r = new Quat();
        m.getTranslation(t);
        m.getScale(s);
        r.setFromMat4(m);
        const e = r.getEulerAngles();

        const trio = (label: string, v: { x: number, y: number, z: number }) => {
            this.stat(label, `${+v.x.toFixed(3)}, ${+v.y.toFixed(3)}, ${+v.z.toFixed(3)}`);
        };

        trio('moved by', t);
        trio('rotated by', e);
        trio('scaled by', s);

        const note = document.createElement('div');
        note.className = 'nd-note';
        note.textContent = 'applies to the gaussians that were selected here. drag the gizmo in the viewport to change it';
        this.body.appendChild(note);
    }

    /**
     * A slider whose change replays the node it belongs to.
     *
     * Only on release, never while dragging: each step re-resolves the op and
     * everything after it, which is far too much work to do per pixel.
     */
    private replaySlider(
        label: string,
        value: number,
        min: number,
        max: number,
        step: number,
        index: number,
        apply: (v: number) => void,
        format: (v: number) => string = v => `${v}`
    ) {
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
        readout.textContent = format(value);

        input.addEventListener('input', () => {
            readout.textContent = format(parseFloat(input.value));
        });
        // the change goes with the replay, not before it - see EditHistory.refresh
        input.addEventListener('change', () => {
            const v = parseFloat(input.value);
            this.events.invoke('edit.refresh', index, () => apply(v));
        });

        row.appendChild(input);
        row.appendChild(readout);
        this.body.appendChild(row);
    }

    /** A two-state button whose change replays the node. */
    private replayToggle(label: string, on: boolean, text: string, index: number, apply: () => void) {
        const row = this.row(label);
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'nd-choice';
        b.textContent = text;
        if (on) b.classList.add('nd-choice-active');
        b.addEventListener('click', () => {
            this.events.invoke('edit.refresh', index, apply);
        });
        row.appendChild(b);
        this.body.appendChild(row);
    }

    private buildCrop(op: CropOp, index: number) {
        const t = new Vec3();
        const s = new Vec3();
        op.transform.getTranslation(t);
        op.transform.getScale(s);

        const rebuild = () => {
            const m = new Mat4();
            m.setTRS(t, Quat.IDENTITY, s);
            op.setVolume(op.shape, m, op.keepInside);
        };

        const triple = (label: string, v: Vec3) => {
            const row = this.row(label);
            const fields = (['x', 'y', 'z'] as const).map((axis) => {
                const input = document.createElement('input');
                input.type = 'number';
                input.className = 'nd-num';
                input.step = '0.05';
                input.value = `${+v[axis].toFixed(4)}`;
                input.addEventListener('keydown', e => e.stopPropagation());
                input.addEventListener('change', () => {
                    this.events.invoke('edit.refresh', index, () => {
                        (['x', 'y', 'z'] as const).forEach((a, i) => {
                            v[a] = parseFloat(fields[i].value) || 0;
                        });
                        rebuild();
                    });
                });
                row.appendChild(input);
                return input;
            });
            this.body.appendChild(row);
        };

        this.replayToggle('shape', op.shape === 'sphere', op.shape, index, () => {
            op.setVolume(op.shape === 'box' ? 'sphere' : 'box', op.transform, op.keepInside);
        });
        this.replayToggle('keep', op.keepInside, op.keepInside ? 'inside' : 'outside', index, () => {
            op.setVolume(op.shape, op.transform, !op.keepInside);
        });

        triple('centre', t);
        triple('size', s);

        this.stat('removed', op.affected < 0 ? 'not applied' : op.affected.toLocaleString());
    }

    private buildCleanup(op: CleanupOp, index: number) {
        this.replaySlider('neighbours', op.neighbours, 4, 64, 1, index, (v) => {
            op.setParams(Math.round(v), op.deviations);
        });
        this.replaySlider('spread', op.deviations, 0.25, 4, 0.05, index, (v) => {
            op.setParams(op.neighbours, v);
        }, v => v.toFixed(2));

        this.stat('removed', op.affected < 0 ? 'not applied' : op.affected.toLocaleString());

        const note = document.createElement('div');
        note.className = 'nd-note';
        note.textContent = 'removes gaussians sitting further from their neighbours than most. lower spread removes more';
        this.body.appendChild(note);
    }

    private buildDecimate(op: DecimateOp, index: number) {
        this.replaySlider('keep', op.fraction, 0.01, 1, 0.01, index, (v) => {
            op.setFraction(v);
        }, v => `${Math.round(v * 100)}%`);

        this.stat('removed', op.affected < 0 ? 'not applied' : op.affected.toLocaleString());

        const note = document.createElement('div');
        note.className = 'nd-note';
        note.textContent = 'drops the least important first - faint and small before bright and large';
        this.body.appendChild(note);
    }

    private buildShBands(op: SetShBandsOp, index: number) {
        this.replaySlider('bands', op.newBands, 0, 3, 1, index, (v) => {
            op.newBands = Math.round(v);
        });

        const note = document.createElement('div');
        note.className = 'nd-note';
        note.textContent = 'fewer bands means a smaller file and flatter view-dependent shading. 0 keeps colour only';
        this.body.appendChild(note);
    }

    /** What a state op did, and a note on what it means to bypass it. */
    private buildStateOp(op: StateOp) {
        const NOTES: Record<string, string> = {
            deleteSelection: 'removes what was selected here. bypass to keep it',
            reset: 'brings back what earlier nodes deleted',
            hideSelection: 'hides what was selected here',
            unhideAll: 'reveals everything hidden further up',
            selectAll: 'selects every splat that is not hidden or deleted',
            selectNone: 'clears the selection',
            selectInvert: 'swaps selected for unselected'
        };

        const n = op.affected;
        this.stat('splats', n < 0 ? 'not applied' : n.toLocaleString());

        const note = document.createElement('div');
        note.className = 'nd-note';
        note.textContent = NOTES[op.name] ?? 'no settings';
        this.body.appendChild(note);
    }

    /**
     * The object's placement. Editing writes into the op's target transform
     * and replays from there, so moving a node that other edits stand on
     * rebuilds them rather than stranding them.
     */
    private buildTransform(op: EntityTransformOp, index: number) {
        const euler = op.newt.rotation.getEulerAngles();

        const triple = (
            label: string,
            values: number[],
            apply: (v: number[]) => void
        ) => {
            const row = this.row(label);
            const fields = values.map((value, i) => {
                const input = document.createElement('input');
                input.type = 'number';
                input.className = 'nd-num';
                input.step = '0.01';
                input.value = `${+value.toFixed(4)}`;
                input.addEventListener('keydown', e => e.stopPropagation());
                input.addEventListener('change', () => {
                    const next = fields.map(f => parseFloat(f.value) || 0);
                    this.events.invoke('edit.refresh', index, () => apply(next));
                });
                row.appendChild(input);
                return input;
            });
            this.body.appendChild(row);
        };

        triple('position', [op.newt.position.x, op.newt.position.y, op.newt.position.z], (v) => {
            op.newt.position.set(v[0], v[1], v[2]);
        });

        triple('rotation', [euler.x, euler.y, euler.z], (v) => {
            op.newt.rotation.setFromEulerAngles(v[0], v[1], v[2]);
        });

        triple('scale', [op.newt.scale.x, op.newt.scale.y, op.newt.scale.z], (v) => {
            // a zero scale collapses the object and cannot be undone by typing,
            // because every later value multiplies through it
            op.newt.scale.set(v[0] || 1e-4, v[1] || 1e-4, v[2] || 1e-4);
        });
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
