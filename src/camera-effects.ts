import { CameraSettings, defaultCameraSettings } from './edit-ops';
import { Events } from './events';
import { Scene } from './scene';

/**
 * What the camera node does to the picture.
 *
 * The node itself is only a record in history; this is what reads it. On
 * every history change the last applied, non-bypassed camera node wins -
 * which is what makes undo, redo, bypass and node removal work without
 * the op having to move any state around in do/undo.
 *
 * The three pieces land in three different places, each where it is
 * physically true rather than where it is easiest:
 *
 *   exposure  - in the splat shader, before tonemapping (a post-tonemap
 *               multiply is a brightness slider, not an exposure)
 *   defocus   - in the splat shader, as a widening of each gaussian (a
 *               screen blur would need a depth buffer the splats never
 *               write, and would flatten the bokeh)
 *   the lens  - a screen-space pass, because distortion, fringing and
 *               vignetting are what the glass does to the finished image
 *
 * The lens pass writes back into the frame buffer the exporters read, so
 * what the viewport shows is what a render produces.
 */

const registerCameraEffects = (events: Events, scene: Scene) => {
    let active: CameraSettings = defaultCameraSettings();

    const recompute = () => {
        // the exposure and lens belong to a camera, so the camera you are
        // looking through is the one that shapes the picture. With no
        // camera in the scene the defaults apply and nothing changes.
        const camera = events.invoke('camera.active') as { settings: CameraSettings } | null;

        // a bypassed or undone node takes its camera out of the scene, so
        // asking the scene is already asking history
        active = camera?.settings ?? defaultCameraSettings();

        scene.forceRender = true;
        events.fire('camera.effects.changed', active);
    };

    /** the settings the renderer should apply right now */
    events.function('camera.effects', () => active);

    events.on('edit.changed', recompute);

    // a node's own face edits its settings in place, so it asks for the
    // recompute itself rather than reshaping history
    events.on('camera.effects.refresh', recompute);

    // the active camera changing changes the whole look
    events.on('camera.activeChanged', recompute);

    recompute();
};

export { registerCameraEffects };
