import { Container } from '@playcanvas/pcui';

import { i18n } from './localization';
import { DebugViewOp } from '../edit-ops';
import { Events } from '../events';
import { Splat } from '../splat';
import { DEBUG_CHANNELS, DEBUG_RAMPS, DebugChannel, DebugLegend, debugChannelAvailable } from '../splat-debug';

/**
 * The debug view node's face, mounted in the node pane like the relight
 * node's.
 *
 * One setting - which channel of its data the object is coloured by - and
 * the legend for it: the ramp the shader draws with and the values at its
 * ends. The node's view is the object's while the node is applied, so a
 * change here is on screen at once, with nothing to replay.
 */

const css = (c: number[]) => `rgb(${c.map(v => Math.round(v * 255)).join(', ')})`;

const gradient = (stops: number[][]) => `linear-gradient(to right, ${stops.map(css).join(', ')})`;

// three figures, or an exponent where that would be a row of zeros
const figure = (v: number) => {
    if (v === 0) return '0';
    const a = Math.abs(v);
    return a >= 10000 || a < 0.001 ? v.toExponential(1) : `${+v.toPrecision(3)}`;
};

class DebugFace extends Container {
    private events: Events;
    private op: DebugViewOp | null = null;
    private channelSelect: HTMLSelectElement;
    private options = new Map<DebugChannel, HTMLOptionElement>();
    private notice: HTMLDivElement;
    private legend: HTMLDivElement;
    private about: HTMLDivElement;

    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'debug-face'
        };

        super(args);

        this.events = events;

        // the node pane holds elements, not instances - the binding has to
        // travel with the dom
        (this.dom as any).bindNode = (op: DebugViewOp | null) => {
            this.op = op;
            this.readOp();
        };

        const section = document.createElement('div');
        section.className = 'tf-section';
        const head = document.createElement('div');
        head.className = 'tf-heading';
        head.textContent = i18n.t('debug.group');
        section.appendChild(head);
        this.dom.appendChild(section);

        const note = document.createElement('div');
        note.className = 'tf-stats';
        note.textContent = i18n.t('debug.note');
        section.appendChild(note);

        const field = document.createElement('label');
        field.className = 'tf-field';
        const text = document.createElement('span');
        text.textContent = i18n.t('debug.channel');
        field.appendChild(text);

        this.channelSelect = document.createElement('select');
        // the graph binds single keys, so typing must not trigger shortcuts
        this.channelSelect.addEventListener('keydown', e => e.stopPropagation());
        DEBUG_CHANNELS.forEach((channel) => {
            const option = document.createElement('option');
            option.value = channel;
            option.textContent = i18n.t(`debug.channel.${channel}`);
            this.channelSelect.appendChild(option);
            this.options.set(channel, option);
        });
        this.channelSelect.addEventListener('change', () => {
            const op = this.op;
            if (!op) return;
            const channel = this.channelSelect.value as DebugChannel;
            const applied = op.splat.debugViews.includes(op.view);
            // A node that showed nothing took no place in the object's colour
            // chain, and one that shows something has one: going from the one
            // to the other is the node applied again where it stands, with
            // what follows it. Otherwise the view is the object's while the
            // node is applied, and a bypassed node keeps the setting for when
            // it is not.
            if (applied && !!op.view.stash !== debugChannelAvailable(op.splat, channel)) {
                const { ops } = this.events.invoke('edit.history') as { ops: unknown[] };
                this.events.invoke('edit.refresh', ops.indexOf(op), () => {
                    op.view.channel = channel;
                });
                return;
            }
            op.view.channel = channel;
            if (applied) {
                op.splat.updateDebugView();
            } else {
                this.readOp();
            }
            // the graph redraws the node's line, and the document knows it has changed
            this.events.fire('edit.changed');
        });
        field.appendChild(this.channelSelect);
        section.appendChild(field);

        this.legend = document.createElement('div');
        section.appendChild(this.legend);

        this.about = document.createElement('div');
        this.about.className = 'tf-stats';
        section.appendChild(this.about);

        // says why nothing is coloured, rather than leaving it to be guessed
        this.notice = document.createElement('div');
        this.notice.className = 'tf-notice';
        this.notice.hidden = true;
        section.appendChild(this.notice);

        // the object worked its view out again: a node came or went, the
        // channel changed, or a 4D model got its motion
        events.on('splat.debugView', (splat: Splat) => {
            if (this.op?.splat === splat) this.readOp();
        });
        // a bypass leaves the object's view as it was when this is not the
        // node shown, so the history is listened to as well
        events.on('edit.changed', () => {
            if (this.op && this.dom.isConnected) this.readOp();
        });
    }

    /** node and object -> controls and legend */
    private readOp() {
        const op = this.op;
        if (!op?.splat) return;
        const { splat, view } = op;

        // a channel the object does not have is not offered - but the one
        // the node is on stays listed, so the select can say what it is
        this.options.forEach((option, channel) => {
            const available = debugChannelAvailable(splat, channel);
            option.disabled = !available;
            option.hidden = !available && channel !== view.channel;
        });
        this.channelSelect.value = view.channel;

        const applied = splat.debugViews.includes(view);
        const last = splat.debugViews[splat.debugViews.length - 1] === view;
        const shown = applied && last ? splat.debugShown : null;

        let why = '';
        if (!applied) {
            why = 'debug.off';
        } else if (!last) {
            why = 'debug.overridden';
        } else if (!shown) {
            why = 'debug.unavailable';
        }
        this.notice.hidden = !why;
        this.notice.textContent = why ? i18n.t(why) : '';

        this.legend.replaceChildren();
        this.about.textContent = '';
        if (shown) {
            this.drawLegend(shown.legend);
            this.about.textContent = i18n.t(`debug.legend.${shown.channel}`);
        }
    }

    private drawLegend(legend: DebugLegend) {
        const bar = (background: string, low: string, high: string, middle = '') => {
            const ramp = document.createElement('div');
            ramp.className = 'df-ramp';
            ramp.style.background = background;
            this.legend.appendChild(ramp);

            const ends = document.createElement('div');
            ends.className = 'df-ends';
            [low, middle, high].forEach((value) => {
                const end = document.createElement('span');
                end.textContent = value;
                ends.appendChild(end);
            });
            this.legend.appendChild(ends);
        };

        if (legend.kind === 'ramp' || legend.kind === 'heat') {
            bar(gradient(DEBUG_RAMPS[legend.kind]), figure(legend.min), figure(legend.max), legend.log ? 'log' : '');
        } else if (legend.kind === 'direction') {
            // one bar per axis: black at rest to the axis' colour at full
            // speed, either way along it
            ['x', 'y', 'z'].forEach((axis, a) => {
                const at = (v: number) => [0, 1, 2].map(c => (c === a ? v : 0));
                bar(gradient([at(0), at(1)]), '0', `\u00b1${figure(legend.max)}`, axis);
            });
        } else if (legend.kind === 'categories') {
            legend.entries.forEach((entry) => {
                const row = document.createElement('div');
                row.className = 'df-entry';
                const chip = document.createElement('div');
                chip.className = 'df-chip';
                chip.style.backgroundColor = css(entry.color);
                row.appendChild(chip);
                const text = document.createElement('span');
                text.textContent = i18n.t(entry.label, { n: entry.value });
                row.appendChild(text);
                this.legend.appendChild(row);
            });
        }
    }
}

export { DebugFace };
