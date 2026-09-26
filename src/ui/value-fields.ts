import { Element as PcuiElement, NumericInput, VectorInput } from '@playcanvas/pcui';

/**
 * Every number field in the app, handled the same way from one place:
 *
 * - right click sets it to 0, or as near 0 as it goes;
 * - middle click puts its default back, for a field that was given one;
 * - the wheel steps it, a step a notch;
 * - dragging across it scrubs it, as in Adobe's apps, a step every few
 *   pixels; a click that does not drag selects the number to type over.
 *
 * Shift makes a step ten times as big, Ctrl (or Cmd) a tenth. Alt is left to
 * PCUI: dragging one axis of a VectorInput with it held moves all three. The
 * browser's spin arrows and PCUI's drag handle are hidden - the whole field
 * is the handle now (value-fields.scss).
 *
 * A field is a plain <input type="number"> or a PCUI NumericInput, which
 * SliderInput and VectorInput are built from. The handlers sit on the
 * document, so a field made later - a node's panel, a dialog - is covered
 * without registering. Only its default has to be given, since nothing in
 * the field says what that is.
 *
 * A change reaches a field's listeners as its own change would: a plain
 * input gets 'input' while the number moves and 'change' when it settles, a
 * PCUI one its 'change'. A drag, a burst of wheel notches and a reset are
 * each bracketed by PCUI's 'slider:mousedown' and 'slider:mouseup', which the
 * transform panel already reads as one edit - so each is one undo step.
 */

// a number, or '' to clear a field whose blank means "the default"
type Default = number | '' | (() => number | '');

// what a middle click puts back, by element: a plain input, a PCUI
// component's root, or each axis of a VectorInput
const defaults = new WeakMap<Element, Default>();

// fields no reset may touch
const fixed = new WeakSet<Element>();

// a drag moves one step every this many pixels
const PIXELS_PER_STEP = 4;

// how far the pointer goes before a press is a drag rather than a click
const DRAG_THRESHOLD = 3;

// a wheel event at least this big is one notch of a wheel; smaller ones -
// a trackpad's - add up until they come to as much
const WHEEL_NOTCH = 50;

// wheel notches this close together are one edit
const WHEEL_SETTLE_MS = 400;

type Field = {
    // where a default or an opt-out is looked up from
    root: Element;
    // the text box itself
    input: HTMLInputElement;
    enabled: boolean;
    step: number;
    min: number;
    max: number;
    get: () => number;
    // final: the number has settled - a plain input's 'change'
    set: (value: number | '', final: boolean) => void;
    // the event that started it, for PCUI, which reads Alt off it
    begin: (e: MouseEvent) => void;
    end: () => void;
};

const parse = (text: string, fallback: number) => {
    const v = parseFloat(text);
    return Number.isFinite(v) ? v : fallback;
};

const plainField = (input: HTMLInputElement): Field => {
    const step = parse(input.step, 1);
    return {
        root: input,
        input,
        enabled: !input.disabled && !input.readOnly,
        step: step > 0 ? step : 1,
        min: parse(input.min, -Infinity),
        max: parse(input.max, Infinity),
        get: () => parse(input.value, 0),
        set: (value, final) => {
            input.value = String(value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            if (final) {
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }
        },
        begin: () => {},
        end: () => {}
    };
};

const pcuiField = (ui: NumericInput): Field => ({
    root: ui.dom,
    input: ui.dom.querySelector('input'),
    enabled: ui.enabled && !ui.readOnly,
    step: ui.step > 0 ? ui.step : 1,
    min: ui.min ?? -Infinity,
    max: ui.max ?? Infinity,
    get: () => ui.value ?? 0,
    set: (value) => {
        if (value !== '') {
            ui.value = value;
        }
    },
    begin: e => ui.emit('slider:mousedown', e),
    end: () => ui.emit('slider:mouseup')
});

const fieldAt = (target: EventTarget | null): Field | null => {
    if (!(target instanceof Element)) {
        return null;
    }
    const pcui = target.closest('.pcui-numeric-input') as HTMLElement | null;
    const ui = (pcui as any)?.ui;
    if (ui instanceof NumericInput) {
        return ui.dom.querySelector('input') ? pcuiField(ui) : null;
    }
    const input = target.closest('input[type="number"]');
    return input instanceof HTMLInputElement ? plainField(input) : null;
};

// a SliderInput keeps its default on itself, round its NumericInput
const lookUp = <T>(field: Field, find: (el: Element) => T | undefined) => {
    let el: Element | null = field.root;
    for (let i = 0; el && i < 4; ++i, el = el.parentElement) {
        const found = find(el);
        if (found !== undefined) {
            return found;
        }
    }
    return undefined;
};

const defaultOf = (field: Field): number | '' | undefined => {
    const d = lookUp(field, el => defaults.get(el));
    return typeof d === 'function' ? d() : d;
};

const isFixed = (field: Field) => lookUp(field, el => (fixed.has(el) ? true : undefined)) === true;

const clamp = (value: number, field: Field) => Math.min(field.max, Math.max(field.min, value));

// Shift ten times a step, Ctrl or Cmd a tenth
const increment = (field: Field, e: MouseEvent) => {
    const factor = e.shiftKey ? 10 : (e.ctrlKey || e.metaKey ? 0.1 : 1);
    return +(field.step * factor).toPrecision(6);
};

// to as many decimals as the increment has, so 0.1 + 0.2 shows as 0.3
const tidy = (value: number, inc: number) => {
    const decimals = (String(inc).split('.')[1] ?? '').length;
    return +value.toFixed(Math.min(decimals + 1, 10));
};

// one edit: a reset, bracketed so it is one undo step
const commit = (field: Field, value: number | '', e: MouseEvent) => {
    field.begin(e);
    field.set(value, true);
    field.end();
};

// a run of wheel notches on one field, ended by a pause or another gesture
let wheel: { field: Field, value: number, rest: number, timer: number } | null = null;

const endWheel = () => {
    if (!wheel) {
        return;
    }
    const { field, value, timer } = wheel;
    wheel = null;
    window.clearTimeout(timer);
    field.set(value, true);
    field.end();
};

const onWheel = (e: WheelEvent) => {
    const field = fieldAt(e.target);
    if (!field || !field.enabled) {
        return;
    }
    // the field has it: not the panel's scroll, nor a pane's own zoom
    e.preventDefault();
    e.stopPropagation();

    if (wheel && wheel.field.root !== field.root) {
        endWheel();
    }
    if (!wheel) {
        field.begin(e);
        wheel = { field, value: field.get(), rest: 0, timer: 0 };
    }

    // Shift turns a wheel sideways on some systems
    const delta = (e.deltaY || e.deltaX) * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1);
    let notches = 0;
    if (Math.abs(delta) >= WHEEL_NOTCH) {
        notches = -Math.sign(delta);
        wheel.rest = 0;
    } else {
        wheel.rest += delta;
        if (Math.abs(wheel.rest) >= WHEEL_NOTCH) {
            notches = -Math.sign(wheel.rest);
            wheel.rest = 0;
        }
    }

    if (notches) {
        const inc = increment(field, e);
        wheel.value = clamp(tidy(wheel.value + notches * inc, inc), field);
        field.set(wheel.value, false);
    }

    window.clearTimeout(wheel.timer);
    wheel.timer = window.setTimeout(endWheel, WHEEL_SETTLE_MS);
};

