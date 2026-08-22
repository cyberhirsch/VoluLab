import { Container } from '@playcanvas/pcui';

import { i18n } from './localization';
import { CameraOp } from '../edit-ops';
import { Events } from '../events';

/**
 * The camera node's face, mounted in the node pane the way the colour,
 * import and train faces are.
 *
 * Three groups, because they are three different physical things: the
 * exposure of the sensor, the focus of the lens, and the shape of the
 * glass. Editing a field changes the node's settings in place and asks
 * the renderer to catch up - a camera node has no baked result to
 * invalidate, so this is a record change, not a replay.
 */

type Field = {
    key: keyof CameraOp['settings'];
    label: string;
    step: number;
    min?: number;
    max?: number;
};

const GROUPS: { title: string, fields: Field[] }[] = [
    {
        title: 'camera.exposure-group',
        fields: [
            { key: 'exposure', label: 'camera.exposure', step: 0.25 }
        ]
    },
    {
        title: 'camera.dof-group',
        fields: [
            { key: 'aperture', label: 'camera.aperture', step: 0.01, min: 0 },
            { key: 'focusDistance', label: 'camera.focus-distance', step: 0.1, min: 0 },
            { key: 'maxBlur', label: 'camera.max-blur', step: 8, min: 0 }
        ]
    },
    {
        title: 'camera.lens-group',
        fields: [
            { key: 'k1', label: 'camera.distortion', step: 0.02 },
            { key: 'k2', label: 'camera.distortion2', step: 0.02 },
            { key: 'chromatic', label: 'camera.chromatic', step: 0.002 },
            { key: 'vignette', label: 'camera.vignette', step: 0.05, min: 0, max: 1 },
            { key: 'vignetteSoftness', label: 'camera.vignette-softness', step: 0.05, min: 0, max: 2 }
        ]
    }
];

class CameraFace extends Container {
    private events: Events;
    private op: CameraOp | null = null;
    private inputs = new Map<string, HTMLInputElement>();

    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'camera-face'
        };

        super(args);

        this.events = events;

        // the node pane holds elements, not instances - the binding has to
        // travel with the dom
        (this.dom as any).bindNode = (op: CameraOp | null) => {
            this.op = op;
            this.readOp();
        };

        const section = (title: string) => {
            const el = document.createElement('div');
            el.className = 'tf-section';
            if (title) {
                const head = document.createElement('div');
                head.className = 'tf-heading';
                head.textContent = i18n.t(title);
                el.appendChild(head);
            }
            this.dom.appendChild(el);
            return el;
        };

        for (const group of GROUPS) {
            const el = section(group.title);
            for (const field of group.fields) {
                const row = document.createElement('label');
                row.className = 'tf-field';

                const text = document.createElement('span');
                text.textContent = i18n.t(field.label);

                const input = document.createElement('input');
                input.type = 'number';
                input.step = String(field.step);
                if (field.min !== undefined) input.min = String(field.min);
                if (field.max !== undefined) input.max = String(field.max);
                // the graph binds single keys, so typing a number must not
                // also trigger a shortcut
                input.addEventListener('keydown', e => e.stopPropagation());
                input.addEventListener('input', () => this.write(field, input));

                row.appendChild(text);
                row.appendChild(input);
                el.appendChild(row);
                this.inputs.set(field.key, input);
            }
        }

        // focusing by eye is guesswork; focusing on what is selected is not
        const actions = section('');
        const row = document.createElement('div');
        row.className = 'tf-row';
        actions.appendChild(row);

        const focusButton = document.createElement('button');
        focusButton.className = 'tf-button';
        focusButton.type = 'button';
        focusButton.textContent = i18n.t('camera.focus-on-selection');
        focusButton.addEventListener('click', () => this.focusOnSelection());
        row.appendChild(focusButton);
    }

    /** settings -> controls */
    private readOp() {
        if (!this.op) return;
        for (const [key, input] of this.inputs) {
            input.value = String((this.op.settings as any)[key]);
        }
    }

    private write(field: Field, input: HTMLInputElement) {
        if (!this.op) return;
        const value = parseFloat(input.value);
        if (!isFinite(value)) return;

        const clamped = Math.min(field.max ?? Infinity, Math.max(field.min ?? -Infinity, value));
        (this.op.settings as any)[field.key] = clamped;

        // the node holds no baked result, so the renderer is told directly
        // rather than history being replayed
        this.events.fire('camera.effects.refresh');
        this.events.fire('edit.changed');
    }

    /** put the focus plane on whatever is selected, measured from the camera */
    private focusOnSelection() {
        if (!this.op) return;

        const selection = this.events.invoke('selection');
        const bound = selection?.worldBound;
        if (!bound) return;

        const pose = this.events.invoke('camera.getPose');
        if (!pose) return;

        const dx = bound.center.x - pose.position.x;
        const dy = bound.center.y - pose.position.y;
        const dz = bound.center.z - pose.position.z;
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        this.op.settings.focusDistance = Math.round(distance * 1000) / 1000;
        this.readOp();
        this.events.fire('camera.effects.refresh');
        this.events.fire('edit.changed');
    }
}

export { CameraFace };
