import { Container } from '@playcanvas/pcui';

import { EditOp, MultiOp, SelectOp } from '../edit-ops';
import { Events } from '../events';
import { describeQuery, isParametric } from '../select-query';
import { Splat } from '../splat';
import { MenuEntry, contributeMenuItems } from './context-menu';

/**
 * The node graph.
 *
 * This is a view over the edit history, not a second store: every node is an
 * entry that already exists in EditHistory, drawn where it belongs rather than
 * as a flat list. Each loaded object gets an import node, and the operations
 * touching that object hang off it as a chain, so the graph reads as "what has
 * been done to this thing, in order".
 *
 * Clicking a node moves the history cursor to just after it, which is undo/redo
 * addressed by position instead of by repetition. Nodes past the cursor are
 * drawn dimmed - they exist, they are simply not currently applied.
 *
 * What it is not, yet: editable. A node cannot be re-ordered, disabled or
 * re-evaluated, because a selection op stores the index ranges it resolved to
 * rather than the intent that produced them - see the note in edit-ops.ts.
 * Making selections parametric is the next step, and this view is what will
 * display them.
 */

const NODE_W = 148;
const NODE_H = 38;
const COL_GAP = 44;
const LANE_GAP = 34;
const PAD = 28;

const MIN_SCALE = 0.3;
const MAX_SCALE = 2.5;

const SVG_NS = 'http://www.w3.org/2000/svg';

// EditOp.name is the internal identifier; these are what a person should read.
// Anything missing falls through to the raw name rather than to a blank node.
const OP_LABELS: Record<string, string> = {
    selectAll: 'select all',
    selectNone: 'deselect all',
    selectInvert: 'invert selection',
    selectOp: 'select',
    hideSelection: 'hide selection',
    unhideAll: 'unhide all',
    deleteSelection: 'delete selection',
    reset: 'restore deleted',
    entityTransform: 'transform',
    splatsTransform: 'transform splats',
    setPivot: 'place pivot',
    setLocalFrame: 'local frame',
    shapeTransform: 'selection volume',
    setSplatColor: 'color grade',
    multiOp: 'combined edit',
    addSplat: 'add object',
    splatRename: 'rename'
};

const opLabel = (op: EditOp) => OP_LABELS[op.name] ?? op.name;

// The object an op belongs to, or null for ops that act on the scene at large
// (the pivot, a selection volume, an animation track). MultiOp is grouped by
// its first member, which is what its members share in practice.
const opSplat = (op: EditOp): Splat | null => {
    if (op instanceof MultiOp) {
        for (const nested of op.ops) {
            const splat = opSplat(nested);
            if (splat) return splat;
        }
        return null;
    }
    return ((op as any).splat as Splat) ?? null;
};

interface NodeModel {
    /** history index this node moves the cursor past, or -1 for an import */
    index: number;
    kind: string;
    name: string;
    x: number;
    y: number;
    applied: boolean;
    splat: Splat | null;
    /** set on selections: false where the query can be run again */
    frozen?: boolean;
    select?: boolean;
    colour?: boolean;
    /** how many committed changes this node stands for, when more than one */
    folded?: number;
}

interface EdgeModel {
    from: NodeModel;
    to: NodeModel;
}

class GraphPanel extends Container {
    private events: Events;

    private stage: HTMLElement;
    private edges: SVGSVGElement;
    private empty: HTMLElement;

    // view transform, applied to the stage as a whole
    private tx = PAD;
    private ty = PAD;
    private scale = 1;

