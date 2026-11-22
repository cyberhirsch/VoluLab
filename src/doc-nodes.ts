import { Mat4 } from 'playcanvas';

import {
    CleanupOp,
    CropOp,
    DecimateOp,
    DeleteNodeOp,
    DeleteSelectionOp,
    EditOp,
    HideSelectionOp,
    MultiOp,
    ResetOp,
    SelectAllOp,
    SelectInvertOp,
    SelectNoneOp,
    SelectOp,
    SelectStep,
    StateOp,
    UnhideAllOp
} from './edit-ops';
import { IndexRanges } from './index-ranges';
import { packKeys, unpackKeys } from './keyframes';
import { FlickerRemovalOp } from './look/flicker-removal';
import { ScenePrimitive } from './scene-primitive';
import { SelectQuery } from './select-query';
import { Splat } from './splat';

/**
 * The nodes of a project that say which gaussians are selected, hidden or
 * deleted: select, crop, cleanup, decimate, delete and the rest of the
 * StateOps.
 *
 * A project used to keep what these came to - the deleted gaussians were
 * left out of the object's file - and no node came back. Now the file holds
 * every gaussian and the nodes are stored, so a project opened again can
 * still have a crop widened, a cleanup bypassed or a delete taken out.
 *
 * Each node is stored twice over: as its settings, and as the set of
 * gaussians it applied to (StateOp.resolved). Opened, it applies that set
 * again without asking, and only asks - resolves from its settings - once
 * something invalidates it: its own settings edited, or a node ahead of it
 * changed, bypassed or removed. Two reasons it is not simply run again:
 *
 *  - Some nodes have nothing to run. A brush stroke, a flood fill and a
 *    ring-mode pick are frozen hit sets (select-query.ts); their result is
 *    all there is.
 *  - The rest would be asking different data. The object's file holds the
 *    gaussians as the whole chain left them - moved by a per-gaussian
 *    transform, say - and a sphere select from before that move would catch
 *    others now. And a cleanup over two million gaussians takes its time.
 *
 * So what opens is exactly what was saved, and the settings are there for
 * the next edit.
 *
 * The sets are stored as IndexRanges words in nodes_<i>.bin, one file per
 * object, each node naming its slice.
 *
 * An object keeps its nodes only if they account for its state exactly:
 * applied in order to an object with nothing selected, hidden or deleted,
 * the stored sets have to give the state it is in. Where they do not - a
 * node of a kind not known here, one that did not apply - the object is
 * stored as before, without them (see doc.ts).
 */

type Slice = [start: number, length: number];

type StoredNode = Record<string, any> & {
    type: string;
    /** the object, by its place in the project's list */
    splat: number;
    /** its place in the history, which is its place in the chain */
    at: number;
    bypassed?: boolean;
    /** the gaussians it applied to: a slice of the object's nodes file */
    ranges?: Slice;
};

/** Uint32 words gathered into one file. */
class Words {
    private chunks: Uint32Array[] = [];
    length = 0;

    add(data: Uint32Array): Slice {
        const slice: Slice = [this.length, data.length];
        this.chunks.push(data);
        this.length += data.length;
        return slice;
    }

    bytes() {
        const all = new Uint32Array(this.length);
        let at = 0;
        this.chunks.forEach((chunk) => {
            all.set(chunk, at);
            at += chunk.length;
        });
        return new Uint8Array(all.buffer);
    }
}

const packMat = (m: Mat4) => Array.from(m.data);
const unpackMat = (data: number[]) => new Mat4().set(data);

