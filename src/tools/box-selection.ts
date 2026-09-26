import { Button, Container, Element, Label, VectorInput } from '@playcanvas/pcui';
import { Vec3 } from 'playcanvas';

import { PrimitiveToolShape } from './primitive-tool-shape';
import { ShapeGizmoMode, ShapeTransformGizmo } from './shape-transform-gizmo';
import { Events } from '../events';
import { Scene } from '../scene';
import { ScenePrimitive } from '../scene-primitive';
import { ShortcutManager } from '../shortcut-manager';
import { Splat } from '../splat';
import { i18n } from '../ui/localization';
import addSvg from '../ui/svg/select-add.svg';
import intersectSvg from '../ui/svg/select-intersect.svg';
import removeSvg from '../ui/svg/select-remove.svg';
import setSvg from '../ui/svg/select-set.svg';
import { Tooltips } from '../ui/tooltips';
import { fieldDefault } from '../ui/value-fields';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

/**
 * Select what is inside a box: a box primitive, wired into the select node
 * as its mesh input, so moving the box later selects again. See
 * PrimitiveToolShape.
 */
class BoxSelection {
    activate: () => void;
    deactivate: () => void;
    setTransformMode: (mode: Exclude<ShapeGizmoMode, 'none'>) => boolean;

    active = false;

