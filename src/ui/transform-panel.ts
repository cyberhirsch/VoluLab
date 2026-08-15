import { Container } from '@playcanvas/pcui';

import { Events } from '../events';
import { Transform } from './transform';

/**
 * Position / rotation / scale for the current selection, as its own workspace
 * pane kind. The pane header names it, so there is no internal title row.
 */
class TransformPanel extends Container {
    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'transform-panel',
            class: 'panel'
        };

        super(args);

        // stop pointer events bubbling
        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
            this.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });

        this.append(new Transform(events));
    }
}

export { TransformPanel };