const packQuery = (query: SelectQuery, words: Words): Record<string, any> => {
    switch (query.kind) {
        case 'sphere':
        case 'box':
        case 'cylinder':
            return { kind: query.kind, transform: packMat(query.transform) };
        case 'rect':
            return { kind: 'rect', rect: { ...query.rect }, viewProjection: packMat(query.viewProjection) };
        case 'poly':
            return {
                kind: 'poly',
                points: query.points.map(p => [p.x, p.y]),
                width: query.width,
                height: query.height,
                viewProjection: packMat(query.viewProjection)
            };
        case 'point':
            return { kind: 'point', point: { ...query.point }, size: query.size, viewProjection: packMat(query.viewProjection) };
        case 'frozen':
            return { kind: 'frozen', source: query.source, numSplats: query.numSplats, hits: words.add(query.hits.data) };
        default:
            // colour and data range: numbers only
            return { ...query };
    }
};

const unpackQuery = (stored: any, words: Uint32Array): SelectQuery => {
    switch (stored.kind) {
        case 'sphere':
        case 'box':
        case 'cylinder':
            return { kind: stored.kind, transform: unpackMat(stored.transform) };
        case 'rect':
            return { kind: 'rect', rect: { ...stored.rect }, viewProjection: unpackMat(stored.viewProjection) };
        case 'poly':
            return {
                kind: 'poly',
                points: stored.points.map((p: number[]) => ({ x: p[0], y: p[1] })),
                width: stored.width,
                height: stored.height,
                viewProjection: unpackMat(stored.viewProjection)
            };
        case 'point':
            return { kind: 'point', point: { ...stored.point }, size: stored.size, viewProjection: unpackMat(stored.viewProjection) };
        case 'frozen':
            return {
                kind: 'frozen',
                source: stored.source,
                numSplats: stored.numSplats,
                hits: IndexRanges.fromData(words.slice(stored.hits[0], stored.hits[0] + stored.hits[1]))
            };
        default:
            return { ...stored } as SelectQuery;
    }
};

// the nodes that have no settings: what they do is all in their kind
const plain: Record<string, new (splat: Splat) => StateOp> = {
    selectAll: SelectAllOp,
    selectNone: SelectNoneOp,
    selectInvert: SelectInvertOp,
    hideSelection: HideSelectionOp,
    unhideAll: UnhideAllOp,
    deleteSelection: DeleteSelectionOp,
    reset: ResetOp
};

/** A node's settings, or null for a kind of node that is not known here. */
const packSettings = (op: StateOp, words: Words, primitives: ScenePrimitive[]): Record<string, any> | null => {
    if (op instanceof SelectOp) {
        const primitive = op.mesh ? primitives.indexOf(op.mesh.source) : -1;
        return {
            type: 'selectOp',
            steps: op.steps.map(step => ({ mode: step.mode, time: step.time, query: packQuery(step.query, words) })),
            time: op.time,
            // the shape wired in, by the primitive's place in the list. With
            // the primitive gone from the scene the node keeps what it caught
            // and comes back without the wire.
            ...(primitive >= 0 ? {
                mesh: {
                    primitive,
                    mode: op.mesh.mode,
                    used: op.mesh.used ? { kind: op.mesh.used.kind, transform: packMat(op.mesh.used.transform) } : null
                }
            } : {})
        };
    }
    if (op instanceof DeleteNodeOp) {
        return { type: 'deleteNode', what: op.what, selectedIn: op.selectedIn };
    }
    if (op instanceof CropOp) {
        return { type: 'crop', shape: op.shape, transform: packMat(op.transform), keepInside: op.keepInside };
    }
    if (op instanceof DecimateOp) {
        return { type: 'decimate', fraction: op.fraction, spread: op.spread };
    }
    if (op instanceof CleanupOp) {
        return { type: 'cleanup', neighbours: op.neighbours, deviations: op.deviations };
    }
    if (op instanceof FlickerRemovalOp) {
        return { type: 'flickerRemoval', frames: op.frames };
    }
    // exactly these classes: a node made from one of them with more to it
    // would come back as less
    return plain[op.name] && op.constructor === plain[op.name] ? { type: op.name } : null;
};

/**
 * An object's state nodes as a project stores them, with the words their
 * sets are in - or null when they do not account for the object's state,
 * and it has to be stored without them.
 *
 * A node inside a MultiOp is stored on its own: what else the MultiOp did
 * is either in the scene as an object (a separate's copy) or about another
 * object.
 */
