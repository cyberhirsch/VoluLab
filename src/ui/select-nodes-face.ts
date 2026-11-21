import { Color, Mat4, Vec3 } from 'playcanvas';

import { i18n } from './localization';
import { fieldDefault } from './value-fields';
import { EditOp, MultiOp, SelectMode, SelectOp } from '../edit-ops';
import { Events } from '../events';
import { Attribute, AttributeSelectOp, ColourSelectOp, CombineOperation, CombineSelectOp, isSelectionSource, ColourSpace, GrowDirection, GrowSelectOp, MotionMetric, MotionSelectOp, RegionSelectOp, RegionShape, modelFrames, SELECTION_NODE_KINDS, SELECTION_NODE_NAMES, SelectionNodeOp } from '../select-nodes';
import { Splat } from '../splat';

/**
 * The node pane's face for the rule-based select nodes (select-nodes.ts),
 * and their entries in the graph's menus and labels. Kept out of the node
 * pane and the graph panel so those only gain a line each.
 */

const t = (key: string) => i18n.t(key);

/** the graph's title for each kind */
const SELECTION_NODE_LABELS: Record<string, string> = {
    [SELECTION_NODE_NAMES.motion]: 'select by motion',
    [SELECTION_NODE_NAMES.colour]: 'select by colour',
    [SELECTION_NODE_NAMES.region]: 'select by region',
    [SELECTION_NODE_NAMES.attribute]: 'select by attribute',
    [SELECTION_NODE_NAMES.grow]: 'grow / shrink',
    [SELECTION_NODE_NAMES.combine]: 'combine selections'
};

const builtKinds = () => SELECTION_NODE_KINDS;

/** Entries for the menu a wire dragged out of an object's node opens. */
const selectionNodeItems = (events: Events, splat: Splat) => builtKinds().map(kind => ({
    label: SELECTION_NODE_LABELS[SELECTION_NODE_NAMES[kind]],
    action: () => events.fire('graph.addSelectionNode', kind, splat)
}));

/** Entries for the graph's "add" menu, which adds to the selected object. */
const selectionNodeAddItems = (events: Events, splat: Splat | null) => builtKinds().map(kind => ({
    label: `add ${SELECTION_NODE_LABELS[SELECTION_NODE_NAMES[kind]]} node`,
    disabled: !splat,
    hint: splat ? undefined : 'no object',
    action: () => events.fire('graph.addSelectionNode', kind)
}));

// ---------------------------------------------------------------------------
// building blocks, in the node pane's own classes

class Face {
    constructor(public body: HTMLElement, public events: Events, public index: number) {}

    /** change a setting with the replay, never before it (EditHistory.refresh) */
    refresh(mutate: () => void) {
        this.events.invoke('edit.refresh', this.index, mutate);
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
        const row = this.row(label);
        const el = document.createElement('div');
        el.className = 'nd-value';
        el.textContent = value;
        row.appendChild(el);
    }

    note(text: string) {
        const el = document.createElement('div');
        el.className = 'nd-note';
        el.textContent = text;
        this.body.appendChild(el);
        return el;
    }

