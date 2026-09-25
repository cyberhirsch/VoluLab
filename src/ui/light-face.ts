import { Container } from '@playcanvas/pcui';

import { i18n } from './localization';
import { LightKind, LightOp, LightSettings } from '../edit-ops';
import { Events } from '../events';

/**
 * The light node's face, mounted in the node pane like the camera's.
 *
 * Two parts. The light itself - its kind, colour, strength, softness and,
 * for a spot, its cone - edits the node's settings in place; a light has no
 * baked result, so the relighter simply sees the change on its next frame.
 * Below that, the scene's lighting: settings every light shares, shown on
 * each light's face because there is nowhere else a user would look for
 * them.
 */

type NumberField = {
    key: keyof LightSettings;
    label: string;
    step: number;
    min?: number;
    max?: number;
    /** only shown for these kinds */
    kinds?: LightKind[];
};

const LIGHT_FIELDS: NumberField[] = [
    { key: 'intensity', label: 'light.intensity', step: 0.05, min: 0 },
    { key: 'softness', label: 'light.softness', step: 0.05, min: 0, max: 1 },
    { key: 'spotAngle', label: 'light.spot-angle', step: 1, min: 1, max: 179, kinds: ['spot'] },
    { key: 'spotBlend', label: 'light.spot-blend', step: 0.05, min: 0, max: 1, kinds: ['spot'] }
];

const KINDS: LightKind[] = ['point', 'spot', 'sun'];

const RESOLUTIONS = [64, 96, 128, 192, 256];

// the picker speaks hex; the settings keep 0..1 per channel
const toHex = (c: number[]) => `#${c.map(v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
const fromHex = (hex: string): [number, number, number] => {
    const v = parseInt(hex.slice(1), 16);
    return [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255];
};

class LightFace extends Container {
    private events: Events;
    private op: LightOp | null = null;
    private kindSelect: HTMLSelectElement;
    private colorInput: HTMLInputElement;
    private inputs = new Map<string, { input: HTMLInputElement, row: HTMLElement, field: NumberField }>();
    private capturedInput: HTMLInputElement;
    private resolutionSelect: HTMLSelectElement;
    private unsupported: HTMLDivElement;

    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'light-face'
        };

        super(args);

        this.events = events;

        // the node pane holds elements, not instances - the binding has to
        // travel with the dom
        (this.dom as any).bindNode = (op: LightOp | null) => {
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

        const row = (parent: HTMLElement, label: string, control: HTMLElement) => {
            const el = document.createElement('label');
            el.className = 'tf-field';
            const text = document.createElement('span');
            text.textContent = i18n.t(label);
            el.appendChild(text);
            el.appendChild(control);
            parent.appendChild(el);
            return el;
        };

        // the graph binds single keys, so typing must not trigger shortcuts
        const quiet = (el: HTMLElement) => {
            el.addEventListener('keydown', e => e.stopPropagation());
            return el;
        };

        // a browser without WebGPU still shows lights, and says why they do
        // nothing rather than leaving it to be guessed. Decided when a node
        // is bound: this face is built before the device exists
        this.unsupported = document.createElement('div');
        this.unsupported.className = 'tf-notice';
        this.unsupported.textContent = i18n.t('light.unsupported');
        this.unsupported.hidden = true;
        section('').appendChild(this.unsupported);

        const lightSection = section('light.light-group');

        this.kindSelect = quiet(document.createElement('select')) as HTMLSelectElement;
        KINDS.forEach((kind) => {
            const option = document.createElement('option');
            option.value = kind;
            option.textContent = i18n.t(`light.kind-${kind}`);
            this.kindSelect.appendChild(option);
        });
        this.kindSelect.addEventListener('change', () => {
            if (!this.op) return;
            this.op.settings.kind = this.kindSelect.value as LightKind;
            this.showFields();
            this.changed();
        });
        row(lightSection, 'light.kind', this.kindSelect);

        this.colorInput = quiet(document.createElement('input')) as HTMLInputElement;
        this.colorInput.type = 'color';
        this.colorInput.addEventListener('input', () => {
            if (!this.op) return;
            this.op.settings.color = fromHex(this.colorInput.value);
            this.changed();
        });
        row(lightSection, 'light.color', this.colorInput);

        for (const field of LIGHT_FIELDS) {
            const input = quiet(document.createElement('input')) as HTMLInputElement;
            input.type = 'number';
            input.step = String(field.step);
            if (field.min !== undefined) input.min = String(field.min);
            if (field.max !== undefined) input.max = String(field.max);
            input.addEventListener('input', () => this.write(field, input));
            const el = row(lightSection, field.label, input);
            this.inputs.set(field.key, { input, row: el, field });
        }

        // shared by every light
        const sceneSection = section('light.scene-group');

        this.capturedInput = quiet(document.createElement('input')) as HTMLInputElement;
        this.capturedInput.type = 'number';
        this.capturedInput.step = '0.05';
        this.capturedInput.min = '0';
        this.capturedInput.addEventListener('input', () => {
            const value = parseFloat(this.capturedInput.value);
            if (!isFinite(value)) return;
            events.fire('relight.setSettings', { capturedLight: Math.max(0, value) });
            events.fire('edit.changed');
        });
        row(sceneSection, 'light.captured-light', this.capturedInput);

        this.resolutionSelect = quiet(document.createElement('select')) as HTMLSelectElement;
        RESOLUTIONS.forEach((resolution) => {
            const option = document.createElement('option');
            option.value = String(resolution);
            option.textContent = String(resolution);
            this.resolutionSelect.appendChild(option);
        });
        this.resolutionSelect.addEventListener('change', () => {
            events.fire('relight.setSettings', { resolution: parseInt(this.resolutionSelect.value, 10) });
            events.fire('edit.changed');
        });
        row(sceneSection, 'light.resolution', this.resolutionSelect);

        // another light's face, or a loaded project, can change these
        events.on('relight.settingsChanged', () => this.readScene());
    }

    /** settings -> controls */
    private readOp() {
        const supported = this.events.invoke('relight.supported') !== false;
        (this.unsupported.parentElement as HTMLElement).style.display = supported ? 'none' : '';
        this.unsupported.hidden = supported;
        this.readScene();
        if (!this.op) return;
        const s = this.op.settings;
        this.kindSelect.value = s.kind;
        this.colorInput.value = toHex(s.color);
        for (const [key, { input }] of this.inputs) {
            input.value = String((s as any)[key]);
        }
        this.showFields();
    }

    private readScene() {
        const settings = this.events.invoke('relight.settings');
        if (!settings) return;
        this.capturedInput.value = String(settings.capturedLight);
        this.resolutionSelect.value = String(settings.resolution);
    }

    /** a spot's cone means nothing to a point light or a sun */
    private showFields() {
        const kind = this.op?.settings.kind ?? 'point';
        for (const { row, field } of this.inputs.values()) {
            // the row's own display rule beats the hidden attribute, so
            // hide it through the style instead
            row.style.display = field.kinds && !field.kinds.includes(kind) ? 'none' : '';
        }
    }

    private write(field: NumberField, input: HTMLInputElement) {
        if (!this.op) return;
        const value = parseFloat(input.value);
        if (!isFinite(value)) return;
        (this.op.settings as any)[field.key] = Math.min(field.max ?? Infinity, Math.max(field.min ?? -Infinity, value));
        this.changed();
    }

    private changed() {
        this.op?.output?.changed();
        this.events.fire('edit.changed');
    }
}

export { LightFace };
