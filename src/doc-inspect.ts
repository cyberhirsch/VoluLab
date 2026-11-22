import type { EditOp } from './edit-ops';
import type { Events } from './events';
import { CacheOp, RenderPassesOp, StatsOp, ViewerOp } from './inspect-ops';
import type { Splat } from './splat';

/**
 * How a project keeps the output and inspection nodes: as nodes, with their
 * settings. What they hold - a cache's frames, a stats node's figures - is
 * worked out again, not stored; a cache's folder is not stored either, so
 * it comes back keeping its frames in memory until one is picked.
 */

type Place = (op: EditOp | undefined) => { at?: number, pos?: number[] };

const storeInspectNodes = (ops: EditOp[], cursor: number, splats: Splat[], placeOf: Place) => {
    return ops.slice(0, cursor).flatMap((op): object[] => {
        const splat = splats.indexOf((op as any).splat);
        if (splat < 0) return [];
        const common = { splat, ...(op.bypassed ? { bypassed: true } : {}), ...placeOf(op) };
        if (op instanceof RenderPassesOp) return [{ type: 'renderPasses', settings: { ...op.settings, passes: { ...op.settings.passes } }, ...common }];
        if (op instanceof ViewerOp) return [{ type: 'viewer', isolate: op.isolate, ...common }];
        if (op instanceof CacheOp) return [{ type: 'cache', disk: op.settings.disk, uid: op.uid, ...common }];
        if (op instanceof StatsOp) return [{ type: 'stats', ...common }];
        return [];
    });
};

const restoreInspectNode = (stored: any, splat: Splat, events: Events): EditOp | null => {
    const bypassed = !!stored?.bypassed;
    switch (stored?.type) {
        case 'renderPasses': return events.invoke('renderPasses.addNode', splat, stored.settings, bypassed);
        case 'viewer': return events.invoke('viewer.addNode', splat, stored.isolate !== false, bypassed);
        case 'cache': return events.invoke('cache.addNode', splat, bypassed, stored.uid);
        case 'stats': return events.invoke('stats.addNode', splat, bypassed);
        default: return null;
    }
};

export { storeInspectNodes, restoreInspectNode };