    choice<T extends string>(label: string, options: [T, string][], current: T, apply: (v: T) => void) {
        const row = this.row(label);
        const choices = document.createElement('div');
        choices.className = 'nd-choices';
        options.forEach(([v, text]) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'nd-choice';
            b.textContent = text;
            if (v === current) b.classList.add('nd-choice-active');
            b.addEventListener('click', () => {
                if (v !== current) this.refresh(() => apply(v));
            });
            choices.appendChild(b);
        });
        row.appendChild(choices);
    }

    /** number fields in a row, one per entry: [value, neutral] */
    numbers(label: string, values: number[], neutral: number, step: number, apply: (v: number[]) => void) {
        const row = this.row(label);
        const fields = values.map((v) => {
            const input = document.createElement('input');
            input.type = 'number';
            input.className = 'nd-num';
            input.step = `${step}`;
            input.value = `${+v.toPrecision(6)}`;
            fieldDefault(input, neutral);
            input.addEventListener('keydown', e => e.stopPropagation());
            input.addEventListener('change', () => {
                const next = fields.map(f => parseFloat(f.value));
                if (next.every(Number.isFinite)) this.refresh(() => apply(next));
            });
            row.appendChild(input);
            return input;
        });
        return fields;
    }

    number(label: string, value: number, neutral: number, step: number, apply: (v: number) => void) {
        return this.numbers(label, [value], neutral, step, v => apply(v[0]))[0];
    }

    text(label: string, value: string, apply: (v: string) => void) {
        const row = this.row(label);
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'nd-text';
        input.value = value;
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') input.blur();
        });
        input.addEventListener('change', () => {
            const v = input.value.trim();
            if (v !== value) this.refresh(() => apply(v));
        });
        row.appendChild(input);
        return input;
    }

    button(text: string, action: () => void, disabled = false) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'nd-action';
        b.textContent = text;
        b.disabled = disabled;
        b.addEventListener('click', action);
        this.body.appendChild(b);
        return b;
    }

    /**
     * A histogram of a per-gaussian measure (NaN: not counted), with the
     * node's range shaded on it. Dragging across it sets the range.
     */
    histogram(values: Float32Array, min: number, max: number, log: boolean, apply: (lo: number, hi: number) => void) {
        const finite: number[] = [];
        for (let i = 0; i < values.length; i += Math.max(1, Math.floor(values.length / 200000))) {
            const v = values[i];
            if (Number.isFinite(v) && (!log || v > 0)) finite.push(v);
        }
        if (!finite.length) return;
        finite.sort((a, b) => a - b);
        const f = (v: number) => (log ? Math.log10(v) : v);
        const inv = (v: number) => (log ? Math.pow(10, v) : v);
        // the ends trimmed, so one stray value does not squash the rest
        let lo = f(finite[Math.floor(finite.length * 0.002)]);
        let hi = f(finite[Math.min(finite.length - 1, Math.floor(finite.length * 0.998))]);
        if (!(hi > lo)) {
            hi = lo + 1;
            lo -= 1;
        }

        const BINS = 64;
        const bins = new Array(BINS).fill(0);
        finite.forEach((v) => {
            const b = Math.floor((f(v) - lo) / (hi - lo) * BINS);
            bins[Math.max(0, Math.min(BINS - 1, b))]++;
        });
        const peak = Math.max(...bins);

        const canvas = document.createElement('canvas');
        canvas.className = 'nd-histogram';
        canvas.width = 256;
        canvas.height = 64;
        canvas.style.width = '100%';
        canvas.style.height = '64px';
        canvas.style.cursor = 'crosshair';
        canvas.style.display = 'block';
        canvas.style.margin = '4px 0';
        const ctx = canvas.getContext('2d');
        const x = (v: number) => (f(v) - lo) / (hi - lo) * canvas.width;

        const draw = (a: number, b: number) => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = 'rgba(255,255,255,0.06)';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            const xa = Math.max(0, Math.min(canvas.width, x(a)));
            const xb = Math.max(0, Math.min(canvas.width, x(b)));
            ctx.fillStyle = 'rgba(255,102,0,0.18)';
            ctx.fillRect(Math.min(xa, xb), 0, Math.abs(xb - xa), canvas.height);
            const w = canvas.width / BINS;
            bins.forEach((count, i) => {
                // square root, so a thin tail still shows next to a peak
                const h = Math.sqrt(count / peak) * (canvas.height - 2);
                const v = inv(lo + (i + 0.5) / BINS * (hi - lo));
                ctx.fillStyle = v >= a && v <= b ? '#f60' : '#888';
                ctx.fillRect(i * w + 0.5, canvas.height - h, w - 1, h);
            });
        };
        draw(min, max);

        let start: number | null = null;
        const at = (e: PointerEvent) => {
            const r = canvas.getBoundingClientRect();
            return inv(lo + (e.clientX - r.left) / r.width * (hi - lo));
        };
        canvas.addEventListener('pointerdown', (e) => {
            start = at(e);
            canvas.setPointerCapture(e.pointerId);
        });
        canvas.addEventListener('pointermove', (e) => {
            if (start === null) return;
            const v = at(e);
            draw(Math.min(start, v), Math.max(start, v));
        });
        canvas.addEventListener('pointerup', (e) => {
            if (start === null) return;
            const v = at(e);
            const a = Math.min(start, v);
            const b = Math.max(start, v);
            start = null;
            if (b > a) this.refresh(() => apply(a, b));
        });

        const legend = document.createElement('div');
        legend.className = 'nd-note';
        legend.textContent = `${+inv(lo).toPrecision(3)} … ${+inv(hi).toPrecision(3)}${log ? ' (log)' : ''}`;
        this.body.appendChild(canvas);
        this.body.appendChild(legend);
    }
}

const MODES: [SelectMode, string][] = [
    ['set', 'set'],
    ['add', 'add'],
    ['remove', 'remove'],
    ['intersect', 'keep']
];

