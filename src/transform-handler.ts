import { CameraTransformHandler } from './camera-transform-handler';
import { EntityTransformHandler } from './entity-transform-handler';
import { Events } from './events';
import { LightTransformHandler } from './light-transform-handler';
import { registerPivotEvents } from './pivot';
import { Splat } from './splat';
import { SplatsTransformHandler } from './splats-transform-handler';

interface TransformHandler {
    activate: () => void;
    deactivate: () => void;
}

const registerTransformHandlerEvents = (events: Events) => {
    const transformHandlers: TransformHandler[] = [];

    const push = (handler: TransformHandler) => {
        if (transformHandlers.length > 0) {
            const transformHandler = transformHandlers[transformHandlers.length - 1];
            transformHandler.deactivate();
        }
        transformHandlers.push(handler);
        handler.activate();
    };

    const pop = () => {
        if (transformHandlers.length > 0) {
            const transformHandler = transformHandlers.pop();
            transformHandler.deactivate();
        }
        if (transformHandlers.length > 0) {
            const transformHandler = transformHandlers[transformHandlers.length - 1];
            transformHandler.activate();
        }
    };

    // bind transform target when selection changes
    const entityTransformHandler = new EntityTransformHandler(events);
    const splatsTransformHandler = new SplatsTransformHandler(events);
    const cameraTransformHandler = new CameraTransformHandler(events);
    const lightTransformHandler = new LightTransformHandler(events);

    const update = (splat: Splat) => {
        pop();
        if (splat) {
            if (splat.numSelected > 0) {
                push(splatsTransformHandler);
            } else {
                push(entityTransformHandler);
            }
        }
    };

    events.on('selection.changed', update);
    events.on('splat.stateChanged', update);

    // a camera is transformable too, through the same pivot - selecting one
    // simply swaps which handler is listening
    events.on('camera.selectionChanged', (camera: unknown) => {
        pop();
        if (camera) {
            push(cameraTransformHandler);
        }
    });

    // and so is a light. Letting go of one only pops its own handler:
    // selecting an object is what deselects the light, and by the time the
    // light hears of it the object's handler is already on top
    events.on('light.selectionChanged', (light: unknown) => {
        if (light) {
            pop();
            push(lightTransformHandler);
        } else if (transformHandlers[transformHandlers.length - 1] === lightTransformHandler) {
            pop();
        }
    });

    events.on('transformHandler.push', (handler: TransformHandler) => {
        push(handler);
    });

    events.on('transformHandler.pop', () => {
        pop();
    });

    registerPivotEvents(events);
};

export { registerTransformHandlerEvents, TransformHandler };
