import { Events } from '../events';
import { INTERPS, Interp, Key, Keyed, ParamSpec, evaluate, keyAt, moveKey, paramOf, removeKey, setKey, trackOf } from '../keyframes';
import { i18n } from './localization';

/**
 * The keyframe controls a node pane puts beside a keyable field: a key
 * button, and a curve that opens under the row.
 *
 * The button reads, from dim to bright: not keyed; keyed, no key on this
 * frame; a key on this frame. A click puts a key on this frame with the value
 * the field holds, or takes the one there off; with the parameter keyed, a
 * value typed into the field becomes a key by itself (keyframe-driver.ts).
 * Alt-click takes every key off. The curve button beside it opens the curve.
 *
 * Which curves are open is kept per op and parameter, so the pane can be
 * rebuilt - it is, after every edit - without closing them.
 */

const open = new WeakMap<object, Set<string>>();
const selectedKey = new WeakMap<object, Map<string, Key>>();

const isOpen = (op: object, id: string) => !!open.get(op)?.has(id);
const setOpen = (op: object, id: string, on: boolean) => {
    if (!open.has(op)) open.set(op, new Set());
    const set = open.get(op);
    if (on) set.add(id);
    else set.delete(id);
};

const frameNow = (events: Events): number => events.invoke('keyframes.frame') ?? events.invoke('timeline.frame') ?? 0;

/** Keys changed: the driver shows the frame through them, the pane redraws. */
const changed = (events: Events) => events.fire('edit.changed');

/**
 * A small curve editor: the parameter's value over the timeline, its keys,
 * and the frame shown. Drag a key to move it in time and value; double-click
 * to add a key on the curve; the buttons set how the selected key travels to
 * the next, or delete it.
 */
const curveEditor = (events: Events, op: object, spec: ParamSpec, label: string) => {
    const keyed = op as Keyed;
    const id = spec.id;
    if (!selectedKey.has(op)) selectedKey.set(op, new Map());
    const picks = selectedKey.get(op);

    const box = document.createElement('div');
    box.className = 'kf-editor';

    const title = document.createElement('div');
    title.className = 'kf-title';
    box.appendChild(title);

    const canvas = document.createElement('canvas');
    canvas.className = 'kf-canvas';
    canvas.height = 96;
    box.appendChild(canvas);

    const tools = document.createElement('div');
    tools.className = 'kf-tools';
    box.appendChild(tools);

    const frames = () => Math.max(2, events.invoke('timeline.frames') ?? 2);
    const track = () => trackOf(keyed, id) ?? [];

    // the value axis: the keys' range, widened a little, and never empty
    const range = () => {
        const t = track();
        let lo = Math.min(...t.map(k => k.value));
        let hi = Math.max(...t.map(k => k.value));
        if (!Number.isFinite(lo)) {
            lo = 0;
            hi = 1;
        }
        if (hi - lo < 1e-6) {
            const pad = Math.max(1, Math.abs(hi)) * 0.5;
            lo -= pad;
            hi += pad;
        }
        const pad = (hi - lo) * 0.12;
        return { lo: lo - pad, hi: hi + pad };
    };

    const PAD = 6;
    const toX = (f: number) => PAD + (f / (frames() - 1)) * (canvas.width - 2 * PAD);
    const fromX = (x: number) => ((x - PAD) / (canvas.width - 2 * PAD)) * (frames() - 1);
    const toY = (v: number, r = range()) => canvas.height - PAD - ((v - r.lo) / (r.hi - r.lo)) * (canvas.height - 2 * PAD);
    const fromY = (y: number, r = range()) => r.lo + ((canvas.height - PAD - y) / (canvas.height - 2 * PAD)) * (r.hi - r.lo);

    const css = (name: string, fallback: string) => getComputedStyle(box).getPropertyValue(name).trim() || fallback;

    const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(3));

    let fixed: { lo: number, hi: number } | null = null;

    const draw = () => {
        const width = Math.max(120, Math.round(box.clientWidth || 220));
        if (canvas.width !== width) canvas.width = width;
        const ctx = canvas.getContext('2d');
        const r = fixed ?? range();
        const t = track();
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        ctx.strokeStyle = css('--kf-grid', '#333');
        ctx.lineWidth = 1;
        ctx.beginPath();
        [r.lo + (r.hi - r.lo) * 0.12, r.hi - (r.hi - r.lo) * 0.12].forEach((v) => {
            const y = Math.round(toY(v, r)) + 0.5;
            ctx.moveTo(0, y);
            ctx.lineTo(canvas.width, y);
        });
        ctx.stroke();

        // the frame shown
        const now = frameNow(events);
        ctx.strokeStyle = css('--kf-now', '#888');
        ctx.beginPath();
        ctx.moveTo(Math.round(toX(now)) + 0.5, 0);
        ctx.lineTo(Math.round(toX(now)) + 0.5, canvas.height);
        ctx.stroke();

        if (t.length) {
            ctx.strokeStyle = css('--kf-line', '#ccc');
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            for (let x = 0; x <= canvas.width; x += 2) {
                const v = evaluate(t, fromX(x));
                if (x === 0) ctx.moveTo(x, toY(v, r));
                else ctx.lineTo(x, toY(v, r));
            }
            ctx.stroke();
        }

        const pick = picks.get(id);
        t.forEach((k) => {
            const x = toX(k.frame);
            const y = toY(k.value, r);
            ctx.fillStyle = k === pick ? css('--kf-pick', '#f60') : css('--kf-dot', '#eee');
            ctx.beginPath();
            ctx.moveTo(x, y - 4);
            ctx.lineTo(x + 4, y);
            ctx.lineTo(x, y + 4);
            ctx.lineTo(x - 4, y);
            ctx.closePath();
            ctx.fill();
        });

        title.textContent = pick ?
            `${label}  ${i18n.t('keyframes.frame')} ${+pick.frame.toFixed(2)}  ${fmt(pick.value)}` :
            `${label}  ${fmt(evaluate(t, now))}`;
        tools.querySelectorAll('button').forEach((b: HTMLButtonElement) => {
            const interp = b.dataset.interp;
            if (interp) b.classList.toggle('nd-choice-active', pick?.interp === interp);
            b.disabled = !pick;
        });
    };

    INTERPS.forEach((interp) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'nd-choice';
        b.textContent = i18n.t(`keyframes.${interp}`);
        b.addEventListener('click', () => {
            const k = picks.get(id);
            if (!k) return;
            k.interp = interp;
            draw();
            changed(events);
        });
        b.dataset.interp = interp;
        tools.appendChild(b);
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'nd-choice';
    del.textContent = i18n.t('keyframes.delete');
    del.addEventListener('click', () => {
        const k = picks.get(id);
        if (!k) return;
        removeKey(keyed, id, k.frame);
        picks.delete(id);
        changed(events);
    });
    tools.appendChild(del);

    const hit = (x: number, y: number) => {
        const r = range();
        return track().find(k => Math.abs(toX(k.frame) - x) <= 6 && Math.abs(toY(k.value, r) - y) <= 6) ?? null;
    };

    const local = (e: PointerEvent | MouseEvent) => {
        const rect = canvas.getBoundingClientRect();
        return { x: (e.clientX - rect.left) * (canvas.width / rect.width), y: (e.clientY - rect.top) * (canvas.height / rect.height) };
    };

    let dragging: Key | null = null;
    canvas.addEventListener('pointerdown', (e) => {
        const { x, y } = local(e);
        const k = hit(x, y);
        if (k) picks.set(id, k);
        else picks.delete(id);
        dragging = k;
        // the axis holds still while a key is dragged, or the key runs away
        fixed = k ? range() : null;
        if (k) canvas.setPointerCapture(e.pointerId);
        draw();
    });
    canvas.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const { x, y } = local(e);
        const f = Math.max(0, Math.min(frames() - 1, Math.round(fromX(x))));
        if (f !== dragging.frame) moveKey(keyed, id, dragging, f);
        let v = fromY(y, fixed ?? range());
        if (spec.integer) v = Math.round(v);
        if (spec.min !== undefined) v = Math.max(spec.min, v);
        if (spec.max !== undefined) v = Math.min(spec.max, v);
        dragging.value = v;
        draw();
        // shown as it is dragged; the driver coalesces
        events.invoke('keyframes.drive');
    });
    const end = () => {
        if (!dragging) return;
        dragging = null;
        fixed = null;
        changed(events);
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('dblclick', (e) => {
        const { x } = local(e);
        const f = Math.max(0, Math.min(frames() - 1, Math.round(fromX(x))));
        const t = track();
        const v = t.length ? evaluate(t, f) : spec.get(op);
        picks.set(id, setKey(keyed, id, f, spec.integer ? Math.round(v) : v));
        changed(events);
    });

    requestAnimationFrame(draw);
    return box;
};

