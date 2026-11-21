/**
 * The layer list: one row per layer node, beside the graph (in its top
 * right corner), with the switches a compositor's layer list has - eye,
 * solo, lock, and the opacity. A switch here is a change to the node, the
 * same as one made in the node pane, so it is undone the same way.
 *
 * Shown only while there are layer nodes. A click on a row's name opens
 * its node in the graph.
 */

import { i18n } from './localization';
import type { LayerOp, LayerSettings } from '../combine-ops';
import { Events } from '../events';

class LayerList {
    dom: HTMLElement;
    private events: Events;
    private list: HTMLElement;
    private collapsed = false;

    constructor(events: Events) {
        this.events = events;
        this.dom = document.createElement('div');
        this.dom.className = 'ly-list';
        this.dom.hidden = true;
        // the graph pans and selects on presses; none of that here
        ['pointerdown', 'wheel', 'dblclick', 'contextmenu', 'keydown'].forEach((type) => {
            this.dom.addEventListener(type, e => e.stopPropagation());
        });

        const header = document.createElement('div');
        header.className = 'ly-header';
        header.textContent = i18n.t('layers.title');
        header.title = i18n.t('layers.toggle');
        header.addEventListener('click', () => {
            this.collapsed = !this.collapsed;
            this.list.hidden = this.collapsed;
        });
        this.dom.appendChild(header);

        this.list = document.createElement('div');
        this.dom.appendChild(this.list);

        let queued = false;
        const update = () => {
            if (queued) return;
            queued = true;
            requestAnimationFrame(() => {
                queued = false;
                this.build();
            });
        };
        events.on('layers.changed', update);
        events.on('edit.changed', update);
    }

    private set(index: number, change: Partial<LayerSettings>) {
        this.events.invoke('layers.set', index, change);
    }

    private button(text: string, on: boolean, title: string, click: () => void) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ly-toggle';
        b.textContent = text;
        b.title = title;
        if (on) b.classList.add('ly-on');
        b.addEventListener('click', click);
        return b;
    }

    private build() {
        const layers = (this.events.invoke('layers.list') ?? []) as { op: LayerOp, index: number }[];
        this.dom.hidden = layers.length === 0;
        this.list.replaceChildren();
        // the newest on top, the way a layer stack reads
        [...layers].reverse().forEach(({ op, index }) => {
            const s = op.settings;
            const row = document.createElement('div');
            row.className = 'ly-row';
            if (op.bypassed) row.classList.add('ly-bypassed');
            if (op.splat?.layerHidden) row.classList.add('ly-hidden');

            row.appendChild(this.button(s.visible ? '●' : '○', s.visible, i18n.t('layers.visible'), () => this.set(index, { visible: !s.visible })));
            row.appendChild(this.button('S', s.solo, i18n.t('layers.solo'), () => this.set(index, { solo: !s.solo })));
            row.appendChild(this.button('L', s.locked, i18n.t('layers.lock'), () => this.set(index, { locked: !s.locked })));

            const name = document.createElement('div');
            name.className = 'ly-name';
            name.textContent = s.name;
            name.title = op.splat?.name ?? '';
            name.addEventListener('click', () => this.events.fire('graph.selectIndex', index));
            row.appendChild(name);

            const opacity = document.createElement('input');
            opacity.type = 'number';
            opacity.className = 'ly-opacity';
            opacity.min = '0';
            opacity.max = '100';
            opacity.step = '5';
            opacity.value = `${Math.round(s.opacity * 100)}`;
            opacity.title = i18n.t('layers.opacity');
            opacity.addEventListener('change', () => {
                const v = parseFloat(opacity.value);
                if (Number.isFinite(v)) this.set(index, { opacity: Math.max(0, Math.min(100, v)) / 100 });
            });
            row.appendChild(opacity);

            this.list.appendChild(row);
        });
    }
}

export { LayerList };