    /** history index of the node being edited, or null */
    private selected: number | null = null;

    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'graph-panel',
            class: 'panel'
        };

        super(args);

        this.events = events;

        // the panel is a viewport onto a larger stage
        this.dom.classList.add('gn-viewport');

        this.stage = document.createElement('div');
        this.stage.className = 'gn-stage';

        this.edges = document.createElementNS(SVG_NS, 'svg');
        this.edges.classList.add('gn-edges');
        this.stage.appendChild(this.edges);

        this.empty = document.createElement('div');
        this.empty.className = 'gn-empty';
        this.empty.textContent = 'nothing loaded';

        this.dom.appendChild(this.stage);
        this.dom.appendChild(this.empty);

        // the viewport swallows pointer events so panning here doesn't also
        // orbit the camera underneath
        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((name) => {
            this.dom.addEventListener(name, (event: Event) => event.stopPropagation());
        });

        this.bindNavigation();

        const refresh = () => this.rebuild();
        events.on('edit.changed', refresh);
        events.on('scene.elementAdded', refresh);
        events.on('scene.elementRemoved', refresh);
        events.on('splat.name', refresh);

        // The panel is built before main.ts has registered the scene and
        // history accessors it reads, so the first draw waits for the current
        // synchronous startup to finish rather than asking too early.
        queueMicrotask(refresh);
    }

    /** Pan by dragging the background, zoom on the wheel, double-click to reset. */
    private bindNavigation() {
        let panning = false;
        let startX = 0;
        let startY = 0;
        let originX = 0;
        let originY = 0;

        this.dom.addEventListener('pointerdown', (e: PointerEvent) => {
            // a click that started on a node is that node's, not the canvas's
            if ((e.target as HTMLElement).closest('.gn-node')) return;
            panning = true;
            startX = e.clientX;
            startY = e.clientY;
            originX = this.tx;
            originY = this.ty;
            this.dom.setPointerCapture(e.pointerId);
            this.dom.classList.add('gn-panning');
        });

        this.dom.addEventListener('pointermove', (e: PointerEvent) => {
            if (!panning) return;
            this.tx = originX + (e.clientX - startX);
            this.ty = originY + (e.clientY - startY);
            this.applyTransform();
        });

        const endPan = (e: PointerEvent) => {
            if (!panning) return;
            panning = false;
            this.dom.releasePointerCapture(e.pointerId);
            this.dom.classList.remove('gn-panning');
        };
        this.dom.addEventListener('pointerup', endPan);
        this.dom.addEventListener('pointercancel', endPan);

        this.dom.addEventListener('wheel', (e: WheelEvent) => {
            e.preventDefault();
            const rect = this.dom.getBoundingClientRect();
            const px = e.clientX - rect.left;
            const py = e.clientY - rect.top;

            const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
            // keep the point under the cursor fixed while the scale changes
            const k = next / this.scale;
            this.tx = px - (px - this.tx) * k;
            this.ty = py - (py - this.ty) * k;
            this.scale = next;
            this.applyTransform();
        }, { passive: false });

        this.dom.addEventListener('dblclick', (e: MouseEvent) => {
            if ((e.target as HTMLElement).closest('.gn-node')) return;
            this.tx = PAD;
            this.ty = PAD;
            this.scale = 1;
            this.applyTransform();
        });

        // right-click on empty canvas: adding, plus a way back to the origin.
        // The event carries on up to the pane, which appends its own items.
        this.dom.addEventListener('contextmenu', (e: MouseEvent) => {
            if ((e.target as HTMLElement).closest('.gn-node')) return;
            this.select(null);
            contributeMenuItems(e, [
                ...this.addItems(),
                'separator',
                {
                    label: 'reset view',
                    action: () => {
                        this.tx = PAD;
                        this.ty = PAD;
                        this.scale = 1;
                        this.applyTransform();
                    }
                }
            ]);
        });
    }

    private applyTransform() {
        this.stage.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
    }

    /**
     * Lay the history out as one chain per object.
     *
     * Lanes are seeded from the scene rather than from history, so an object
     * that was loaded from disk - which never produced an AddSplatOp - still
     * gets an import node to hang its edits off.
     */
    private build(): { nodes: NodeModel[]; edges: EdgeModel[] } {
        const { ops, cursor } = (this.events.invoke('edit.history') ?? { ops: [], cursor: 0 }) as
            { ops: EditOp[]; cursor: number };
        const splats = (this.events.invoke('scene.allSplats') ?? []) as Splat[];

        // lane key -> the nodes in it, left to right. Insertion order of the
        // map is the row order on screen.
        const lanes = new Map<Splat | null, NodeModel[]>();
        const laneOf = (key: Splat | null) => {
            if (!lanes.has(key)) lanes.set(key, []);
            return lanes.get(key);
        };

        // y is filled in below, once every lane exists and the rows are known
        const add = (key: Splat | null, node: Omit<NodeModel, 'x' | 'y'>) => {
            const lane = laneOf(key);
            lane.push({ ...node, x: lane.length * (NODE_W + COL_GAP), y: 0 });
        };

        splats.forEach((splat) => {
            add(splat, {
                index: -1,
                kind: 'import',
                name: splat.name ?? 'object',
                applied: true,
                splat
            });
        });

        // Colour is one node per object, not one per nudge of a slider.
        // History still holds every committed change - undo is unaffected - but
        // a chain of thirty colour ops is a record of typing, not a description
        // of the object, so the lane shows the first and folds the rest into it.
        const colourNode = new Map<Splat | null, NodeModel>();

        ops.forEach((op, i) => {
            const splat = opSplat(op);
            // an op with no object of its own - or whose object is gone - still
            // belongs somewhere; the scene lane is where those collect
            const key = splat && splats.includes(splat) ? splat : null;
            if (key === null && laneOf(null).length === 0) {
                add(null, { index: -1, kind: 'scene', name: '', applied: true, splat: null });
            }

            if (op.name === 'setSplatColor') {
                const existing = colourNode.get(key);
                if (existing) {
                    // the node stands for the latest committed value, and
                    // jumping to it should land after that one
                    existing.index = i;
                    existing.applied = i < cursor;
                    existing.folded = (existing.folded ?? 1) + 1;
                    return;
                }
                const node: Omit<NodeModel, 'x' | 'y'> = {
                    index: i,
                    kind: 'colour',
                    name: 'grade',
                    applied: i < cursor,
                    splat,
                    colour: true
                };
                add(key, node);
                colourNode.set(key, laneOf(key)[laneOf(key).length - 1]);
                return;
            }

            // a selection shows what it selects by, not merely that it selected
            const select = op instanceof SelectOp ? op : null;
            add(key, {
                index: i,
                kind: select ?
                    (select.mode === 'set' ? 'select' : `select ${select.mode}`) :
                    opLabel(op),
                name: select ? describeQuery(select.query) : '',
                applied: i < cursor,
                splat,
                select: !!select,
                frozen: select ? !isParametric(select.query) : undefined
            });
        });

        const nodes: NodeModel[] = [];
        const edges: EdgeModel[] = [];

        [...lanes.values()].forEach((lane, row) => {
            lane.forEach((node, col) => {
                node.y = row * (NODE_H + LANE_GAP);
                if (col > 0) edges.push({ from: lane[col - 1], to: node });
                nodes.push(node);
            });
        });

        return { nodes, edges };
    }

    private rebuild() {
        const { nodes, edges } = this.build();

        [...this.stage.querySelectorAll('.gn-node')].forEach(n => n.remove());
        this.edges.replaceChildren();

        this.empty.hidden = nodes.length > 0;

        const width = Math.max(...nodes.map(n => n.x + NODE_W), 0) + PAD;
        const height = Math.max(...nodes.map(n => n.y + NODE_H), 0) + PAD;
        this.edges.setAttribute('width', `${width}`);
        this.edges.setAttribute('height', `${height}`);
        this.edges.setAttribute('viewBox', `0 0 ${width} ${height}`);

        edges.forEach(({ from, to }) => {
            const x1 = from.x + NODE_W;
            const y1 = from.y + NODE_H / 2;
            const x2 = to.x;
            const y2 = to.y + NODE_H / 2;
            const bend = Math.max(16, (x2 - x1) * 0.5);

            const path = document.createElementNS(SVG_NS, 'path');
            path.setAttribute('d', `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`);
            path.setAttribute('class', to.applied ? 'gn-edge' : 'gn-edge gn-pending');
            this.edges.appendChild(path);
        });

        nodes.forEach(node => this.stage.appendChild(this.buildNode(node)));

        this.applyTransform();
    }

    private buildNode(node: NodeModel): HTMLElement {
        const el = document.createElement('div');
        el.className = 'gn-node';
        if (!node.applied) el.classList.add('gn-pending');
        if (node.index === -1) el.classList.add('gn-source');
        // a stored hit set rather than a query that can be turned
        if (node.frozen) el.classList.add('gn-frozen');
        el.style.left = `${node.x}px`;
        el.style.top = `${node.y}px`;
        el.style.width = `${NODE_W}px`;
        el.style.height = `${NODE_H}px`;

        const kind = document.createElement('div');
        kind.className = 'gn-node-kind';
        kind.textContent = node.kind;
        el.appendChild(kind);

        if (node.name) {
            const name = document.createElement('div');
            name.className = 'gn-node-name';
            name.textContent = node.name;
            name.title = node.name;
            el.appendChild(name);
        }

        // an input port only where an edge actually arrives - the first node in
        // a lane is a source
        if (node.x > 0) {
            const inPort = document.createElement('div');
            inPort.className = 'gn-port gn-port-in';
            el.appendChild(inPort);
        }
        const outPort = document.createElement('div');
        outPort.className = 'gn-port gn-port-out';
        el.appendChild(outPort);

        if (node.folded > 1) {
            const count = document.createElement('div');
            count.className = 'gn-node-count';
            count.textContent = `${node.folded}`;
            count.title = `${node.folded} committed changes`;
            el.appendChild(count);
        }

        if (this.selected === node.index && node.index !== -1) {
            el.classList.add('gn-selected');
        }

        // Click selects - that is what puts a node's parameters in the node
        // pane. Moving the history cursor is the heavier action, so it takes
        // the deliberate gesture rather than the casual one.
        el.title = node.index === -1 ?
            (node.splat ? 'click to select this object' : 'edits not tied to one object') :
            'click to edit · double-click to move the history here';

        el.addEventListener('click', () => {
            if (node.splat) this.events.fire('selection', node.splat);
            this.select(node.index === -1 ? null : node.index);
        });

        if (node.index !== -1) {
            el.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                // the cursor sits after the op, so this step is the last applied
                this.events.fire('edit.goto', node.index + 1);
            });
        }

        el.addEventListener('contextmenu', (e) => {
            this.select(node.index === -1 ? null : node.index);
            contributeMenuItems(e, [
                ...this.addItems(),
                'separator',
                {
                    label: 'move history here',
                    disabled: node.index === -1,
                    action: () => this.events.fire('edit.goto', node.index + 1)
                }
            ]);
        });

        return el;
    }

    /** The node whose parameters the node pane is showing, by history index. */
    private select(index: number | null) {
        if (this.selected === index) return;
        this.selected = index;
        this.events.fire('graph.selected', index);
        this.rebuild();
    }

    /** The "add" half of the graph's context menu, shared by node and canvas. */
    private addItems(): MenuEntry[] {
        const splat = this.events.invoke('selection') as Splat;
        return [
            {
                label: 'add select node',
                disabled: !splat,
                hint: splat ? undefined : 'no object',
                action: () => this.events.fire('graph.addSelectNode')
            },
            {
                label: 'add colour node',
                disabled: !splat,
                hint: splat ? undefined : 'no object',
                action: () => this.events.fire('graph.addColourNode')
            }
        ];
    }
}

export { GraphPanel };