const storeStateNodes = (history: EditOp[], cursor: number, splat: Splat, index: number, primitives: ScenePrimitive[]) => {
    const words = new Words();
    const nodes: StoredNode[] = [];
    const state = splat.state.data;
    const expected = new Uint8Array(state.length);

    for (let at = 0; at < cursor; ++at) {
        const outer = history[at];
        const parts = outer instanceof MultiOp ? outer.ops : [outer];
        for (const op of parts) {
            if (!(op instanceof StateOp) || op.splat !== splat) continue;

            const settings = packSettings(op, words, primitives);
            if (!settings) return null;

            const node: StoredNode = { ...settings, type: settings.type, splat: index, at };
            // keyed parameters (keyframes.ts), whatever the node
            const keys = packKeys(op);
            if (keys) node.keys = keys;
            if (outer.bypassed) {
                node.bypassed = true;
            } else {
                // an applied node that resolved nothing did not run
                const ranges = op.resolved;
                if (!ranges) return null;
                node.ranges = words.add(ranges.data);
                // as StateOp.apply: set, clear, toggle
                const { mask } = op;
                const bit = op.op as number;
                ranges.forEach((i) => {
                    expected[i] = bit === 0 ? expected[i] | mask : (bit === 1 ? expected[i] & ~mask : expected[i] ^ mask);
                });
            }
            nodes.push(node);
        }
    }

    for (let i = 0; i < state.length; ++i) {
        if (state[i] !== expected[i]) return null;
    }
    return { nodes, words: words.length ? words.bytes() : null };
};

/** A stored node as an op on `splat`, ready to add; null for one not known. */
const restoreStateNode = (stored: StoredNode, splat: Splat, primitives: ScenePrimitive[], words: Uint32Array): StateOp | null => {
    let op: StateOp;
    switch (stored.type) {
        case 'selectOp': {
            const steps: SelectStep[] = (stored.steps ?? []).map((step: any) => ({
                mode: step.mode,
                query: unpackQuery(step.query, words),
                ...(typeof step.time === 'number' ? { time: step.time } : {})
            }));
            const select = new SelectOp(splat, steps);
            // the time the node was made at, not the one the project opens on
            select.time = typeof stored.time === 'number' ? stored.time : undefined;
            const source = primitives[stored.mesh?.primitive];
            if (source) {
                const used = stored.mesh.used;
                select.mesh = {
                    source,
                    mode: stored.mesh.mode,
                    used: used ? { kind: used.kind, transform: unpackMat(used.transform) } : null
                };
            }
            op = select;
            break;
        }
        case 'deleteNode': {
            const node = new DeleteNodeOp(splat, stored.what === 'unselected' ? 'unselected' : 'selected');
            node.selectedIn = stored.selectedIn ?? -1;
            op = node;
            break;
        }
        case 'crop':
            op = new CropOp(splat, stored.shape === 'sphere' ? 'sphere' : 'box', unpackMat(stored.transform), stored.keepInside !== false);
            break;
        case 'decimate':
            op = new DecimateOp(splat, stored.fraction ?? 0.5, !!stored.spread);
            break;
        case 'cleanup':
            op = new CleanupOp(splat, stored.neighbours ?? 16, stored.deviations ?? 1.5);
            break;
        case 'flickerRemoval':
            op = new FlickerRemovalOp(splat, stored.frames ?? 2);
            break;
        default: {
            const Plain = plain[stored.type];
            if (!Plain) return null;
            op = new Plain(splat);
        }
    }

    if (stored.bypassed) (op as EditOp).bypassed = true;
    unpackKeys(op, stored.keys);
    if (stored.ranges) {
        op.restore(IndexRanges.fromData(words.slice(stored.ranges[0], stored.ranges[0] + stored.ranges[1])));
    }
    return op;
};

export { storeStateNodes, restoreStateNode, type StoredNode };