    constructor(events: Events, scene: Scene, canvasContainer: Container, tooltips: Tooltips) {
        const shape = new PrimitiveToolShape(events, scene, 'box');
        const euler = new Vec3();

        // ui
        const selectToolbar = new Container({
            class: 'select-toolbar',
            hidden: true
        });

        selectToolbar.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
        });

        const translateButton = new Button({ class: 'select-toolbar-mode', icon: 'E111' });
        const rotateButton = new Button({ class: 'select-toolbar-mode', icon: 'E113' });
        const scaleButton = new Button({ class: 'select-toolbar-mode', icon: 'E112' });

        const setButton = new Button({ class: 'select-toolbar-op' });
        const addButton = new Button({ class: 'select-toolbar-op' });
        const removeButton = new Button({ class: 'select-toolbar-op' });
        const intersectButton = new Button({ class: 'select-toolbar-op' });

        setButton.dom.appendChild(createSvg(setSvg));
        addButton.dom.appendChild(createSvg(addSvg));
        removeButton.dom.appendChild(createSvg(removeSvg));
        intersectButton.dom.appendChild(createSvg(intersectSvg));

        // icon-only buttons need localized accessible names
        i18n.onChange(() => {
            setButton.dom.setAttribute('aria-label', i18n.t('select-toolbar.set'));
            addButton.dom.setAttribute('aria-label', i18n.t('select-toolbar.add'));
            removeButton.dom.setAttribute('aria-label', i18n.t('select-toolbar.remove'));
            intersectButton.dom.setAttribute('aria-label', i18n.t('select-toolbar.intersect'));
        }, setButton);

        const positionLabel = new Label({ class: 'select-toolbar-label' });
        i18n.bindText(positionLabel, 'select-toolbar.position');

        const position = new VectorInput({
            step: 0.01,
            class: 'select-toolbar-vector',
            precision: 2,
            dimensions: 3,
            placeholder: ['X', 'Y', 'Z'],
            value: [0, 0, 0]
        });
        fieldDefault(position, position.value);

        const sizeLabel = new Label({ class: 'select-toolbar-label' });
        i18n.bindText(sizeLabel, 'select-toolbar.size');

        const size = new VectorInput({
            step: 0.01,
            class: 'select-toolbar-vector',
            precision: 2,
            dimensions: 3,
            placeholder: ['X', 'Y', 'Z'],
            value: [1, 1, 1],
            min: 0.01
        });
        fieldDefault(size, size.value);

        const rotationLabel = new Label({ class: 'select-toolbar-label', hidden: true });
        i18n.bindText(rotationLabel, 'select-toolbar.rotation');

        const rotation = new VectorInput({
            step: 1,
            class: 'select-toolbar-vector',
            precision: 2,
            dimensions: 3,
            placeholder: ['X', 'Y', 'Z'],
            value: [0, 0, 0],
            hidden: true
        });
        fieldDefault(rotation, [0, 0, 0]);

        selectToolbar.append(translateButton);
        selectToolbar.append(rotateButton);
        selectToolbar.append(scaleButton);
        selectToolbar.append(new Element({ class: 'select-toolbar-separator' }));
        selectToolbar.append(setButton);
        selectToolbar.append(addButton);
        selectToolbar.append(removeButton);
        selectToolbar.append(intersectButton);
        selectToolbar.append(positionLabel);
        selectToolbar.append(position);
        selectToolbar.append(sizeLabel);
        selectToolbar.append(size);
        selectToolbar.append(rotationLabel);
        selectToolbar.append(rotation);

        canvasContainer.append(selectToolbar);

        // write the box into the ui without retriggering the inputs' change
        // handlers
        let uiUpdating = false;
        const updateUI = () => {
            const p = shape.primitive;
            if (!p) return;
            uiUpdating = true;
            position.value = [p.position.x, p.position.y, p.position.z];
            size.value = [p.size.x, p.size.y, p.size.z];
            p.rotation.getEulerAngles(euler);
            rotation.value = [euler.x, euler.y, euler.z];
            uiUpdating = false;
        };

        const syncModeUI = (mode: ShapeGizmoMode) => {
            translateButton.class[mode === 'translate' ? 'add' : 'remove']('active');
            rotateButton.class[mode === 'rotate' ? 'add' : 'remove']('active');
            scaleButton.class[mode === 'scale' ? 'add' : 'remove']('active');

            // show the rotation fields while rotating, the size fields otherwise
            const rotating = mode === 'rotate';
            sizeLabel.hidden = rotating;
            size.hidden = rotating;
            rotationLabel.hidden = !rotating;
            rotation.hidden = !rotating;
        };

        const gizmo = new ShapeTransformGizmo(events, scene, {
            rotate: true,
            uniformScale: false,
            lowerBoundScale: new Vec3(0.01, 0.01, 0.01),
            onTransformStart: () => shape.startDrag(),
            onTransform: () => {
                shape.drag();
                updateUI();
            },
            onTransformEnd: () => shape.endDrag(),
            onModeChanged: syncModeUI
        });
        syncModeUI(gizmo.mode);

        this.setTransformMode = (mode) => {
            gizmo.toggleMode(mode);
            return true;
        };

        // the box into the select node, combined by this mode
        const apply = (op: 'set' | 'add' | 'remove' | 'intersect') => {
            if (shape.primitive) events.fire('select.byPrimitive', op, shape.primitive);
        };

        translateButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            gizmo.toggleMode('translate');
        });
        rotateButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            gizmo.toggleMode('rotate');
        });
        scaleButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            gizmo.toggleMode('scale');
        });
        setButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            apply('set');
        });
        addButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            apply('add');
        });
        removeButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            apply('remove');
        });
        intersectButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            apply('intersect');
        });
        // each field change is one undo step on the box
        const edit = (change: (pose: ReturnType<ScenePrimitive['getPose']>) => void) => {
            if (uiUpdating || !shape.primitive) return;
            const pose = shape.primitive.getPose();
            change(pose);
            shape.setPose(pose);
        };
        position.on('change', (v: number[]) => edit(pose => pose.position.set(v[0], v[1], v[2])));
        size.on('change', (v: number[]) => edit(pose => pose.size.set(v[0], v[1], v[2])));
        rotation.on('change', (v: number[]) => edit(pose => pose.rotation.setFromEulerAngles(v[0], v[1], v[2])));

        events.on('camera.focalPointPicked', (details: { splat: Splat, position: Vec3 }) => {
            if (this.active) edit(pose => pose.position.copy(details.position));
        });

        // undo, redo and the primitive's own node move it too
        events.on('primitive.moved', (primitive: ScenePrimitive) => {
            if (this.active && primitive === shape.primitive && !shape.dragging) {
                shape.syncPivot();
                updateUI();
            }
        });

        // an undo can take the box out of the scene, and a redo bring it back
        events.on('scene.elementRemoved', (element: unknown) => {
            if (this.active && element === shape.primitive) gizmo.detach();
        });
        events.on('scene.elementAdded', (element: unknown) => {
            if (this.active && element === shape.primitive) gizmo.attach(shape.pivot);
        });

        // compose localized tooltip text with the shortcut key
        const shortcutManager: ShortcutManager = events.invoke('shortcutManager');
        const tooltip = (localeKey: string, shortcutId: string) => () => {
            const text = i18n.t(localeKey);
            const shortcut = shortcutManager.formatShortcut(shortcutId);
            return shortcut ? i18n.formatTooltipWithShortcut(text, shortcut) : text;
        };

        tooltips.register(translateButton, tooltip('tooltip.bottom-toolbar.move', 'tool.moveShortcut'), 'top');
        tooltips.register(rotateButton, tooltip('tooltip.bottom-toolbar.rotate', 'tool.rotateShortcut'), 'top');
        tooltips.register(scaleButton, tooltip('tooltip.bottom-toolbar.scale', 'tool.scaleShortcut'), 'top');
        tooltips.register(setButton, () => i18n.t('select-toolbar.set'), 'top');
        tooltips.register(addButton, () => i18n.t('select-toolbar.add'), 'top');
        tooltips.register(removeButton, () => i18n.t('select-toolbar.remove'), 'top');
        tooltips.register(intersectButton, () => i18n.t('select-toolbar.intersect'), 'top');

        this.activate = () => {
            this.active = true;
            shape.acquire();
            if (gizmo.mode === 'none') {
                gizmo.setMode('translate');
            }
            gizmo.attach(shape.pivot);
            updateUI();
            selectToolbar.hidden = false;
        };

        this.deactivate = () => {
            selectToolbar.hidden = true;
            gizmo.detach();
            this.active = false;
            // a box that went into no select node is taken out again
            shape.release();
        };
    }
}

export { BoxSelection };
