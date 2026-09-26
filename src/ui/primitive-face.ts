import { Container } from '@playcanvas/pcui';

import { i18n } from './localization';
import { fieldDefault } from './value-fields';
import { PrimitiveOp, PrimitivePoseOp } from '../edit-ops';
import { Events } from '../events';
import { PRIMITIVE_KINDS, PrimitiveKind, PrimitivePose, ScenePrimitive } from '../scene-primitive';

/**
 * The primitive node's face, mounted in the node pane like the light's.
 *
 * Its shape, and its size along each of its own axes. Where it sits and how
 * it is turned are the transform pane's, as they are for an object: the
 * primitive is selected with its node, and the gizmo moves it.
 *
 * A size moves the shape live while it is typed or dragged, and becomes one
 * undo step when it settles - the same step a scale with the gizmo makes.
 */

const AXES: { key: 'x' | 'y' | 'z', label: string }[] = [
    { key: 'x', label: 'primitive.width' },
    { key: 'y', label: 'primitive.height' },
    { key: 'z', label: 'primitive.depth' }
];

class PrimitiveFace extends Container {
    private events: Events;
    private op: PrimitiveOp | null = null;
    private kindSelect: HTMLSelectElement;
    private sizes = new Map<'x' | 'y' | 'z', HTMLInputElement>();
    // the pose the last undo step left, which the next one starts from
    private settled: PrimitivePose | null = null;
    // set while this face moves the primitive, so it does not write the
    // number being typed back over itself
    private applying = false;

    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'primitive-face'
        };

        super(args);

        this.events = events;

        // the node pane holds elements, not instances - the binding has to
        // travel with the dom
        (this.dom as any).bindNode = (op: PrimitiveOp | null) => {
            this.op = op;
            this.readOp();
        };

        const section = document.createElement('div');
        section.className = 'tf-section';
        const head = document.createElement('div');
        head.className = 'tf-heading';
        head.textContent = i18n.t('primitive.group');
        section.appendChild(head);
        this.dom.appendChild(section);

        const row = (label: string, control: HTMLElement) => {
            const el = document.createElement('label');
            el.className = 'tf-field';
            const text = document.createElement('span');
            text.textContent = i18n.t(label);
            el.appendChild(text);
            el.appendChild(control);
            section.appendChild(el);
        };

        // the graph binds single keys, so typing must not trigger shortcuts
        const quiet = <T extends HTMLElement>(el: T) => {
            el.addEventListener('keydown', e => e.stopPropagation());
            return el;
        };

        this.kindSelect = quiet(document.createElement('select'));
        PRIMITIVE_KINDS.forEach((kind) => {
            const option = document.createElement('option');
            option.value = kind;
            option.textContent = i18n.t(`primitive.${kind}`);
            this.kindSelect.appendChild(option);
        });
        this.kindSelect.addEventListener('change', () => {
            const primitive = this.primitive;
            if (!primitive) return;
            primitive.kind = this.kindSelect.value as PrimitiveKind;
            primitive.changed();
            this.events.fire('edit.changed');
        });
        row('primitive.kind', this.kindSelect);

        AXES.forEach(({ key, label }) => {
            const input = quiet(document.createElement('input'));
            input.type = 'number';
            input.step = '0.01';
            input.min = '0.001';
            input.addEventListener('input', () => {
                const primitive = this.primitive;
                const value = parseFloat(input.value);
                if (!primitive || !isFinite(value) || value <= 0) return;
                const pose = primitive.getPose();
                pose.size[key] = value;
                this.applying = true;
                primitive.live = true;
                primitive.setPose(pose);
                this.applying = false;
            });
            input.addEventListener('change', () => this.settle());
            // a middle click gives back the size it was made at
            fieldDefault(input, () => this.primitive?.madeSize[key] ?? 1);
            row(label, input);
            this.sizes.set(key, input);
        });

        // the gizmo, undo and redo move it too
        events.on('primitive.moved', (primitive: ScenePrimitive) => {
            if (primitive !== this.primitive || this.applying) return;
            this.readOp();
        });
    }

    private get primitive() {
        return this.op?.output ?? null;
    }

    /** the size settled: one undo step from where the last one left it */
    private settle() {
        const primitive = this.primitive;
        if (!primitive || !this.settled) return;
        primitive.live = false;
        const now = primitive.getPose();
        if (!now.size.equals(this.settled.size)) {
            // already applied, so the op's do() is suppressed
            this.events.fire('edit.add', new PrimitivePoseOp(primitive, this.settled, now), true);
        }
        this.settled = now;
    }

    /** the primitive -> the controls */
    private readOp() {
        const primitive = this.primitive;
        if (!primitive) return;
        this.kindSelect.value = primitive.kind;
        this.sizes.forEach((input, key) => {
            input.value = String(+primitive.size[key].toFixed(4));
        });
        this.settled = primitive.getPose();
    }
}

export { PrimitiveFace };