/** what every one of these nodes shows first: its name and how it combines */
const common = (face: Face, op: SelectionNodeOp) => {
    face.text(t('node.selnode.name'), op.label, (v) => {
        op.label = v;
    });
    if (op.kind !== 'combine' && op.kind !== 'grow') {
        face.choice(t('node.selnode.mode'), MODES.map(([m, label]) => [m, t(`node.selnode.mode-${label}`)] as [SelectMode, string]), op.mode, (m) => {
            op.setMode(m);
        });
    }
};

/** and last: what it came to */
const outcome = (face: Face, op: SelectionNodeOp) => {
    face.stat(t('node.selnode.caught'), op.caught < 0 ? t('node.selnode.not-applied') : op.caught.toLocaleString());
    if (op.result) {
        let n = 0;
        op.result.forEach(() => n++);
        face.stat(t('node.selnode.selected'), n.toLocaleString());
    }
    if (op.warning) face.note(t(op.warning));
};

const buildMotion = (face: Face, op: MotionSelectOp) => {
    const splat = op.splat;
    face.choice<MotionMetric>(t('node.selmotion.metric'), [
        ['speed', t('node.selmotion.speed')],
        ['distance', t('node.selmotion.distance')]
    ], op.metric, m => op.setMetric(m));

    const [from, to] = op.range(splat);
    face.numbers(t('node.selmotion.frames'), [from, to], 0, 1, (v) => {
        op.setParam('from', Math.max(0, Math.round(v[0])));
        op.setParam('to', Math.max(0, Math.round(v[1])));
    });
    face.numbers(t('node.selmotion.range'), [op.params.min, op.params.max], 0, 0.001, (v) => {
        op.setParam('min', Math.min(v[0], v[1]));
        op.setParam('max', Math.max(v[0], v[1]));
    });
    if (splat.motion) {
        face.histogram(op.values(splat), op.params.min, op.params.max, true, (a, b) => {
            op.setParam('min', a);
            op.setParam('max', b);
        });
    }
    outcome(face, op);
    face.note(t(op.metric === 'speed' ? 'node.selmotion.note-speed' : 'node.selmotion.note-distance'));
};

const hex = (r: number, g: number, b: number) => `#${[r, g, b].map(v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`;

const buildColour = (face: Face, op: ColourSelectOp) => {
    const row = face.row(t('node.selcolour.colour'));
    const pick = document.createElement('input');
    pick.type = 'color';
    pick.className = 'nd-colour';
    pick.value = hex(op.params.r, op.params.g, op.params.b);
    pick.addEventListener('change', () => {
        const v = pick.value;
        const c = [1, 3, 5].map(i => parseInt(v.slice(i, i + 2), 16) / 255);
        face.refresh(() => {
            op.setParam('r', c[0]);
            op.setParam('g', c[1]);
            op.setParam('b', c[2]);
        });
    });
    row.appendChild(pick);

    // the colour of what the nodes above leave selected: pick a patch with
    // a select node, then take its colour here
    const mean = op.incomingMean;
    face.button(t('node.selcolour.from-selection'), () => {
        face.refresh(() => {
            op.setParam('r', mean[0]);
            op.setParam('g', mean[1]);
            op.setParam('b', mean[2]);
        });
    }, !mean);

    face.choice<ColourSpace>(t('node.selcolour.space'), [
        ['rgb', 'RGB'],
        ['hsv', 'HSV']
    ], op.space, s => op.setSpace(s));

    if (op.space === 'rgb') {
        face.number(t('node.selcolour.tolerance'), op.params.tolerance, 0.2, 0.01, v => op.setParam('tolerance', Math.max(0, v)));
    } else {
        face.number(t('node.selcolour.hue'), op.params.hue, 20, 1, v => op.setParam('hue', Math.max(0, v)));
        face.number(t('node.selcolour.saturation'), op.params.saturation, 0.3, 0.01, v => op.setParam('saturation', Math.max(0, v)));
        face.number(t('node.selcolour.brightness'), op.params.brightness, 0.3, 0.01, v => op.setParam('brightness', Math.max(0, v)));
    }
    outcome(face, op);
    face.note(t('node.selcolour.note'));
};

const lineA = new Vec3();
const lineB = new Vec3();
const regionMat = new Mat4();

