/**
 * The editor's side of the instance node: making one, and keeping its
 * copies in step with their object - its material and place every frame,
 * its time on every frame of the timeline, its data when it is swapped.
 */

import type { EditOp } from './edit-ops';
import { Events } from './events';
import { InstanceOp, appliedInstances, defaultInstanceSettings, type InstanceSettings } from './instance-ops';
import { Splat } from './splat';

const registerInstanceEvents = (events: Events) => {
    const history = () => (events.invoke('edit.history') ?? { ops: [], cursor: 0 }) as { ops: EditOp[], cursor: number };
    const applied = () => {
        const { ops, cursor } = history();
        return appliedInstances(ops, cursor);
    };

    events.on('graph.addInstanceNode', (target?: Splat) => {
        const splat = target ?? events.invoke('selection') as Splat;
        if (!splat) return;
        const settings = defaultInstanceSettings();
        // apart by a little more than the object is wide
        const extent = splat.worldBound?.halfExtents;
        if (extent) {
            const step = Math.max(0.1, +(extent.x * 2.2).toPrecision(2));
            settings.spacing = [step, step, step];
        }
        const index = history().cursor;
        events.fire('edit.add', new InstanceOp(splat, settings));
        events.fire('graph.selectIndex', index);
    });

    // an instance node from a project
    events.function('instance.addNode', (splat: Splat, stored?: Partial<InstanceSettings> & { bypassed?: boolean }) => {
        if (!splat) return null;
        const base = defaultInstanceSettings();
        const vec3 = (v: unknown, fallback: [number, number, number]) => (Array.isArray(v) && v.length === 3 && v.every(Number.isFinite) ? v as [number, number, number] : fallback);
        const op = new InstanceOp(splat, {
            mode: stored?.mode === 'list' ? 'list' : 'grid',
            count: vec3(stored?.count, base.count),
            spacing: vec3(stored?.spacing, base.spacing),
            timeStep: Number.isFinite(stored?.timeStep) ? stored.timeStep : 0,
            list: typeof stored?.list === 'string' ? stored.list : ''
        });
        op.bypassed = !!stored?.bypassed;
        events.fire('edit.add', op);
        return op;
    });

    // every frame: the copies take their object's material and place
    events.on('prerender', () => {
        applied().forEach(op => op.follow());
    });

    // the timeline's frame, for a 4D object's copies
    const showFrame = (frame: number) => applied().forEach(op => op.showFrame(frame));
    events.on('timeline.frame', showFrame);
    events.on('timeline.time', (time: number) => showFrame(Math.floor(time + 1e-4)));

    // the object's data swapped: copies of the new data
    events.on('splat.replaced', (splat: Splat) => {
        applied().forEach(op => op.splat === splat && op.rebind());
    });

    // gaussians deleted or brought back: the copies' sorts leave out the same
    events.on('edit.changed', () => {
        applied().forEach(op => op.setDeleted());
    });
};

export { registerInstanceEvents };
