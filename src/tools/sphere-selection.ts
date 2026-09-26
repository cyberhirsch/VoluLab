import { Button, Container, Element, Label, NumericInput, VectorInput } from '@playcanvas/pcui';
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
 * Select what is inside a sphere: a sphere primitive, wired into the select
 * node as its mesh input, so moving the sphere later selects again. See
 * PrimitiveToolShape.
 */
class SphereSelection {
    activate: () => void;
    deactivate: () => void;
    setTransformMode: (mode: Exclude<ShapeGizmoMode, 'none'>) => boolean;

    active = false;

    constructor(events: Events, scene: Scene, canvasContainer: Container, tooltips: Tooltips) {
        const shape = new PrimitiveToolShape(events, scene, 'sphere');
        const radiusOf = (p: ScenePrimitive | null) => (p ? p.size.x * 0.5 : 0.5);

        // ui
        const selectToolbar = new Container({
            class: 'select-toolbar',
            hidden: true
        });

        selectToolbar.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
        });

        const translateButton = new Button({ class: 'select-toolbar-mode', icon: 'E111' });
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

        const radiusLabel = new Label({ class: 'select-toolbar-label' });
        i18n.bindText(radiusLabel, 'select-toolbar.radius');

        const radius = new NumericInput({
            precision: 2,
            value: 0.5,
            min: 0.01
        });
        fieldDefault(radius, radius.value);

        selectToolbar.append(translateButton);
        selectToolbar.append(scaleButton);
        selectToolbar.append(new Element({ class: 'select-toolbar-separator' }));
        selectToolbar.append(setButton);
        selectToolbar.append(addButton);
        selectToolbar.append(removeButton);
        selectToolbar.append(intersectButton);
        selectToolbar.append(positionLabel);
        selectToolbar.append(position);
        selectToolbar.append(radiusLabel);
        selectToolbar.append(radius);

        canvasContainer.append(selectToolbar);

        // write the sphere into the ui without retriggering the inputs'
        // change handlers
        let uiUpdating = false;
        const updateUI = () => {
            const p = shape.primitive;
            if (!p) return;
            uiUpdating = true;
            position.value = [p.position.x, p.position.y, p.position.z];
            radius.value = radiusOf(p);
            uiUpdating = false;
        };

        const syncModeUI = (mode: ShapeGizmoMode) => {
            translateButton.class[mode === 'translate' ? 'add' : 'remove']('active');
            scaleButton.class[mode === 'scale' ? 'add' : 'remove']('active');
        };

        const gizmo = new ShapeTransformGizmo(events, scene, {
            rotate: false,
            uniformScale: true,
            lowerBoundScale: new Vec3(0.02, 0.02, 0.02),
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

        // the sphere into the select node, combined by this mode
        const apply = (op: 'set' | 'add' | 'remove' | 'intersect') => {
            if (shape.primitive) events.fire('select.byPrimitive', op, shape.primitive);
        };

        translateButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            gizmo.toggleMode('translate');
        });
        scaleButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            gizmo.toggleMode('scale');
        });
        setButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation(); apply('set');
        });
        addButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation(); apply('add');
        });
        removeButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation(); apply('remove');
        });
        intersectButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation(); apply('intersect');
        });
        position.on('change', (v: number[]) => {
            if (!uiUpdating && shape.primitive) {
                const pose = shape.primitive.getPose();
                pose.position.set(v[0], v[1], v[2]);
                shape.setPose(pose);
            }
        });
        radius.on('change', () => {
            if (!uiUpdating && shape.primitive) {
                const pose = shape.primitive.getPose();
                const d = radius.value * 2;
                pose.size.set(d, d, d);
                shape.setPose(pose);
            }
        });

        events.on('camera.focalPointPicked', (details: { splat: Splat, position: Vec3 }) => {
            if (this.active && shape.primitive) {
                const pose = shape.primitive.getPose();
                pose.position.copy(details.position);
                shape.setPose(pose);
            }
        });

        // undo, redo and the primitive's own node move it too
        events.on('primitive.moved', (primitive: ScenePrimitive) => {
            if (this.active && primitive === shape.primitive && !shape.dragging) {
                shape.syncPivot();
                updateUI();
            }
        });

        // an undo can take the sphere out of the scene, and a redo bring it back
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
            // a sphere that went into no select node is taken out again
            shape.release();
        };
    }
}

export { SphereSelection };