/**
 * The key and curve buttons for one parameter of one op, appended to `row`;
 * the curve, when open, goes after the row in `body`. Returns false when the
 * op has no such keyable parameter, and adds nothing.
 */
const addKeyControls = (events: Events, op: object, id: string, row: HTMLElement, body: HTMLElement, label?: string) => {
    const spec = paramOf(op, id);
    if (!spec) return false;
    const keyed = op as Keyed;
    const frame = frameNow(events);
    const track = trackOf(keyed, id);
    const here = keyAt(track, frame);

    const key = document.createElement('button');
    key.type = 'button';
    key.className = `kf-key${track ? ' kf-keyed' : ''}${here ? ' kf-here' : ''}`;
    key.textContent = here ? '◆' : '◇';
    key.title = i18n.t(here ? 'keyframes.remove' : 'keyframes.add');
    key.addEventListener('click', (e) => {
        if (e.altKey) {
            // every key off; the node keeps the value it has now
            delete keyed.keys?.[id];
        } else if (here) {
            removeKey(keyed, id, frame);
        } else {
            setKey(keyed, id, frame, spec.get(op));
        }
        changed(events);
    });
    row.appendChild(key);

    if (track) {
        const curve = document.createElement('button');
        curve.type = 'button';
        curve.className = `kf-curve-toggle${isOpen(op, id) ? ' kf-open' : ''}`;
        curve.textContent = '∿';
        curve.title = i18n.t('keyframes.curve');
        curve.addEventListener('click', () => {
            setOpen(op, id, !isOpen(op, id));
            changed(events);
        });
        row.appendChild(curve);

        if (isOpen(op, id)) {
            // after the row: the row may not be in the body yet
            queueMicrotask(() => {
                const editor = curveEditor(events, op, spec, label ?? spec.label ?? id);
                // several curves of one row go in in the order of its fields
                const anchor: HTMLElement = (row as any).kfAnchor ?? row;
                if (anchor.parentElement === body) anchor.after(editor);
                else body.appendChild(editor);
                (row as any).kfAnchor = editor;
            });
        }
    }
    return true;
};

export { addKeyControls };
