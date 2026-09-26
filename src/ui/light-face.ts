import { Container } from '@playcanvas/pcui';

import { i18n } from './localization';
import { fieldDefault } from './value-fields';
import { defaultLightSettings, LightKind, LightOp, LightRole, LightSettings } from '../edit-ops';
import { Events } from '../events';
import { loadEnvironment } from '../relight/environment';
import { defaultRelightSettings } from '../relight/relighter';

/**
 * The light node's face, mounted in the node pane like the camera's.
 *
 * Two parts. The light itself - its kind, role, colour, strength, softness
 * and, for a spot, its cone, for an area light its size, for an ambient
 * light its environment, for a volume light the gaussians it came from -
 * edits the node's settings in place; a light has no baked result, so the
 * relighter simply sees the change on its next frame.
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

// An area light's size is its softness, so it has no softness of its own.
// One setting serves as a rectangle's width and a disk's or sphere's size.
const LIGHT_FIELDS: NumberField[] = [
    { key: 'intensity', label: 'light.intensity', step: 0.05, min: 0 },
    { key: 'softness', label: 'light.softness', step: 0.05, min: 0, max: 1, kinds: ['point', 'spot', 'sun'] },
    { key: 'size', label: 'light.width', step: 0.05, min: 0.01, max: 4, kinds: ['rect'] },
    { key: 'height', label: 'light.height', step: 0.05, min: 0.01, max: 4, kinds: ['rect'] },
    { key: 'size', label: 'light.size', step: 0.05, min: 0.01, max: 4, kinds: ['disk', 'sphere'] },
    { key: 'spotAngle', label: 'light.spot-angle', step: 1, min: 1, max: 179, kinds: ['spot'] },
    { key: 'spotBlend', label: 'light.spot-blend', step: 0.05, min: 0, max: 1, kinds: ['spot'] },
    { key: 'rotation', label: 'light.rotation', step: 5, kinds: ['ambient'] }
];

const KINDS: LightKind[] = ['point', 'spot', 'sun', 'rect', 'disk', 'sphere', 'volume', 'ambient'];

const ROLES: LightRole[] = ['add', 'match'];

// an ambient light always adds light: the capture's own sky is what
// de-light's occlusion stands for
const ROLE_KINDS: LightKind[] = ['point', 'spot', 'sun', 'rect', 'disk', 'sphere', 'volume'];

const RESOLUTIONS = [64, 96, 128, 192, 256, 512, 768, 1024];

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
    private roleSelect: HTMLSelectElement;
    private roleRow: HTMLElement;
    private colorInput: HTMLInputElement;
    private inputs = new Map<string, { input: HTMLInputElement, row: HTMLElement, field: NumberField }>();
    private capturedInput: HTMLInputElement;
    private resolutionSelect: HTMLSelectElement;
    private resolutionNotice: HTMLDivElement;
    private rangeInput: HTMLInputElement;
    private strengthInput: HTMLInputElement;
    private delightInput: HTMLInputElement;
    private floorInput: HTMLInputElement;
    private seesDeletedSelect: HTMLSelectElement;
    private unsupported: HTMLDivElement;
    private environmentRow: HTMLElement;
    private environmentControls: HTMLElement;
    private environmentName: HTMLSpanElement;
    private environmentClear: HTMLButtonElement;
    private emittersRow: HTMLElement;
    private emittersControls: HTMLElement;
    private emittersName: HTMLSpanElement;

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

        const select = (values: string[], label: (value: string) => string) => {
            const el = quiet(document.createElement('select')) as HTMLSelectElement;
            values.forEach((value) => {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = i18n.t(label(value));
                el.appendChild(option);
            });
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

        this.kindSelect = select(KINDS, kind => `light.kind-${kind}`);
        this.kindSelect.addEventListener('change', () => {
            if (!this.op) return;
            this.op.settings.kind = this.kindSelect.value as LightKind;
            // select, then operate: a light turned into a volume light with
            // gaussians selected takes them, if it has none of its own yet
            if (this.op.settings.kind === 'volume' && !this.op.settings.emitters?.length) {
                events.invoke('light.useSelection', this.op.output);
            }
            this.readOp();
            this.changed();
        });
        row(lightSection, 'light.kind', this.kindSelect);

        // a light the capture was shot under is matched, not added: placed
        // where it was, it lets de-light divide its shadows back out
        this.roleSelect = select(ROLES, role => `light.role-${role}`);
        this.roleSelect.addEventListener('change', () => {
            if (!this.op) return;
            this.op.settings.role = this.roleSelect.value as LightRole;
            this.changed();
        });
        this.roleRow = row(lightSection, 'light.role', this.roleSelect);

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
            fieldDefault(input, () => defaultLightSettings()[field.key] as number);
            const el = row(lightSection, field.label, input);
            // keyed by label too: one setting may show under two names
            this.inputs.set(`${field.key}:${field.label}`, { input, row: el, field });
        }

        // an ambient light's environment: an HDRI or a photo, reduced on the
        // spot to the small map the light keeps
        this.environmentRow = document.createElement('div');
        this.environmentRow.className = 'tf-field';
        const environmentLabel = document.createElement('span');
        environmentLabel.textContent = i18n.t('light.environment');
        this.environmentRow.appendChild(environmentLabel);
        lightSection.appendChild(this.environmentRow);

        const environmentControls = document.createElement('div');
        environmentControls.className = 'tf-row';
        lightSection.appendChild(environmentControls);
        this.environmentControls = environmentControls;
        this.environmentName = document.createElement('span');
        this.environmentName.className = 'tf-source';
        this.environmentRow.appendChild(this.environmentName);

        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.hdr,.pic,.png,.jpg,.jpeg,.webp';
        fileInput.style.display = 'none';
        fileInput.addEventListener('change', async () => {
            const file = fileInput.files?.[0];
            fileInput.value = '';
            if (!file || !this.op) return;
            const op = this.op;
            try {
                op.settings.environment = await loadEnvironment(file);
            } catch (err) {
                await events.invoke('showPopup', {
                    type: 'error',
                    header: i18n.t('light.environment-failed'),
                    message: `'${(err as Error)?.message ?? err}'`
                });
                return;
            }
            // the node may have changed while the file was read
            if (this.op === op) this.readOp();
            op.output?.changed();
            events.fire('edit.changed');
        });
        environmentControls.appendChild(fileInput);

        const loadButton = document.createElement('button');
        loadButton.className = 'tf-button';
        loadButton.type = 'button';
        loadButton.textContent = i18n.t('light.environment-load');
        loadButton.addEventListener('click', () => fileInput.click());
        environmentControls.appendChild(loadButton);

        this.environmentClear = document.createElement('button');
        this.environmentClear.className = 'tf-button';
        this.environmentClear.type = 'button';
        this.environmentClear.textContent = i18n.t('light.environment-clear');
        this.environmentClear.addEventListener('click', () => {
            if (!this.op) return;
            this.op.settings.environment = null;
            this.readOp();
            this.changed();
        });
        environmentControls.appendChild(this.environmentClear);

        // a volume light's emitters: how many, from which object, and the
        // button that makes them over from whatever is selected now
        this.emittersRow = document.createElement('div');
        this.emittersRow.className = 'tf-field';
        const emittersLabel = document.createElement('span');
        emittersLabel.textContent = i18n.t('light.emitters');
        this.emittersRow.appendChild(emittersLabel);
        this.emittersName = document.createElement('span');
        this.emittersName.className = 'tf-source';
        this.emittersRow.appendChild(this.emittersName);
        lightSection.appendChild(this.emittersRow);

        this.emittersControls = document.createElement('div');
        this.emittersControls.className = 'tf-row';
        lightSection.appendChild(this.emittersControls);
        const useSelection = document.createElement('button');
        useSelection.className = 'tf-button';
        useSelection.type = 'button';
        useSelection.textContent = i18n.t('light.emitters-use');
        useSelection.addEventListener('click', async () => {
            if (!this.op) return;
            if (!events.invoke('light.useSelection', this.op.output)) {
                await events.invoke('showPopup', {
                    type: 'error',
                    header: i18n.t('light.emitters-failed'),
                    message: i18n.t('light.emitters-hint')
                });
                return;
            }
            this.readOp();
            events.fire('edit.changed');
        });
        this.emittersControls.appendChild(useSelection);

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
        fieldDefault(this.capturedInput, defaultRelightSettings().capturedLight);

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

        // a grid finer than the GPU can hold is made as fine as it can hold,
        // and the face says so rather than leave the setting looking obeyed
        this.resolutionNotice = document.createElement('div');
        this.resolutionNotice.className = 'tf-notice';
        this.resolutionNotice.style.display = 'none';
        sceneSection.appendChild(this.resolutionNotice);

        // occlusion shapes ambient light only; it is shared because it is a
        // property of the scene, not of any one light
        const sceneNumber = (label: string, key: string, step: number, min: number, max: number) => {
            const input = quiet(document.createElement('input')) as HTMLInputElement;
            input.type = 'number';
            input.step = String(step);
            input.min = String(min);
            input.max = String(max);
            input.addEventListener('input', () => {
                const value = parseFloat(input.value);
                if (!isFinite(value)) return;
                events.fire('relight.setSettings', { [key]: Math.min(max, Math.max(min, value)) });
                events.fire('edit.changed');
            });
            row(sceneSection, label, input);
            fieldDefault(input, (defaultRelightSettings() as Record<string, any>)[key]);
            return input;
        };
        this.rangeInput = sceneNumber('light.occlusion-range', 'occlusionRange', 0.01, 0.01, 1);
        this.strengthInput = sceneNumber('light.occlusion-strength', 'occlusionStrength', 0.05, 0, 1);

        // de-light: how much of the capture's own light is divided back out,
        // the least it divides by, and whether deleted gaussians still count
        // as part of the capture - a deleted car's baked shadow comes out of
        // the road only if they do, cleaned-up floaters stop counting only if
        // they do not
        this.delightInput = sceneNumber('light.delight', 'delight', 0.05, 0, 1);
        this.floorInput = sceneNumber('light.delight-floor', 'delightFloor', 0.05, 0.02, 1);
        this.seesDeletedSelect = select(['yes', 'no'], answer => `light.${answer}`);
        this.seesDeletedSelect.addEventListener('change', () => {
            events.fire('relight.setSettings', { delightSeesDeleted: this.seesDeletedSelect.value === 'yes' });
            events.fire('edit.changed');
        });
        row(sceneSection, 'light.delight-deleted', this.seesDeletedSelect);

        // another light's face, or a loaded project, can change these
        events.on('relight.settingsChanged', () => this.readScene());
        events.on('relight.resolutionUsed', () => this.readResolutionUsed());
    }

    /** settings -> controls */
    private readOp() {
        const supported = this.events.invoke('relight.supported') !== false;
        (this.unsupported.parentElement as HTMLElement).style.display = supported ? 'none' : '';
        this.unsupported.hidden = supported;
        this.readScene();
        this.readResolutionUsed();
        if (!this.op) return;
        const s = this.op.settings;
        this.kindSelect.value = s.kind;
        this.roleSelect.value = s.role ?? 'add';
        this.colorInput.value = toHex(s.color);
        for (const { input, field } of this.inputs.values()) {
            input.value = String((s as any)[field.key] ?? 0);
        }
        this.environmentName.textContent = s.environment?.name ?? i18n.t('light.environment-none');
        this.environmentClear.disabled = !s.environment;
        const emitters = s.emitters?.length ?? 0;
        this.emittersName.textContent = emitters > 0 ?
            i18n.t('light.emitters-from', { count: emitters, source: s.emitterSource || '?' }) :
            i18n.t('light.emitters-none');
        this.showFields();
    }

    private readScene() {
        const settings = this.events.invoke('relight.settings');
        if (!settings) return;
        this.capturedInput.value = String(settings.capturedLight);
        this.resolutionSelect.value = String(settings.resolution);
        this.rangeInput.value = String(settings.occlusionRange);
        this.strengthInput.value = String(settings.occlusionStrength);
        this.delightInput.value = String(settings.delight);
        this.floorInput.value = String(settings.delightFloor);
        this.seesDeletedSelect.value = settings.delightSeesDeleted ? 'yes' : 'no';
    }

    /** whether the grid came out coarser than asked, because the GPU could not hold it */
    private readResolutionUsed() {
        const settings = this.events.invoke('relight.settings');
        const used = this.events.invoke('relight.resolutionUsed');
        const short = !!settings && typeof used === 'number' && used < settings.resolution;
        this.resolutionNotice.style.display = short ? '' : 'none';
        if (short) {
            this.resolutionNotice.textContent = i18n.t('light.resolution-used', { used });
        }
    }

    /** a spot's cone means nothing to a point light or a sun */
    private showFields() {
        const kind = this.op?.settings.kind ?? 'point';
        for (const { row, field } of this.inputs.values()) {
            // the row's own display rule beats the hidden attribute, so
            // hide it through the style instead
            row.style.display = field.kinds && !field.kinds.includes(kind) ? 'none' : '';
        }
        const ambient = kind === 'ambient' ? '' : 'none';
        this.environmentRow.style.display = ambient;
        this.environmentControls.style.display = ambient;
        const volume = kind === 'volume' ? '' : 'none';
        this.emittersRow.style.display = volume;
        this.emittersControls.style.display = volume;
        this.roleRow.style.display = ROLE_KINDS.includes(kind) ? '' : 'none';
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
