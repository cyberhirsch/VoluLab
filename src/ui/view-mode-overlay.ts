import { Container, Label } from '@playcanvas/pcui';

import { i18n } from './localization';
import { Events } from '../events';
import { SceneCamera } from '../scene-camera';

/**
 * Top-left of the viewport: whether you are flying the free view or
 * looking through a camera, and which one.
 *
 * A viewport that silently changes what it means is disorienting, and
 * with a locked camera the view can drop back to perspective on its own -
 * so the state has to be readable at a glance. Click to switch; P and C
 * do the same from the keyboard.
 */
class ViewModeOverlay extends Container {
    constructor(events: Events) {
        super({
            id: 'view-mode-overlay'
        });

        // the overlay sits over the canvas, so its clicks must not also
        // orbit the camera underneath
        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((name) => {
            this.dom.addEventListener(name, (event: Event) => event.stopPropagation());
        });

        const label = new Label({
            class: 'view-mode-label',
            text: ''
        });
        this.append(label);

        const refresh = () => {
            const mode = events.invoke('camera.viewMode') as string;
            const camera = events.invoke('camera.active') as SceneCamera | null;
            const through = mode === 'camera' && camera;

            label.text = through ?
                `${i18n.t('camera.view-camera')} · ${camera.name}${camera.locked ? ' 🔒' : ''}` :
                i18n.t('camera.view-perspective');

            this.dom.classList.toggle('through-camera', !!through);
            this.dom.classList.toggle('locked', !!(through && camera.locked));
        };

        this.dom.addEventListener('click', () => {
            const mode = events.invoke('camera.viewMode');
            events.fire('camera.setViewMode', mode === 'camera' ? 'perspective' : 'camera');
        });

        events.on('camera.viewMode', refresh);
        events.on('camera.activeChanged', refresh);
        events.on('camera.sceneCameraChanged', refresh);
        events.on('scene.elementAdded', refresh);
        events.on('scene.elementRemoved', refresh);

        // persistent string, so it re-renders when the locale changes
        i18n.bindText(label, () => {
            const mode = events.invoke('camera.viewMode') as string;
            const camera = events.invoke('camera.active') as SceneCamera | null;
            return (mode === 'camera' && camera) ?
                `${i18n.t('camera.view-camera')} · ${camera.name}${camera.locked ? ' 🔒' : ''}` :
                i18n.t('camera.view-perspective');
        });

        refresh();
    }
}

export { ViewModeOverlay };
