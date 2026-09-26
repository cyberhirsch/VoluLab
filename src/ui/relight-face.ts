import { Container } from '@playcanvas/pcui';

import { i18n } from './localization';
import { fieldDefault } from './value-fields';
import { RelightOp } from '../edit-ops';
import { Events } from '../events';
import { defaultRelightSettings, RelightSettings } from '../relight/relighter';

/**
 * The relight node's face, mounted in the node pane like the light's.
 *
 * Everything that makes an object relit rather than merely lit: how much of
 * its captured light stays, the grid its shadows and occlusion are traced
 * through, and de-light. The settings are the node's own and the object
 * holds them while the node is applied, so an edit here is seen by the
 * relighter on its next frame, with nothing to replay.
 */

type NumberField = {
    key: 'capturedLight' | 'occlusionRange' | 'occlusionStrength' | 'delight' | 'delightFloor';
    label: string;
    step: number;
    min: number;
    max: number;
};

// occlusion shapes ambient light only; de-light divides the capture's own
// light back out
const FIELDS: NumberField[] = [
    { key: 'capturedLight', label: 'light.captured-light', step: 0.05, min: 0, max: 4 },
    { key: 'occlusionRange', label: 'light.occlusion-range', step: 0.01, min: 0.01, max: 1 },
    { key: 'occlusionStrength', label: 'light.occlusion-strength', step: 0.05, min: 0, max: 1 },
    { key: 'delight', label: 'light.delight', step: 0.05, min: 0, max: 1 },
    { key: 'delightFloor', label: 'light.delight-floor', step: 0.05, min: 0.02, max: 1 }
];

const RESOLUTIONS = [64, 96, 128, 192, 256, 512, 768, 1024];

class RelightFace extends Container {
    private events: Events;
    private op: RelightOp | null = null;
    private unsupported: HTMLDivElement;
    private inputs = new Map<NumberField['key'], HTMLInputElement>();
    private resolutionSelect: HTMLSelectElement;
    private resolutionNotice: HTMLDivElement;
    private seesDeletedSelect: HTMLSelectElement;

    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'relight-face'
        };

        super(args);

        this.events = events;

        // the node pane holds elements, not instances - the binding has to
        // travel with the dom
        (this.dom as any).bindNode = (op: RelightOp | null) => {
            this.op = op;
            this.readOp();
        };

        const section = document.createElement('div');
        section.className = 'tf-section';
        const head = document.createElement('div');
        head.className = 'tf-heading';
        head.textContent = i18n.t('relight.group');
        section.appendChild(head);
        this.dom.appendChild(section);

        const note = document.createElement('div');
        note.className = 'tf-stats';
        note.textContent = i18n.t('relight.note');
        section.appendChild(note);

        // a browser without WebGPU still shows the node, and says why it does
        // nothing rather than leaving it to be guessed
        this.unsupported = document.createElement('div');
        this.unsupported.className = 'tf-notice';
        this.unsupported.textContent = i18n.t('light.unsupported');
        this.unsupported.hidden = true;
        section.appendChild(this.unsupported);

        const row = (label: string, control: HTMLElement) => {
            const el = document.createElement('label');
            el.className = 'tf-field';
            const text = document.createElement('span');
            text.textContent = i18n.t(label);
            el.appendChild(text);
            el.appendChild(control);
            section.appendChild(el);
            return el;
        };

        // the graph binds single keys, so typing must not trigger shortcuts
        const quiet = <T extends HTMLElement>(el: T) => {
            el.addEventListener('keydown', e => e.stopPropagation());
            return el;
        };

        const number = (field: NumberField) => {
            const input = quiet(document.createElement('input'));
            input.type = 'number';
            input.step = String(field.step);
            input.min = String(field.min);
            input.max = String(field.max);
            input.addEventListener('input', () => {
                const value = parseFloat(input.value);
                if (!this.op || !isFinite(value)) return;
                this.op.settings[field.key] = Math.min(field.max, Math.max(field.min, value));
                this.changed();
            });
            fieldDefault(input, defaultRelightSettings()[field.key]);
            row(field.label, input);
            this.inputs.set(field.key, input);
        };

        number(FIELDS[0]);

        this.resolutionSelect = quiet(document.createElement('select'));
        RESOLUTIONS.forEach((resolution) => {
            const option = document.createElement('option');
            option.value = String(resolution);
            option.textContent = String(resolution);
            this.resolutionSelect.appendChild(option);
        });
        this.resolutionSelect.addEventListener('change', () => {
            if (!this.op) return;
            this.op.settings.resolution = parseInt(this.resolutionSelect.value, 10);
            this.changed();
        });
        row('light.resolution', this.resolutionSelect);

        // a grid finer than the GPU can hold is made as fine as it can hold,
        // and the face says so rather than leave the setting looking obeyed
        this.resolutionNotice = document.createElement('div');
        this.resolutionNotice.className = 'tf-notice';
        this.resolutionNotice.style.display = 'none';
        section.appendChild(this.resolutionNotice);

        FIELDS.slice(1).forEach(number);

        // whether deleted gaussians still count as part of the capture: a
        // deleted car's baked shadow comes out of the road only if they do,
        // cleaned-up floaters stop counting only if they do not
        this.seesDeletedSelect = quiet(document.createElement('select'));
        ['yes', 'no'].forEach((answer) => {
            const option = document.createElement('option');
            option.value = answer;
            option.textContent = i18n.t(`light.${answer}`);
            this.seesDeletedSelect.appendChild(option);
        });
        this.seesDeletedSelect.addEventListener('change', () => {
            if (!this.op) return;
            this.op.settings.delightSeesDeleted = this.seesDeletedSelect.value === 'yes';
            this.changed();
        });
        row('light.delight-deleted', this.seesDeletedSelect);

        events.on('relight.resolutionUsed', () => this.readResolutionUsed());
    }

    /** settings -> controls */
    private readOp() {
        const supported = this.events.invoke('relight.supported') !== false;
        this.unsupported.hidden = supported;
        const settings: RelightSettings | undefined = this.op?.settings;
        if (!settings) return;
        this.inputs.forEach((input, key) => {
            input.value = String(settings[key]);
        });
        this.resolutionSelect.value = String(settings.resolution);
        this.seesDeletedSelect.value = settings.delightSeesDeleted ? 'yes' : 'no';
        this.readResolutionUsed();
    }

    /** whether the grids came out coarser than asked, because the GPU could not hold them */
    private readResolutionUsed() {
        const op = this.op;
        const used = op ? this.events.invoke('relight.resolutionUsed', op.splat) : null;
        const short = !!op && typeof used === 'number' && used < op.settings.resolution;
        this.resolutionNotice.style.display = short ? '' : 'none';
        if (short) {
            this.resolutionNotice.textContent = i18n.t('light.resolution-used', { used });
        }
    }

    // the relighter sees the settings on its next frame; the graph redraws
    // the node's line, and the document knows it has changed
    private changed() {
        this.events.fire('edit.changed');
    }
}

export { RelightFace };
