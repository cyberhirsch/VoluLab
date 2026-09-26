import { ElementType } from './element';
import { Events } from './events';
import { Scene } from './scene';
import { ScenePrimitive } from './scene-primitive';

/**
 * Which primitive is selected, and what selecting one means.
 *
 * A primitive shares the one selection with objects, cameras and lights,
 * the way a light does: picking one lets go of whatever else was picked,
 * and picking anything else lets go of it. The move, rotate and scale
 * gizmo then acts on the one thing selected, through the handler it needs.
 */
const registerPrimitiveViewEvents = (events: Events, scene: Scene) => {
    let selected: ScenePrimitive | null = null;

    const primitives = () => (scene.getElementsByType(ElementType.primitive) as unknown[])
    .filter(p => p instanceof ScenePrimitive) as ScenePrimitive[];

    const select = (primitive: ScenePrimitive | null) => {
        if (selected === primitive) return;
        selected = primitive;
        events.fire('primitive.selectionChanged', selected);
        scene.forceRender = true;
    };

    events.function('primitive.list', () => primitives());
    events.function('primitive.selected', () => selected);

    events.on('primitive.select', (primitive: ScenePrimitive | null) => {
        if (primitive) {
            events.fire('selection', null);
            events.fire('light.select', null);
            // letting go of a camera pops the gizmo's handler, so only
            // when one is held - picking this primitive again must not
            // leave it without one
            if (events.invoke('camera.selected')) events.fire('camera.select', null);
        }
        select(primitive);
    });

    events.on('selection.changed', (selection: unknown) => {
        if (selection) select(null);
    });

    events.on('camera.selectionChanged', (camera: unknown) => {
        if (camera) select(null);
    });

    events.on('light.selectionChanged', (light: unknown) => {
        if (light) select(null);
    });

    // a new primitive is the thing you are about to place
    events.on('scene.elementAdded', (element: unknown) => {
        if (element instanceof ScenePrimitive) {
            events.fire('primitive.select', element);
        }
    });

    events.on('scene.elementRemoved', (element: unknown) => {
        if (element === selected) select(null);
    });

    events.on('primitive.moved', () => {
        scene.forceRender = true;
    });

    events.on('primitive.changed', () => {
        scene.forceRender = true;
    });
};

export { registerPrimitiveViewEvents };
