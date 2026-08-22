import { AnimTrack } from './anim-track';
import { AnimTrackEditOp } from './edit-ops';
import { Events } from './events';

/**
 * Manages the active animation track and provides undo-wrapped
 * key operations. Resolves which track the user is interacting
 * with and ensures all mutations are undoable.
 *
 * Selecting a camera aims the timeline at that camera: its keys are the
 * ones drawn, and Add Key stores the pose you are currently looking at.
 * With nothing selected the timeline still edits the view's own track,
 * which is what it always did and what the video exporter follows.
 */
const registerTrackManagerEvents = (events: Events) => {
    // The track the timeline is pointed at: the selected camera's, if a
    // camera is selected, otherwise the view's own.
    const getActiveTrack = (): AnimTrack | null => {
        const camera = events.invoke('camera.selected') as { track?: AnimTrack } | null;
        return camera?.track ?? events.invoke('camera.animTrack') ?? null;
    };

    // Helper: execute an edit on the active track wrapped in undo.
    // The editFn must return true if it modified the track, false if it was a no-op.
    const trackEdit = (name: string, editFn: (track: AnimTrack) => boolean) => {
        const track = getActiveTrack();
        if (!track) return;
        const before = track.snapshot();
        if (!editFn(track)) return;
        const after = track.snapshot();
        events.fire('edit.add', new AnimTrackEditOp(name, track, before, after), true);
    };

    // Get keys from active track
    events.function('track.keys', () => {
        const track = getActiveTrack();
        return track ? track.keys : [];
    });

    // Add key to active track
    events.on('track.addKey', (frame?: number) => {
        const keyFrame = frame ?? events.invoke('timeline.frame');
        trackEdit('addKey', track => track.addKey(keyFrame));
    });

    // Remove key from active track
    events.on('track.removeKey', (frame?: number) => {
        const keyFrame = frame ?? events.invoke('timeline.frame');
        trackEdit('removeKey', track => track.removeKey(keyFrame));
    });

    // Move key in active track
    events.on('track.moveKey', (fromFrame: number, toFrame: number) => {
        trackEdit('moveKey', track => track.moveKey(fromFrame, toFrame));
    });

    // Copy key in active track
    events.on('track.copyKey', (fromFrame: number, toFrame: number) => {
        trackEdit('copyKey', track => track.copyKey(fromFrame, toFrame));
    });
};

export { registerTrackManagerEvents };
