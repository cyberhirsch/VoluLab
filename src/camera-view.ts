import { Vec3 } from 'playcanvas';

import { ElementType } from './element';
import { Events } from './events';
import { Scene } from './scene';
import { SceneCamera } from './scene-camera';

/**
 * Looking through a camera, and what happens when you move.
 *
 * The viewport has one real camera; a scene camera is a stored pose it
 * can adopt. So "camera view" is not a second renderer - it is the
 * viewport wearing the scene camera's pose, kept in step every frame.
 *
 * Which way that sync runs is the whole of the lock:
 *
 *   unlocked - the view writes back into the camera, so navigating *is*
 *              framing the shot
 *   locked   - the camera's framing is fixed, so the first navigation
 *              drops the view back to perspective rather than dragging
 *              the camera along
 *
 * That asymmetry is why the sync lives here rather than in Camera: it is
 * a question about intent, not about matrices.
 */

// poses converge instantly when adopting a camera, so anything past this
// is the user having moved
const MOVED_EPSILON = 1e-4;

const registerCameraViewEvents = (events: Events, scene: Scene) => {
    let viewMode: 'perspective' | 'camera' = 'perspective';
    let active: SceneCamera | null = null;
    let selected: SceneCamera | null = null;

    const workPos = new Vec3();
    const workTarget = new Vec3();

    // the viewport's own camera is an element of this type too, so the
    // list is filtered by class rather than by type
    const cameras = () => (scene.getElementsByType(ElementType.camera) as unknown[])
    .filter(c => c instanceof SceneCamera) as SceneCamera[];

    const setActive = (camera: SceneCamera | null) => {
        if (active === camera) return;
        active = camera;
        events.fire('camera.activeChanged', active);
        scene.forceRender = true;
    };

    /** put the viewport on the camera's pose, immediately */
    const adopt = (camera: SceneCamera) => {
        scene.camera.fov = camera.fov;
        scene.camera.setPose(camera.position, camera.target, 0);
    };

    const setViewMode = (mode: 'perspective' | 'camera') => {
        if (mode === 'camera' && !active) {
            // nothing to look through; offer the newest camera if there is one
            const all = cameras();
            if (all.length === 0) return;
            setActive(all[all.length - 1]);
        }
        if (viewMode === mode) return;
        viewMode = mode;
        if (mode === 'camera' && active) {
            adopt(active);
        }
        events.fire('camera.viewMode', viewMode);
        scene.forceRender = true;
    };

    events.function('camera.viewMode', () => viewMode);
    events.function('camera.active', () => active);
    events.function('camera.selected', () => selected);
    events.function('camera.list', () => cameras());

    events.on('camera.setViewMode', setViewMode);
    events.on('camera.setActive', (camera: SceneCamera | null) => setActive(camera));

    events.on('camera.select', (camera: SceneCamera | null) => {
        selected = camera;
        if (camera) {
            // selecting a camera makes it the one you look through, so the
            // timeline and the view agree about which camera is meant
            setActive(camera);
        }
        events.fire('camera.selectionChanged', selected);
        scene.forceRender = true;
    });

    events.on('camera.toggleLock', () => {
        const camera = selected ?? active;
        if (!camera) return;
        camera.locked = !camera.locked;
        events.fire('camera.sceneCameraChanged', camera);
        scene.forceRender = true;
    });

    /** a new camera takes over as the active one, the way a new import takes selection */
    events.on('scene.elementAdded', (element: any) => {
        if (element instanceof SceneCamera) {
            setActive(element as SceneCamera);
            selected = element as SceneCamera;
            events.fire('camera.selectionChanged', selected);
        }
    });

    events.on('scene.elementRemoved', (element: any) => {
        if (!(element instanceof SceneCamera)) return;
        if (selected === element) {
            selected = null;
            events.fire('camera.selectionChanged', selected);
        }
        if (active === element) {
            const remaining = cameras().filter(c => c !== element);
            setActive(remaining.length ? remaining[remaining.length - 1] : null);
            // looking through a camera that just went away makes no sense
            if (!active && viewMode === 'camera') {
                setViewMode('perspective');
            }
        }
    });

    /**
     * Called by Camera.onUpdate with the pose the viewport just settled
     * on. The vectors are the camera's own working values, so anything
     * kept here has to be copied.
     */
    events.on('camera.viewSync', (position: Vec3, target: Vec3) => {
        if (viewMode !== 'camera' || !active) return;

        workPos.copy(position);
        workTarget.copy(target);

        const moved = workPos.distance(active.position) > MOVED_EPSILON ||
            workTarget.distance(active.target) > MOVED_EPSILON ||
            Math.abs(scene.camera.fov - active.fov) > MOVED_EPSILON;

        if (!moved) return;

        if (active.locked) {
            // the shot is fixed: step out rather than disturb it
            setViewMode('perspective');
        } else {
            active.position.copy(workPos);
            active.target.copy(workTarget);
            active.fov = scene.camera.fov;
            events.fire('camera.sceneCameraMoved', active);
        }
    });
};

export { registerCameraViewEvents };
