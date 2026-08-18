import { Container } from '@playcanvas/pcui';

import { EditOp, MultiOp, SelectOp, SelectStep, principalOp } from '../edit-ops';
import { Events } from '../events';
import { describeQuery, isParametric } from '../select-query';
import { Splat } from '../splat';
import { MenuEntry, contributeMenuItems, showContextMenu } from './context-menu';


/**
 * The node graph.
 *
 * A view over the edit history rather than a second store: every node is an
 * entry that already exists in EditHistory. Each loaded object gets an import
 * node and the operations touching it hang off that as a chain, so the graph
 * reads as "what has been done to this thing, in order".
 *
 * Nodes past the history cursor are drawn dimmed - they exist, they are simply
 * not currently applied. A bypassed node is drawn struck through: it is being
 * stepped over, and everything after it has been rebuilt without it.
 *
 * Controls follow what a node editor is expected to do:
 *
 *   drag on empty canvas   marquee select
 *   middle-drag, space+drag, alt+drag   pan
 *   wheel                  zoom at the cursor
 *   drag a node            move it; position is remembered
 *   click / shift-click    select / extend
 *   double-click a node    move the history cursor there
 *   F / A                  frame selection / frame all
 *   M                      bypass
 *   Delete                 remove from history
 *
 * The keys apply while the pane has focus, which a click gives it. Ctrl+A is
 * deliberately left alone: it already selects every gaussian.
 *
 * Free placement is a real position, kept per op, but the layout is only ever
 * a picture of a linear history: there is no rewiring, because the order of
 * the chain is the order the edits happened in.
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
    setSplatColor: 'colour',
    scopedColor: 'colour',
    multiOp: 'combined edit',
    addSplat: 'add object',
    splatRename: 'rename',
    merge: 'merge',
    voxelise: 'voxelise',
    addVoxels: 'import voxels',
    train: 'train',
    crop: 'crop',
    cleanup: 'cleanup',
    decimate: 'decimate',
    setShBands: 'sh bands',
    output: 'output'
};

// A bundled edit is named by the member that does the work, not by the fact
// that it was bundled - "combined edit" tells you nothing about a transform.
const opLabel = (op: EditOp) => {
    const principal = principalOp(op);
    return OP_LABELS[principal.name] ?? OP_LABELS[op.name] ?? op.name;
};

// What a select node shows on its second line: the gesture, or how many of
// them, since a refined selection is one node holding several steps.
const describeSteps = (steps: SelectStep[]) => {
    if (!steps.length) return 'empty';
    if (steps.length === 1) return describeQuery(steps[0].query);
    return `${steps.length} steps`;
};

// Pointer capture throws on an id the element does not hold - a pointer that
// was already released, or one the browser cancelled underneath us. Neither is
// worth losing a drag over, so both directions are advisory.
const capturePointer = (el: Element, pointerId: number) => {
    try {
        el.setPointerCapture(pointerId);
    } catch (e) {
        // carry on without it; events still arrive while the pointer is over us
    }
};

const releasePointer = (el: Element, pointerId: number) => {
    try {
        el.releasePointerCapture(pointerId);
    } catch (e) {
        // already gone
    }
};

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
    bypassed?: boolean;
    /** first in its chain - an import has nothing feeding it */
    isSource?: boolean;
    /** last in its chain by nature - an output writes, it does not pass on */
    terminal?: boolean;
    /** what to key a stored position and a selection against */
    key: object;
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

    /**
     * Selected nodes, keyed by the op (or splat) they stand for rather than by
     * history index, so a selection survives ops being removed ahead of it.
     */
    private selection = new Set<object>();

    /**
     * Where a node has been dragged to. Absent means "wherever the automatic
     * layout puts it", so a graph nobody has arranged still arranges itself.
     * Weak, because the key is the op and history is free to forget it.
     */
    private positions = new WeakMap<object, { x: number, y: number }>();

    /** held while the space bar is down, which turns a drag into a pan */
    private spaceHeld = false;

    private marquee: HTMLElement;

    /** the models behind what is currently drawn, for hit tests and framing */
    private nodes: NodeModel[] = [];
    private currentEdges: EdgeModel[] = [];

    /** a history index asked for before the node existed - see graph.selectIndex */
    private pendingSelect: number | null = null;

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

        this.marquee = document.createElement('div');
        this.marquee.className = 'gn-marquee';
        this.marquee.hidden = true;
        this.stage.appendChild(this.marquee);

        this.empty = document.createElement('div');
        this.empty.className = 'gn-empty';
        this.empty.textContent = 'right-click to add an import node';

        this.dom.appendChild(this.stage);
        this.dom.appendChild(this.empty);

        // the pane takes focus so its keyboard shortcuts reach it, without
        // joining the tab order - it is a canvas, not a form control
        this.dom.tabIndex = -1;
        this.dom.addEventListener('pointerdown', () => this.dom.focus({ preventScroll: true }));

        // the viewport swallows pointer events so panning here doesn't also
        // orbit the camera underneath
        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((name) => {
            this.dom.addEventListener(name, (event: Event) => event.stopPropagation());
        });

        this.bindNavigation();

        const refresh = () => this.rebuild();
        events.on('edit.changed', refresh);

        // Something added a node and wants it open. It may not exist yet - the
        // add is queued - so the request is held and honoured by the first
        // rebuild that can see it.
        events.on('graph.selectIndex', (index: number) => {
            this.pendingSelect = index;
            this.rebuild();
        });
        events.on('scene.elementAdded', refresh);
        events.on('scene.elementRemoved', refresh);
        events.on('splat.name', refresh);

        // The panel is built before main.ts has registered the scene and
        // history accessors it reads, so the first draw waits for the current
        // synchronous startup to finish rather than asking too early.
        queueMicrotask(refresh);
    }

    /** Screen point (client coords) to stage coords. */
    private toStage(clientX: number, clientY: number) {
        const rect = this.dom.getBoundingClientRect();
        return {
            x: (clientX - rect.left - this.tx) / this.scale,
            y: (clientY - rect.top - this.ty) / this.scale
        };
    }

    /**
     * Canvas gestures: a plain drag marquee-selects, a middle drag or a
     * modified drag pans, the wheel zooms at the cursor.
     */
    private bindNavigation() {
        let mode: 'none' | 'pan' | 'marquee' = 'none';
        let startX = 0;
        let startY = 0;
        let originX = 0;
        let originY = 0;
        let anchor = { x: 0, y: 0 };
        let additive = false;

        this.dom.addEventListener('pointerdown', (e: PointerEvent) => {
            // a drag that started on a node is that node's, not the canvas's
            if ((e.target as HTMLElement).closest('.gn-node')) return;
            if (e.button !== 0 && e.button !== 1) return;

            startX = e.clientX;
            startY = e.clientY;
            // middle button, space, or alt all pan - the three habits people
            // arrive with from other node editors
            mode = (e.button === 1 || this.spaceHeld || e.altKey) ? 'pan' : 'marquee';

            if (mode === 'pan') {
                originX = this.tx;
                originY = this.ty;
                this.dom.classList.add('gn-panning');
            } else {
                additive = e.shiftKey || e.ctrlKey;
                if (!additive) this.setSelection([]);
                anchor = this.toStage(e.clientX, e.clientY);
                this.marquee.hidden = false;
                this.layoutMarquee(anchor, anchor);
            }

            capturePointer(this.dom, e.pointerId);
            e.preventDefault();
        });

        this.dom.addEventListener('pointermove', (e: PointerEvent) => {
            if (mode === 'pan') {
                this.tx = originX + (e.clientX - startX);
                this.ty = originY + (e.clientY - startY);
                this.applyTransform();
            } else if (mode === 'marquee') {
                const now = this.toStage(e.clientX, e.clientY);
                this.layoutMarquee(anchor, now);
                this.selectWithin(anchor, now, additive);
            }
        });

        const endDrag = (e: PointerEvent) => {
            if (mode === 'none') return;
            mode = 'none';
            // clean up what is visible first: releasing a capture that is no
            // longer held throws, and a stuck marquee is worse than a warning
            this.dom.classList.remove('gn-panning');
            this.marquee.hidden = true;
            releasePointer(this.dom, e.pointerId);
        };
        this.dom.addEventListener('pointerup', endDrag);
        this.dom.addEventListener('pointercancel', endDrag);

        // space is a held modifier, so it is tracked rather than acted on
        const onKeyUpDown = (down: boolean) => (e: KeyboardEvent) => {
            if (e.code === 'Space') this.spaceHeld = down;
        };
        window.addEventListener('keydown', onKeyUpDown(true));
        window.addEventListener('keyup', onKeyUpDown(false));

        this.dom.addEventListener('keydown', (e: KeyboardEvent) => this.onKeyDown(e));

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
            this.frame(false);
        });

        // right-click on empty canvas: adding, plus a way back to the origin.
        // The event carries on up to the pane, which appends its own items.
        this.dom.addEventListener('contextmenu', (e: MouseEvent) => {
            if ((e.target as HTMLElement).closest('.gn-node')) return;
            this.setSelection([]);
            contributeMenuItems(e, [
                ...this.addItems(),
                'separator',
                { label: 'frame all', hint: 'A', action: () => this.frame(false) },
                { label: 'select all nodes', action: () => this.setSelection(this.nodes.map(n => n.key)) }
            ]);
        });
    }

    private applyTransform() {
        this.stage.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
    }

    private layoutMarquee(a: { x: number, y: number }, b: { x: number, y: number }) {
        this.marquee.style.left = `${Math.min(a.x, b.x)}px`;
        this.marquee.style.top = `${Math.min(a.y, b.y)}px`;
        this.marquee.style.width = `${Math.abs(a.x - b.x)}px`;
        this.marquee.style.height = `${Math.abs(a.y - b.y)}px`;
    }

    /** Anything the marquee touches, not only what it encloses. */
    private selectWithin(a: { x: number, y: number }, b: { x: number, y: number }, additive: boolean) {
        const x0 = Math.min(a.x, b.x);
        const x1 = Math.max(a.x, b.x);
        const y0 = Math.min(a.y, b.y);
        const y1 = Math.max(a.y, b.y);

        const hit = this.nodes.filter(n => n.x < x1 && n.x + NODE_W > x0 && n.y < y1 && n.y + NODE_H > y0);
        this.setSelection(additive ? [...this.selection, ...hit.map(n => n.key)] : hit.map(n => n.key));
    }

    /** Fit the view to everything, or to the selection. */
    private frame(selectionOnly: boolean) {
        const subset = selectionOnly ?
            this.nodes.filter(n => this.selection.has(n.key)) :
            this.nodes;
        const shown = subset.length ? subset : this.nodes;
        if (!shown.length) {
            this.tx = PAD;
            this.ty = PAD;
            this.scale = 1;
            this.applyTransform();
            return;
        }

        const x0 = Math.min(...shown.map(n => n.x));
        const y0 = Math.min(...shown.map(n => n.y));
        const x1 = Math.max(...shown.map(n => n.x + NODE_W));
        const y1 = Math.max(...shown.map(n => n.y + NODE_H));

        const rect = this.dom.getBoundingClientRect();
        const fit = Math.min(
            (rect.width - PAD * 2) / Math.max(1, x1 - x0),
            (rect.height - PAD * 2) / Math.max(1, y1 - y0)
        );
        // only ever zoom out to fit - blowing two nodes up to fill the pane
        // reads as a bug rather than as framing
        this.scale = Math.max(MIN_SCALE, Math.min(1, fit));
        this.tx = (rect.width - (x1 - x0) * this.scale) / 2 - x0 * this.scale;
        this.ty = (rect.height - (y1 - y0) * this.scale) / 2 - y0 * this.scale;
        this.applyTransform();
    }

    private setSelection(keys: object[]) {
        this.selection = new Set(keys);
        this.announce();
        this.rebuild();
    }

    /**
     * Tell the node pane what to show. It edits one thing at a time, so it
     * hears about a single selection and is told to show nothing when there
     * are several. An import node has no history index but does have an
     * object, which is what its settings are.
     */
    private announce() {
        const only = this.selection.size === 1 ?
            this.nodes.find(n => this.selection.has(n.key)) : null;
        this.events.fire('graph.selected', {
            index: only && only.index !== -1 ? only.index : null,
            splat: only?.splat ?? null,
            isImport: !!only && only.index === -1 && !!only.splat
        });
    }

    /** The ops behind the current selection, as history indices. */
    private selectedIndices(): number[] {
        return this.nodes
        .filter(n => this.selection.has(n.key) && n.index !== -1)
        .map(n => n.index)
        .sort((a, b) => a - b);
    }

    private removeSelected() {
        const indices = this.selectedIndices();
        if (!indices.length) return;
        this.setSelection([]);
        this.events.invoke('edit.removeAt', indices);
    }

    private bypassSelected() {
        const nodes = this.nodes.filter(n => this.selection.has(n.key) && n.index !== -1);
        if (!nodes.length) return;
        // one gesture, one outcome: if anything is on, the group goes off
        const turnOff = nodes.some(n => !n.bypassed);
        nodes.forEach(n => this.events.invoke('edit.setBypassed', n.index, turnOff));
    }

    private onKeyDown(e: KeyboardEvent) {
        switch (e.key) {
            case 'Delete':
            case 'Backspace':
                this.removeSelected();
                break;
            case 'm':
            case 'M':
                this.bypassSelected();
                break;
            case 'f':
            case 'F':
                this.frame(true);
                break;
            case 'a':
            case 'A':
                // deliberately not ctrl+A: that already means "select every
                // gaussian" everywhere else in the app, and a pane that
                // redefines it depending on focus is worse than one binding
                if (e.ctrlKey || e.metaKey) return;
                this.frame(false);
                break;
            case 'Escape':
                this.setSelection([]);
                break;
            default:
                return;
        }
        e.preventDefault();
        e.stopPropagation();
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

        // An object produced by a node is not an import - its lane starts at
        // the node that made it, and the inputs to that node are where it came
        // from. Without this a merged object would show a source it never had.
        const produced = new Set<Splat>();
        ops.forEach((op) => {
            const out = (op as any).output as Splat;
            if (out) produced.add(out);
        });

        splats.forEach((splat) => {
            if (produced.has(splat)) return;
            add(splat, {
                index: -1,
                kind: 'import',
                name: splat.name ?? 'object',
                applied: true,
                splat,
                key: splat
            });
        });

        // nodes that consume more than the object they sit on
        const crossLinks: { op: EditOp, node: NodeModel }[] = [];

        ops.forEach((op, i) => {
            const produces = (op as any).output as Splat;
            if (produces) {
                add(produces, {
                    index: i,
                    kind: opLabel(op),
                    // a node fed by something outside the graph (a training
                    // dataset) says what that was; otherwise count its inputs
                    name: (op as any).sourceLabel ?? `${((op as any).inputs?.length ?? 0)} inputs`,
                    applied: i < cursor,
                    splat: produces,
                    bypassed: !!op.bypassed,
                    key: op
                });
                const lane = laneOf(produces);
                crossLinks.push({ op, node: lane[lane.length - 1] });
                return;
            }

            const splat = opSplat(op);
            // an op with no object of its own - or whose object is gone - still
            // belongs somewhere; the scene lane is where those collect
            const key = splat && splats.includes(splat) ? splat : null;
            if (key === null && laneOf(null).length === 0) {
                add(null, { index: -1, kind: 'scene', name: '', applied: true, splat: null, key: lanes });
            }

            // A colour node stands on its own. Consecutive changes are merged
            // into one op before they ever reach here (see edit.addColour), so
            // there is nothing left to fold - and folding would have made a
            // second colour node impossible to see.
            if (op.name === 'setSplatColor' || op.name === 'scopedColor') {
                add(key, {
                    index: i,
                    kind: 'colour',
                    name: op.name === 'scopedColor' ? 'selection' : 'object',
                    applied: i < cursor,
                    splat,
                    colour: true,
                    bypassed: !!op.bypassed,
                    key: op
                });
                return;
            }

            // a selection shows what it selects by, not merely that it selected
            const select = op instanceof SelectOp ? op : null;
            const steps = select?.steps ?? [];
            add(key, {
                index: i,
                kind: select ? 'select' : opLabel(op),
                // a pending producer (a train node before its first run) sits
                // here too, and names its dataset rather than nothing
                name: select ? describeSteps(steps) : ((op as any).sourceLabel ?? ''),
                applied: i < cursor,
                splat,
                select: !!select,
                terminal: op.name === 'output',
                bypassed: !!op.bypassed,
                // frozen only when nothing in it can be re-run
                frozen: steps.length ? steps.every(s => !isParametric(s.query)) : undefined,
                key: op
            });
        });

        const nodes: NodeModel[] = [];
        const edges: EdgeModel[] = [];

        [...lanes.values()].forEach((lane, row) => {
            lane.forEach((node, col) => {
                node.y = row * (NODE_H + LANE_GAP);
                // a node fed from elsewhere is not a source, whatever its column
                node.isSource = col === 0 && !crossLinks.some(l => l.node === node);
                // edges follow the chain, which is the history order, not
                // wherever the node has since been dragged
                if (col > 0) edges.push({ from: lane[col - 1], to: node });

                // a node that has been moved keeps where it was put
                const placed = this.positions.get(node.key);
                if (placed) {
                    node.x = placed.x;
                    node.y = placed.y;
                }
                nodes.push(node);
            });
        });

        // The DAG proper: an edge from the last node of each input's lane into
        // the node that consumes it. The chain edges above say "then"; these
        // say "from", which is the distinction that makes this a graph rather
        // than a set of parallel lists.
        crossLinks.forEach(({ op, node }) => {
            const inputs = ((op as any).inputs ?? []) as Splat[];
            inputs.forEach((input) => {
                const lane = lanes.get(input);
                if (!lane?.length) return;
                edges.push({ from: lane[lane.length - 1], to: node });
            });
        });

        return { nodes, edges };
    }

    private rebuild() {
        const { nodes, edges } = this.build();
        this.nodes = nodes;

        // a selection outlives a rebuild, but not the disappearance of what it
        // pointed at - an op removed from history takes its entry with it
        const live = new Set(nodes.map(n => n.key));
        [...this.selection].forEach(k => !live.has(k) && this.selection.delete(k));

        if (this.pendingSelect !== null) {
            const wanted = nodes.find(n => n.index === this.pendingSelect);
            if (wanted) {
                this.pendingSelect = null;
                // straight to the field: setSelection would rebuild again, and
                // this is already the rebuild that found it
                this.selection = new Set([wanted.key]);
                this.nodes = nodes;
                this.announce();
            }
        }

        [...this.stage.querySelectorAll('.gn-node')].forEach(n => n.remove());
        this.edges.replaceChildren();

        this.empty.hidden = nodes.length > 0;

        this.drawEdges(edges);

        nodes.forEach((node, i) => {
            const el = this.buildNode(node);
            // the array position identifies the element for a drag, which moves
            // nodes without going through a rebuild
            el.dataset.nodeKey = `${i}`;
            this.stage.appendChild(el);
        });

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

        // An input port only where an edge actually arrives. Keyed on the node's
        // place in its chain rather than on where it sits, or dragging a node
        // rightwards would grow it an input it has nothing to receive on.
        if (!node.isSource) {
            const inPort = document.createElement('div');
            inPort.className = 'gn-port gn-port-in';
            el.appendChild(inPort);
        }

        // an output writes a file; nothing hangs off the far side of it
        if (!node.terminal) {
            const outPort = document.createElement('div');
            outPort.className = 'gn-port gn-port-out';
            outPort.title = 'drag out to attach a node';
            this.bindPortDrag(outPort, node);
            el.appendChild(outPort);
        }

        if (this.selection.has(node.key)) el.classList.add('gn-selected');
        if (node.bypassed) el.classList.add('gn-bypassed');

        // Click selects - that is what puts a node's parameters in the node
        // pane. Moving the history cursor is the heavier action, so it takes
        // the deliberate gesture rather than the casual one.
        el.title = node.index === -1 ?
            (node.splat ? 'click to select this object' : 'edits not tied to one object') :
            'click to edit · double-click to move the history here';

        this.bindNodeDrag(el, node);

        if (node.index !== -1) {
            el.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                // the cursor sits after the op, so this step is the last applied
                this.events.fire('edit.goto', node.index + 1);
            });
        }

        el.addEventListener('contextmenu', (e) => {
            if (!this.selection.has(node.key)) this.setSelection([node.key]);
            const many = this.selection.size > 1;
            contributeMenuItems(e, [
                ...this.addItems(),
                'separator',
                {
                    label: node.bypassed ? 'enable' : 'bypass',
                    hint: 'M',
                    disabled: node.index === -1,
                    action: () => this.bypassSelected()
                },
                {
                    label: many ? `remove ${this.selection.size} nodes` : 'remove node',
                    hint: 'Del',
                    disabled: node.index === -1,
                    action: () => this.removeSelected()
                },
                {
                    label: 'move history here',
                    disabled: node.index === -1 || many,
                    action: () => this.events.fire('edit.goto', node.index + 1)
                }
            ]);
        });

        return el;
    }

    /**
     * Drag out of an output port to attach something.
     *
     * A link is drawn to the pointer while dragging, and letting go offers the
     * nodes that can act on this object. The chain is linear, so "connecting"
     * means appending to that object's chain - there is nowhere else a new node
     * could go, and no second input to choose between.
     */
    private bindPortDrag(port: HTMLElement, node: NodeModel) {
        port.addEventListener('pointerdown', (e: PointerEvent) => {
            if (e.button !== 0) return;
            // the node's own drag handler must not also claim this press
            e.stopPropagation();
            e.preventDefault();

            const from = { x: node.x + NODE_W, y: node.y + NODE_H / 2 };
            const link = document.createElementNS(SVG_NS, 'path');
            link.setAttribute('class', 'gn-link');
            this.edges.appendChild(link);

            const draw = (to: { x: number, y: number }) => {
                const bend = Math.max(24, Math.abs(to.x - from.x) * 0.5);
                link.setAttribute('d', `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`);
            };
            draw(from);

            const move = (ev: PointerEvent) => draw(this.toStage(ev.clientX, ev.clientY));

            const up = (ev: PointerEvent) => {
                port.removeEventListener('pointermove', move);
                port.removeEventListener('pointerup', up);
                releasePointer(port, ev.pointerId);
                link.remove();

                const splat = node.splat;
                const items: MenuEntry[] = splat ? [
                    {
                        label: 'select',
                        action: () => this.events.fire('graph.addSelectNode', splat)
                    },
                    {
                        label: 'colour',
                        action: () => this.events.fire('graph.addColourNode', splat)
                    },
                    {
                        label: 'crop',
                        action: () => this.events.fire('graph.addCropNode', splat)
                    },
                    {
                        label: 'cleanup',
                        action: () => this.events.fire('graph.addCleanupNode', splat)
                    },
                    {
                        label: 'decimate',
                        action: () => this.events.fire('graph.addDecimateNode', splat)
                    },
                    {
                        label: 'sh bands',
                        action: () => this.events.fire('graph.addShBandsNode', splat)
                    },
                    {
                        label: 'voxelise',
                        action: () => this.events.invoke('graph.voxelise', splat)
                    },
                    {
                        label: 'output',
                        action: () => this.events.fire('graph.addOutputNode', splat)
                    }
                ] : [
                    { label: 'nothing attaches here', disabled: true, action: () => {} }
                ];
                showContextMenu(document, ev.clientX, ev.clientY, items);
            };

            port.addEventListener('pointermove', move);
            port.addEventListener('pointerup', up);
            capturePointer(port, e.pointerId);
        });
    }

    /**
     * Drag to move, click to select.
     *
     * The two share a gesture, so a press only becomes a move once the pointer
     * has travelled far enough that it cannot have been meant as a click.
     */
    private bindNodeDrag(el: HTMLElement, node: NodeModel) {
        const THRESHOLD = 3;

        el.addEventListener('pointerdown', (e: PointerEvent) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            el.focus?.();

            const startX = e.clientX;
            const startY = e.clientY;
            const extend = e.shiftKey || e.ctrlKey;

            // pressing an unselected node selects it, so a drag moves what you
            // pressed. Pressing one already in the selection leaves the group
            // alone, so a drag can move several at once.
            if (!this.selection.has(node.key)) {
                this.setSelection(extend ? [...this.selection, node.key] : [node.key]);
            } else if (extend) {
                this.setSelection([...this.selection].filter(k => k !== node.key));
                return;
            }

            const moving = this.nodes.filter(n => this.selection.has(n.key));
            const origins = moving.map(n => ({ node: n, x: n.x, y: n.y }));
            let dragging = false;

            const move = (ev: PointerEvent) => {
                const dx = (ev.clientX - startX) / this.scale;
                const dy = (ev.clientY - startY) / this.scale;
                if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) < THRESHOLD) return;
                dragging = true;

                origins.forEach(({ node: n, x, y }) => {
                    n.x = x + dx;
                    n.y = y + dy;
                    this.positions.set(n.key, { x: n.x, y: n.y });
                });
                // move the drawn nodes directly rather than rebuilding, so a
                // drag stays smooth; the edges are redrawn to follow
                this.repositionDrawn();
            };

            const up = (ev: PointerEvent) => {
                el.removeEventListener('pointermove', move);
                el.removeEventListener('pointerup', up);
                releasePointer(el, ev.pointerId);
                if (dragging) return;

                // A press on a node already in the selection kept the group, so
                // a drag could move all of it. Releasing without having dragged
                // means it was a click after all, which picks out just this one.
                if (!extend && this.selection.size > 1) this.setSelection([node.key]);
                if (node.splat) this.events.fire('selection', node.splat);
            };

            // listeners before the capture: capturing can fail, and a drag that
            // never listens is worse than a drag that leaves the element
            el.addEventListener('pointermove', move);
            el.addEventListener('pointerup', up);
            capturePointer(el, e.pointerId);
        });
    }

    /** Push current model positions into the DOM without a full rebuild. */
    private repositionDrawn() {
        [...this.stage.querySelectorAll('.gn-node')].forEach((el) => {
            const n = this.nodes[Number((el as HTMLElement).dataset.nodeKey)];
            if (!n) return;
            (el as HTMLElement).style.left = `${n.x}px`;
            (el as HTMLElement).style.top = `${n.y}px`;
        });
        this.drawEdges(this.currentEdges);
    }

    /** Redraw the connecting curves from the models' current positions. */
    private drawEdges(edges: EdgeModel[]) {
        this.currentEdges = edges;
        this.edges.replaceChildren();

        const width = Math.max(...this.nodes.map(n => n.x + NODE_W), 0) + PAD;
        const height = Math.max(...this.nodes.map(n => n.y + NODE_H), 0) + PAD;
        this.edges.setAttribute('width', `${width}`);
        this.edges.setAttribute('height', `${height}`);
        this.edges.setAttribute('viewBox', `0 0 ${width} ${height}`);

        edges.forEach(({ from, to }) => {
            const x1 = from.x + NODE_W;
            const y1 = from.y + NODE_H / 2;
            const x2 = to.x;
            const y2 = to.y + NODE_H / 2;
            // the bend keeps a backwards edge from cutting straight through the
            // node it comes out of, once things have been dragged around
            const bend = Math.max(24, Math.abs(x2 - x1) * 0.5);

            const path = document.createElementNS(SVG_NS, 'path');
            path.setAttribute('d', `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`);
            const classes = ['gn-edge'];
            if (!to.applied) classes.push('gn-pending');
            if (to.bypassed || from.bypassed) classes.push('gn-edge-bypassed');
            path.setAttribute('class', classes.join(' '));
            this.edges.appendChild(path);
        });
    }

    /**
     * Merging needs a second object, and there is no wire to drop on yet - so
     * the other objects are offered by name. One entry each rather than a
     * submenu, because a scene with enough objects to need one is not the case
     * this is for.
     */
    private mergeItems(splat: Splat | null): MenuEntry[] {
        if (!splat) return [];
        const others = ((this.events.invoke('scene.allSplats') ?? []) as Splat[])
        .filter(s => s !== splat && s.visible);
        if (!others.length) return [];

        return [
            'separator',
            ...others.map(other => ({
                label: `merge with ${other.name ?? 'object'}`,
                action: () => {
                    this.events.invoke('graph.merge', splat, other);
                }
            }))
        ];
    }

    /** The "add" half of the graph's context menu, shared by node and canvas. */
    private addItems(): MenuEntry[] {
        const splat = this.events.invoke('selection') as Splat;
        return [
            {
                // an import node is a loaded object, so adding one is the load.
                // Always available - it is how the graph gets its first object,
                // and everything else needs one to hang off.
                label: 'add import node',
                action: () => this.events.invoke('scene.import')
            },
            {
                // folder mode: dataset folders, photo sets and file piles alike
                label: 'add import node (folder)',
                action: () => this.events.invoke('scene.importFolder')
            },
            {
                // training is the other way an object enters the graph: the
                // node arrives pending, and its face in the node pane runs it
                label: 'add training node',
                action: () => this.events.invoke('training.addNode')
            },
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
            },
            {
                label: 'add crop node',
                disabled: !splat,
                hint: splat ? undefined : 'no object',
                action: () => this.events.fire('graph.addCropNode')
            },
            {
                label: 'add cleanup node',
                disabled: !splat,
                hint: splat ? undefined : 'no object',
                action: () => this.events.fire('graph.addCleanupNode')
            },
            {
                label: 'add decimate node',
                disabled: !splat,
                hint: splat ? undefined : 'no object',
                action: () => this.events.fire('graph.addDecimateNode')
            },
            {
                label: 'add sh bands node',
                disabled: !splat,
                hint: splat ? undefined : 'no object',
                action: () => this.events.fire('graph.addShBandsNode')
            },
            {
                label: 'add output node',
                disabled: !splat,
                hint: splat ? undefined : 'no object',
                action: () => this.events.fire('graph.addOutputNode')
            },
            {
                label: 'add voxelise node',
                disabled: !splat,
                hint: splat ? undefined : 'no object',
                action: () => this.events.invoke('graph.voxelise')
            },
            ...this.mergeItems(splat)
        ];
    }
}

export { GraphPanel };
