import { ElementType } from './element';
import { Events } from './events';
import { Scene } from './scene';
import { SceneLight } from './scene-light';

/**
 * Which light is selected, and what selecting one means.
 *
 * A light shares the one selection with objects and cameras: picking a
 * light lets go of whatever else was picked, and picking anything else lets
 * go of the light. That keeps the move/rotate gizmo unambiguous - it acts on
 * the one thing selected, through the handler that thing needs.
 */
const registerLightViewEvents = (events: Events, scene: Scene) => {
    let selected: SceneLight | null = null;

    const lights = () => (scene.getElementsByType(ElementType.light) as unknown[])
    .filter(light => light instanceof SceneLight) as SceneLight[];

    const select = (light: SceneLight | null) => {
        if (selected === light) return;
        selected = light;
        events.fire('light.selectionChanged', selected);
        scene.forceRender = true;
    };

    events.function('light.list', () => lights());
    events.function('light.selected', () => selected);

    events.on('light.select', (light: SceneLight | null) => {
        if (light) {
            events.fire('selection', null);
            events.fire('camera.select', null);
        }
        select(light);
    });

    events.on('selection.changed', (selection: unknown) => {
        if (selection) select(null);
    });

    events.on('camera.selectionChanged', (camera: unknown) => {
        if (camera) select(null);
    });

    // a new light is the thing you are about to aim, the way a new import
    // takes the selection
    events.on('scene.elementAdded', (element: unknown) => {
        if (element instanceof SceneLight) {
            events.fire('light.select', element);
        }
    });

    events.on('scene.elementRemoved', (element: unknown) => {
        if (element === selected) select(null);
    });

    events.on('light.moved', () => {
        scene.forceRender = true;
    });

    events.on('light.changed', () => {
        scene.forceRender = true;
    });
};

export { registerLightViewEvents };
