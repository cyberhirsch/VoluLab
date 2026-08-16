import { Container } from '@playcanvas/pcui';

import { EditOp, MultiOp, SelectOp } from '../edit-ops';
import { Events } from '../events';
import { describeQuery, isParametric } from '../select-query';
import { Splat } from '../splat';

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
}

interface EdgeModel {
    from: NodeModel;
    to: NodeModel;
}

class NodePanel extends Container {
    private events: Events;

    private stage: HTMLElement;
    private edges: SVGSVGElement;
    private empty: HTMLElement;

    // view transform, applied to the stage as a whole
    private tx = PAD;
    private ty = PAD;
    private scale = 1;

    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'node-panel',
            class: 'panel'
        };

        super(args);

        this.events = events;

        // the panel is a viewport onto a larger stage
        this.dom.classList.add('np-viewport');

        this.stage = document.createElement('div');
        this.stage.className = 'np-stage';

        this.edges = document.createElementNS(SVG_NS, 'svg');
        this.edges.classList.add('np-edges');
        this.stage.appendChild(this.edges);

        this.empty = document.createElement('div');
        this.empty.className = 'np-empty';
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
            if ((e.target as HTMLElement).closest('.np-node')) return;
            panning = true;
            startX = e.clientX;
            startY = e.clientY;
            originX = this.tx;
            originY = this.ty;
            this.dom.setPointerCapture(e.pointerId);
            this.dom.classList.add('np-panning');
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
            this.dom.classList.remove('np-panning');
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
            if ((e.target as HTMLElement).closest('.np-node')) return;
            this.tx = PAD;
            this.ty = PAD;
            this.scale = 1;
            this.applyTransform();
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

        ops.forEach((op, i) => {
            const splat = opSplat(op);
            // an op with no object of its own - or whose object is gone - still
            // belongs somewhere; the scene lane is where those collect
            const key = splat && splats.includes(splat) ? splat : null;
            if (key === null && laneOf(null).length === 0) {
                add(null, { index: -1, kind: 'scene', name: '', applied: true, splat: null });
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

        [...this.stage.querySelectorAll('.np-node')].forEach(n => n.remove());
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
            path.setAttribute('class', to.applied ? 'np-edge' : 'np-edge np-pending');
            this.edges.appendChild(path);
        });

        nodes.forEach(node => this.stage.appendChild(this.buildNode(node)));

        this.applyTransform();
    }

    private buildNode(node: NodeModel): HTMLElement {
        const el = document.createElement('div');
        el.className = 'np-node';
        if (!node.applied) el.classList.add('np-pending');
        if (node.index === -1) el.classList.add('np-source');
        // a stored hit set rather than a query that can be turned
        if (node.frozen) el.classList.add('np-frozen');
        el.style.left = `${node.x}px`;
        el.style.top = `${node.y}px`;
        el.style.width = `${NODE_W}px`;
        el.style.height = `${NODE_H}px`;

        const kind = document.createElement('div');
        kind.className = 'np-node-kind';
        kind.textContent = node.kind;
        el.appendChild(kind);

        if (node.name) {
            const name = document.createElement('div');
            name.className = 'np-node-name';
            name.textContent = node.name;
            name.title = node.name;
            el.appendChild(name);
        }

        // an input port only where an edge actually arrives - the first node in
        // a lane is a source
        if (node.x > 0) {
            const inPort = document.createElement('div');
            inPort.className = 'np-port np-port-in';
            el.appendChild(inPort);
        }
        const outPort = document.createElement('div');
        outPort.className = 'np-port np-port-out';
        el.appendChild(outPort);

        if (node.index === -1) {
            el.title = node.splat ? 'select this object' : 'edits not tied to one object';
            if (node.splat) {
                el.addEventListener('click', () => this.events.fire('selection', node.splat));
            }
        } else {
            el.title = node.applied ?
                'undo back to before this step' :
                'redo forward through this step';
            // the cursor sits after the op, so this step is the last applied one
            el.addEventListener('click', () => this.events.fire('edit.goto', node.index + 1));
        }

        return el;
    }
}

export { NodePanel };
