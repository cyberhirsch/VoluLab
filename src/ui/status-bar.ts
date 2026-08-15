import { Container, Label } from '@playcanvas/pcui';

import { Events } from '../events';
import { Splat } from '../splat';
import { i18n } from './localization';
import { Tooltips } from './tooltips';

class StatusBar extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'status-bar'
        };

        super(args);

        // The timeline and splat-data toggles are gone: both are workspace pane
        // kinds now, chosen from a pane's own header dropdown rather than
        // toggled as docked panels from down here.

        // Right section: stats
        const statsContainer = new Container({
            class: 'status-bar-stats'
        });

        const createStat = (labelKey: string) => {
            const container = new Container({
                class: 'status-bar-stat'
            });
            const label = new Label({
                class: 'status-bar-stat-label'
            });
            i18n.bindText(label, labelKey);
            const value = new Label({
                class: 'status-bar-stat-value',
                text: '0'
            });
            container.append(label);
            container.append(value);
            statsContainer.append(container);
            return value;
        };

        const splatsValue = createStat('status-bar.splats');
        const selectedValue = createStat('status-bar.selected');
        const lockedValue = createStat('status-bar.locked');
        const deletedValue = createStat('status-bar.deleted');

        this.append(statsContainer);

        // Update stats from splat state
        let splat: Splat;

        const updateStats = () => {
            if (!splat) return;
            const state = splat.splatData.getProp('state') as Uint8Array;
            if (state) {
                splatsValue.text = i18n.formatInteger(state.length - splat.numDeleted);
                selectedValue.text = i18n.formatInteger(splat.numSelected);
                lockedValue.text = i18n.formatInteger(splat.numLocked);
                deletedValue.text = i18n.formatInteger(splat.numDeleted);
            }
        };

        events.on('splat.stateChanged', (splat_: Splat) => {
            splat = splat_;
            updateStats();
        });

        events.on('selection.changed', (selection: Element) => {
            if (selection instanceof Splat) {
                splat = selection;
                updateStats();
            }
        });
    }
}

export { StatusBar };
