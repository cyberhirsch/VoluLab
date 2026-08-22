import { Button, Container, Element, Label } from '@playcanvas/pcui';

import { Events } from '../events';
import { ShortcutManager } from '../shortcut-manager';
import { i18n } from './localization';
import cameraFrameSelectionSvg from './svg/camera-frame-selection.svg';
import centersSvg from './svg/centers.svg';
import flyCameraSvg from './svg/fly-camera.svg';
import orbitCameraSvg from './svg/orbit-camera.svg';
import ringsSvg from './svg/rings.svg';
import selectLockSvg from './svg/select-lock.svg';
import selectUnlockSvg from './svg/select-unlock.svg';
import showHideSplatsSvg from './svg/show-hide-splats.svg';
import { Tooltips } from './tooltips';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

class RightToolbar extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'right-toolbar'
        };

        super(args);

        this.dom.addEventListener('pointerdown', (event) => {
            event.stopPropagation();
        });

        const ringsModeToggle = new Button({
            id: 'right-toolbar-mode-toggle',
            class: 'right-toolbar-toggle'
        });

        const showHideSplats = new Button({
            id: 'right-toolbar-show-hide',
            class: ['right-toolbar-toggle', 'active']
        });

        const orbitMode = new Button({
            id: 'right-toolbar-orbit-mode',
            class: ['right-toolbar-toggle', 'active']
        });

        const flyMode = new Button({
            id: 'right-toolbar-fly-mode',
            class: 'right-toolbar-toggle'
        });

        const cameraFrameSelection = new Button({
            id: 'right-toolbar-frame-selection',
            class: 'right-toolbar-button'
        });

        // The camera lock replaces the old reset button: with P and C
        // switching views, resetting the view is no longer the thing you
        // reach for mid-shot - keeping a framing you like is. Shift+F still
        // resets from the keyboard.
        const cameraLock = new Button({
            id: 'right-toolbar-camera-lock',
            class: 'right-toolbar-toggle'
        });

        const centersDom = createSvg(centersSvg);
        const ringsDom = createSvg(ringsSvg);
        ringsDom.style.display = 'none';

        ringsModeToggle.dom.appendChild(centersDom);
        ringsModeToggle.dom.appendChild(ringsDom);
        showHideSplats.dom.appendChild(createSvg(showHideSplatsSvg));
        orbitMode.dom.appendChild(createSvg(orbitCameraSvg));
        flyMode.dom.appendChild(createSvg(flyCameraSvg));
        cameraFrameSelection.dom.appendChild(createSvg(cameraFrameSelectionSvg));
        const lockedDom = createSvg(selectLockSvg);
        const unlockedDom = createSvg(selectUnlockSvg);
        lockedDom.style.display = 'none';
        cameraLock.dom.appendChild(unlockedDom);
        cameraLock.dom.appendChild(lockedDom);

        this.append(ringsModeToggle);
        this.append(showHideSplats);
        this.append(new Element({ class: 'right-toolbar-separator' }));
        this.append(orbitMode);
        this.append(flyMode);
        this.append(new Element({ class: 'right-toolbar-separator' }));
        this.append(cameraFrameSelection);
        this.append(cameraLock);

        // Helper to compose localized tooltip text with shortcut
        const shortcutManager: ShortcutManager = events.invoke('shortcutManager');
        const tooltip = (localeKey: string, shortcutId?: string) => () => {
            const text = i18n.t(localeKey);
            if (shortcutId) {
                const shortcut = shortcutManager.formatShortcut(shortcutId);
                if (shortcut) {
                    return i18n.formatTooltipWithShortcut(text, shortcut);
                }
            }
            return text;
        };

        tooltips.register(ringsModeToggle, tooltip('tooltip.right-toolbar.splat-mode', 'camera.toggleMode'), 'left');
        tooltips.register(showHideSplats, tooltip('tooltip.right-toolbar.show-hide', 'camera.toggleOverlay'), 'left');
        tooltips.register(orbitMode, tooltip('tooltip.right-toolbar.orbit-camera', 'camera.toggleControlMode'), 'left');
        tooltips.register(flyMode, tooltip('tooltip.right-toolbar.fly-camera', 'camera.toggleControlMode'), 'left');
        tooltips.register(cameraFrameSelection, tooltip('tooltip.right-toolbar.frame-selection', 'camera.focus'), 'left');
        tooltips.register(cameraLock, tooltip('tooltip.right-toolbar.lock-camera'), 'left');

        // add event handlers

        ringsModeToggle.on('click', () => {
            events.fire('camera.toggleMode');
            events.fire('camera.setOverlay', true);
        });
        showHideSplats.on('click', () => events.fire('camera.toggleOverlay'));
        orbitMode.on('click', () => events.fire('camera.setControlMode', 'orbit'));
        flyMode.on('click', () => events.fire('camera.setControlMode', 'fly'));
        cameraFrameSelection.on('click', () => events.fire('camera.focus'));
        cameraLock.on('click', () => events.fire('camera.toggleLock'));

        events.on('camera.mode', (mode: string) => {
            ringsModeToggle.class[mode === 'rings' ? 'add' : 'remove']('active');
            centersDom.style.display = mode === 'rings' ? 'none' : 'block';
            ringsDom.style.display = mode === 'rings' ? 'block' : 'none';
        });

        events.on('camera.overlay', (value: boolean) => {
            showHideSplats.class[value ? 'add' : 'remove']('active');
        });

        const refreshLock = () => {
            const camera = (events.invoke('camera.selected') ?? events.invoke('camera.active')) as { locked: boolean } | null;
            const locked = !!camera?.locked;
            cameraLock.class[locked ? 'add' : 'remove']('active');
            cameraLock.dom.classList.toggle('disabled', !camera);
            lockedDom.style.display = locked ? 'block' : 'none';
            unlockedDom.style.display = locked ? 'none' : 'block';
        };

        events.on('camera.sceneCameraChanged', refreshLock);
        events.on('camera.activeChanged', refreshLock);
        events.on('camera.selectionChanged', refreshLock);
        events.on('scene.elementAdded', refreshLock);
        events.on('scene.elementRemoved', refreshLock);
        refreshLock();

        events.on('camera.controlMode', (mode: 'orbit' | 'fly') => {
            orbitMode.class[mode === 'orbit' ? 'add' : 'remove']('active');
            flyMode.class[mode === 'fly' ? 'add' : 'remove']('active');
        });

    }
}

export { RightToolbar };
