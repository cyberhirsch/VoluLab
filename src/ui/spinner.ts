import { Container, Element } from '@playcanvas/pcui';

/**
 * A slim indeterminate loading bar, docked to the bottom edge of the screen.
 * Unlike the old full-screen spinner, this does not block input or darken
 * the editor - background loads (a file import, a training-pane commit)
 * should not stop the user from doing anything else meanwhile.
 */
class Spinner extends Container {
    constructor(args = {}) {
        args = {
            ...args,
            id: 'spinner-container',
            hidden: true
        };

        super(args);

        const bar = new Element({
            dom: 'div',
            class: 'spinner-bar'
        });

        this.append(bar);
    }
}

export { Spinner };