// the edges of each unit shape, as pairs of points
const shapeEdges = (shape: RegionShape): number[][] => {
    const e: number[][] = [];
    if (shape === 'box') {
        const c = [-0.5, 0.5];
        c.forEach(a => c.forEach((b) => {
            e.push([-0.5, a, b, 0.5, a, b], [a, -0.5, b, a, 0.5, b], [a, b, -0.5, a, b, 0.5]);
        }));
        return e;
    }
    const ring = (y: number, axis: 'x' | 'y' | 'z') => {
        const S = 48;
        for (let k = 0; k < S; ++k) {
            const a0 = k / S * Math.PI * 2, a1 = (k + 1) / S * Math.PI * 2;
            const p = (a: number) => {
                const u = Math.cos(a) * 0.5, v = Math.sin(a) * 0.5;
                return axis === 'y' ? [u, y, v] : axis === 'x' ? [y, u, v] : [u, v, y];
            };
            e.push([...p(a0), ...p(a1)]);
        }
    };
    if (shape === 'sphere') {
        ring(0, 'x');
        ring(0, 'y');
        ring(0, 'z');
    } else {
        ring(-0.5, 'y');
        ring(0.5, 'y');
        [[0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5]].forEach(([x, z]) => e.push([x, -0.5, z, x, 0.5, z]));
    }
    return e;
};

/**
 * Draw the region in the viewport while its node is open in the pane: at
 * the frame shown, so a keyed region is seen where it is then.
 */
const previewRegion = (face: Face, op: RegionSelectOp) => {
    const scene = op.splat?.scene;
    if (!scene) return;
    const marker = face.body.lastElementChild;
    const edges = shapeEdges(op.shape);
    const colour = new Color(1, 0.4, 0);
    const draw = () => {
        if (!marker?.isConnected || !op.splat) {
            scene.events.off('prerender', draw);
            return;
        }
        const splat = op.splat;
        const frame = splat.motion ? Math.round(splat.motionTime * modelFrames(splat)) : 0;
        op.matrixAt(frame, regionMat);
        edges.forEach((p) => {
            regionMat.transformPoint(lineA.set(p[0], p[1], p[2]), lineA);
            regionMat.transformPoint(lineB.set(p[3], p[4], p[5]), lineB);
            scene.app.drawLine(lineA, lineB, colour, false, scene.worldLayer);
        });
    };
    scene.events.on('prerender', draw);
    scene.forceRender = true;
};

const buildRegion = (face: Face, op: RegionSelectOp) => {
    face.choice<RegionShape>(t('node.selregion.shape'), [
        ['box', t('node.selregion.box')],
        ['sphere', t('node.selregion.sphere')],
        ['cylinder', t('node.selregion.cylinder')]
    ], op.shape, s => op.setShape(s));
    const p = op.params;
    const triple = (label: string, keys: string[], neutral: number, step: number) => {
        face.numbers(label, keys.map(k => p[k]), neutral, step, v => keys.forEach((k, i) => op.setParam(k, v[i])));
    };
    triple(t('node.selregion.position'), ['px', 'py', 'pz'], 0, 0.05);
    triple(t('node.selregion.rotation'), ['rx', 'ry', 'rz'], 0, 1);
    triple(t('node.selregion.size'), ['sx', 'sy', 'sz'], 1, 0.05);
    if (op.splat.motion) {
        const [from, to] = op.range(op.splat);
        face.numbers(t('node.selmotion.frames'), [from, to], 0, 1, (v) => {
            op.setParam('from', Math.max(0, Math.round(v[0])));
            op.setParam('to', Math.max(0, Math.round(v[1])));
        });
    }
    outcome(face, op);
    face.note(t(op.splat.motion ? 'node.selregion.note-4d' : 'node.selregion.note'));
    previewRegion(face, op);
};

const buildAttribute = (face: Face, op: AttributeSelectOp) => {
    const attrs: Attribute[] = ['opacity', 'scale', 'elongation', 'distance', 'density'];
    face.choice<Attribute>(t('node.selattr.attribute'), attrs.map(a => [a, t(`node.selattr.${a}`)] as [Attribute, string]), op.attribute, a => op.setAttribute(a));
    face.numbers(t('node.selmotion.range'), [op.params.min, op.params.max], 0, 0.01, (v) => {
        op.setParam('min', Math.min(v[0], v[1]));
        op.setParam('max', Math.max(v[0], v[1]));
    });
    face.histogram(op.values(op.splat), op.params.min, op.params.max, op.logScale, (a, b) => {
        op.setParam('min', a);
        op.setParam('max', b);
    });
    if (op.attribute === 'distance') {
        face.numbers(t('node.selattr.camera'), [op.params.cx, op.params.cy, op.params.cz], 0, 0.1, (v) => {
            op.setParam('cx', v[0]);
            op.setParam('cy', v[1]);
            op.setParam('cz', v[2]);
        });
        face.button(t('node.selattr.from-view'), () => face.refresh(() => op.takeCamera()));
    }
    if (op.attribute === 'density') {
        face.number(t('node.selattr.cell'), op.cellSize(op.splat), 0, 0.001, v => op.setParam('cell', Math.max(0, v)));
    }
    outcome(face, op);
    face.note(t(`node.selattr.note-${op.attribute}`));
};