// Press, and either drag to scrub or let go to type. The field is not
// focused on the press - that would start a text selection under the drag -
// so a plain click focuses it and selects the number on release.
const scrub = (field: Field, down: MouseEvent) => {
    const start = field.get();
    let offset = 0;
    let lastX = down.clientX;
    let dragging = false;
    let value = start;

    const move = (e: MouseEvent) => {
        if (!dragging) {
            if (Math.abs(e.clientX - down.clientX) < DRAG_THRESHOLD) {
                return;
            }
            dragging = true;
            field.begin(down);
            document.body.classList.add('value-scrubbing');
        }
        const inc = increment(field, e);
        offset += (e.clientX - lastX) / PIXELS_PER_STEP * inc;
        lastX = e.clientX;
        // held at the ends, so turning back moves it at once
        offset = clamp(start + offset, field) - start;
        const next = clamp(tidy(start + Math.round(offset / inc) * inc, inc), field);
        if (next !== value) {
            value = next;
            field.set(value, false);
        }
    };

    const up = () => {
        window.removeEventListener('mousemove', move, true);
        window.removeEventListener('mouseup', up, true);
        if (dragging) {
            document.body.classList.remove('value-scrubbing');
            field.set(value, true);
            field.end();
        } else {
            field.input.focus();
            field.input.select();
        }
    };

    window.addEventListener('mousemove', move, true);
    window.addEventListener('mouseup', up, true);
};

const onMouseDown = (e: MouseEvent) => {
    const field = fieldAt(e.target);
    if (!field) {
        return;
    }
    // middle: no autoscroll, and no pasting the selection on Linux
    if (e.button === 1) {
        e.preventDefault();
        const d = defaultOf(field);
        if (field.enabled && d !== undefined && !isFixed(field)) {
            endWheel();
            commit(field, d === '' ? '' : clamp(d, field), e);
        }
        return;
    }
    // while the number is being typed, a press places the caret as usual
    if (!field.enabled || document.activeElement === field.input) {
        return;
    }
    e.preventDefault();
    if (e.button === 0) {
        endWheel();
        scrub(field, e);
    }
};

const onContextMenu = (e: MouseEvent) => {
    const field = fieldAt(e.target);
    if (!field) {
        return;
    }
    // no menu over a field, the browser's or a pane's
    e.preventDefault();
    e.stopPropagation();
    if (field.enabled && !isFixed(field)) {
        endWheel();
        commit(field, clamp(0, field), e);
    }
};

// the middle button's release and click paste on some systems
const onMiddleUp = (e: MouseEvent) => {
    if (e.button === 1 && fieldAt(e.target)) {
        e.preventDefault();
    }
};

let installed = false;

/** Turn the gestures on for every number field, now and later. Once, at startup. */
const installValueFields = () => {
    if (installed) {
        return;
    }
    installed = true;
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('mouseup', onMiddleUp, true);
    document.addEventListener('auxclick', onMiddleUp, true);
    document.addEventListener('contextmenu', onContextMenu, true);
    document.addEventListener('wheel', onWheel, { capture: true, passive: false });
};

type FieldLike = HTMLInputElement | PcuiElement;

const rootsOf = (field: FieldLike): Element[] => {
    if (field instanceof HTMLInputElement) {
        return [field];
    }
    if (field instanceof VectorInput) {
        return field.inputs.map(input => input.dom);
    }
    return [field.dom];
};

/**
 * What a middle click puts back in a field: a number, '' for a field whose
 * blank means "the default", or a function giving either when it is asked.
 * A VectorInput takes one per axis.
 */
const fieldDefault = (field: FieldLike, value: Default | Default[]) => {
    rootsOf(field).forEach((root, i) => {
        defaults.set(root, Array.isArray(value) ? value[i] : value);
    });
};

/** A field whose number no reset should reach - a length the scene is scaled to. */
const fieldFixed = (field: FieldLike) => {
    rootsOf(field).forEach(root => fixed.add(root));
};

export { installValueFields, fieldDefault, fieldFixed };
