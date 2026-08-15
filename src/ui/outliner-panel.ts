import { Container } from '@playcanvas/pcui';

import { Events } from '../events';
import { i18n } from './localization';
import { SplatList } from './splat-list';
import sceneImportSvg from './svg/import.svg';
import sceneNewSvg from './svg/new.svg';
import soloSvg from './svg/solo.svg';
import { Tooltips } from './tooltips';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

/**
 * The scene outliner: the list of splats in the document, with solo, import
 * and new-document actions.
 *
 * This is a workspace pane kind, so it fills whatever pane claims it and the
 * pane header supplies the name. The panel's own header is therefore just a
 * slim action bar - repeating the title here would duplicate the pane's own
 * kind selector.
 */
class OutlinerPanel extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'outliner-panel',
            class: 'panel'
        };

        super(args);

        // stop pointer events bubbling
        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
            this.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });

        const actions = new Container({
            class: 'panel-actions'
        });

        let soloActive = false;

        const soloToggle = new Container({
            class: 'panel-header-button'
        });
        soloToggle.dom.appendChild(createSvg(soloSvg));

        soloToggle.on('click', () => {
            soloActive = !soloActive;
            if (soloActive) {
                soloToggle.class.add('active');
            } else {
                soloToggle.class.remove('active');
            }
            events.fire('scene.solo', soloActive);
        });

        const sceneImport = new Container({
            class: 'panel-header-button'
        });
        sceneImport.dom.appendChild(createSvg(sceneImportSvg));

        const sceneNew = new Container({
            class: 'panel-header-button'
        });
        sceneNew.dom.appendChild(createSvg(sceneNewSvg));

        const spacer = new Container({
            class: 'panel-actions-spacer'
        });

        actions.append(spacer);
        actions.append(soloToggle);
        actions.append(sceneImport);
        actions.append(sceneNew);

        sceneImport.on('click', async () => {
            await events.invoke('scene.import');
        });

        sceneNew.on('click', () => {
            events.invoke('doc.new');
        });

        tooltips.register(soloToggle, () => i18n.t('tooltip.scene.solo'), 'top');
        tooltips.register(sceneImport, () => i18n.t('tooltip.scene.import'), 'top');
        tooltips.register(sceneNew, () => i18n.t('tooltip.scene.new'), 'top');

        const splatList = new SplatList(events);

        const splatListContainer = new Container({
            class: 'splat-list-container'
        });
        splatListContainer.append(splatList);

        this.append(actions);
        this.append(splatListContainer);
    }
}

export { OutlinerPanel };