const buildGrow = (face: Face, op: GrowSelectOp) => {
    face.choice<GrowDirection>(t('node.selgrow.direction'), [
        ['grow', t('node.selgrow.grow')],
        ['shrink', t('node.selgrow.shrink')]
    ], op.direction, d => op.setDirection(d));
    face.number(t('node.selgrow.radius'), op.params.radius, 0.05, 0.001, v => op.setParam('radius', Math.max(0, v)));
    face.number(t('node.selgrow.steps'), op.params.steps, 1, 1, v => op.setParam('steps', Math.max(1, Math.round(v))));
    if (op.splat.motion) {
        face.number(t('node.selgrow.frames'), op.params.frames, 0, 1, v => op.setParam('frames', Math.max(0, Math.round(v))));
    }
    outcome(face, op);
    face.note(t(op.splat.motion ? 'node.selgrow.note-4d' : 'node.selgrow.note'));
};

const buildCombine = (face: Face, op: CombineSelectOp) => {
    face.choice<CombineOperation>(t('node.selcombine.operation'), [
        ['union', t('node.selcombine.union')],
        ['intersect', t('node.selcombine.intersect')],
        ['difference', t('node.selcombine.difference')],
        ['invert', t('node.selcombine.invert')]
    ], op.operation, o => op.setOperation(o));

    // the select nodes of the object above this one, to pick an input from
    const { ops } = face.events.invoke('edit.history') as { ops: EditOp[] };
    const at = ops.indexOf(op);
    const above = ops.slice(0, Math.max(0, at)).flatMap(o => (o instanceof MultiOp ? o.ops : [o]))
    .filter(o => isSelectionSource(o) && (o as SelectionNodeOp).splat === op.splat) as (SelectOp | SelectionNodeOp)[];
    const nameOf = (s: SelectOp | SelectionNodeOp) => {
        const n = ops.findIndex(o => o === s || (o instanceof MultiOp && o.ops.includes(s)));
        return `${n + 1}: ${s instanceof SelectionNodeOp ? (s.label || s.describe()) : 'select'}`;
    };

    (['a', 'b'] as const).forEach((port) => {
        if (port === 'b' && op.operation === 'invert') return;
        const row = face.row(port);
        const select = document.createElement('select');
        select.className = 'nd-text';
        const none = document.createElement('option');
        none.value = '-1';
        none.textContent = t('node.selcombine.incoming');
        select.appendChild(none);
        above.forEach((s, i) => {
            const o = document.createElement('option');
            o.value = `${i}`;
            o.textContent = nameOf(s);
            if (op[port] === s) o.selected = true;
            select.appendChild(o);
        });
        select.addEventListener('change', () => {
            const i = parseInt(select.value, 10);
            face.refresh(() => op.connect(port, i >= 0 ? above[i] : null));
        });
        row.appendChild(select);
    });
    outcome(face, op);
    face.note(t('node.selcombine.note'));
};

/**
 * Fill the node pane for one of these nodes. False for an op that is not
 * one, so the pane carries on with its own kinds.
 */
const buildSelectionNodeFace = (body: HTMLElement, events: Events, op: unknown, index: number): boolean => {
    if (!(op instanceof SelectionNodeOp)) return false;
    const face = new Face(body, events, index);
    common(face, op);
    if (op instanceof MotionSelectOp) buildMotion(face, op);
    if (op instanceof ColourSelectOp) buildColour(face, op);
    if (op instanceof RegionSelectOp) buildRegion(face, op);
    if (op instanceof AttributeSelectOp) buildAttribute(face, op);
    if (op instanceof GrowSelectOp) buildGrow(face, op);
    if (op instanceof CombineSelectOp) buildCombine(face, op);
    return true;
};

export { SELECTION_NODE_LABELS, selectionNodeItems, selectionNodeAddItems, buildSelectionNodeFace, Face };
