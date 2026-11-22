import { CommandQueue } from './command-queue';
import { AddSplatOp, EditOp, MultiOp, SelectOp, SelectStep, StateOp } from './edit-ops';
import { Events } from './events';
import { Splat } from './splat';

/**
 * What an op brings into the scene: a producer's output, an added object.
 */
const produces = (op: EditOp): object[] => {
    if (op instanceof MultiOp) return op.ops.flatMap(produces);
    const o = op as any;
    return [o.output, op instanceof AddSplatOp ? o.splat : null].filter(Boolean);
};

/**
 * An op whose object is not in the scene: its producer is bypassed or gone,
 * so there is nothing for it to act on. Applying it anyway would throw
 * partway through a replay. An op that adds its object is not orphaned by
 * the object being absent - that is what it is for.
 */
const orphaned = (op: EditOp): boolean => {
    if (op instanceof MultiOp) return op.ops.some(orphaned);
    if (op instanceof AddSplatOp) return false;
    const splat = (op as any).splat;
    return splat instanceof Splat && !splat.scene;
};

/** Forget what the StateOps in `op` resolved, if `which` says so. */
const invalidateStates = (op: EditOp, which: (s: StateOp) => boolean = () => true) => {
    const all = op instanceof MultiOp ? op.ops : [op];
    all.forEach(inner => inner instanceof StateOp && which(inner) && inner.invalidate());
};

// Check if an operation references a specific splat
const opReferencesSplat = (op: EditOp, splat: Splat): boolean => {
    // Handle MultiOp by checking nested operations
    if (op instanceof MultiOp) {
        return op.ops.some(nestedOp => opReferencesSplat(nestedOp, splat));
    }
    // Check for splat property on the operation
    return (op as any).splat === splat;
};

type Footprint = { reads: object[], writes: object[] };

/**
 * What an op reads and what it changes: the object it edits, a shape or
 * primitive it is about, what is wired into it, and what it makes. Null
 * for an op that names none of these - nothing can be said about what it
 * reaches, so whoever asks has to assume it reaches everything.
 */
const footprint = (op: EditOp): Footprint | null => {
    if (op instanceof MultiOp) {
        const parts = op.ops.map(footprint);
        if (parts.some(p => !p)) return null;
        return {
            reads: parts.flatMap(p => p.reads),
            writes: parts.flatMap(p => p.writes)
        };
    }

    const o = op as any;
    const reads: object[] = [];
    const writes: object[] = [];
    for (const key of ['splat', 'shape', 'primitive', 'light', 'camera']) {
        // objects only: a crop names its shape with a string
        if (o[key] && typeof o[key] === 'object') {
            reads.push(o[key]);
            writes.push(o[key]);
        }
    }
    // a node that consumes objects also hides them, so it changes them too
    (o.inputs ?? []).forEach((input: object) => {
        reads.push(input);
        writes.push(input);
    });
    (o.ports ?? []).forEach((port: { source: object | null }) => {
        if (port.source) reads.push(port.source);
    });
    if (o.output) writes.push(o.output);

    return reads.length || writes.length ? { reads, writes } : null;
};

class EditHistory {
    history: EditOp[] = [];
    cursor = 0;
    events: Events;

    /**
     * The lowest the cursor goes by undo. A loaded project's own nodes are
     * where the session starts, not edits made in it.
     */
    floor = 0;

    // how many ops are inside their own do/undo right now. What an op does to
    // the scene - an undo removing what its do added - is history moving,
    // not the user deleting something.
    private applyDepth = 0;

    // ops the cursor is past but that were not applied: orphaned, or they
    // threw. Their undo is skipped, since nothing was done to reverse.
    private skipped = new WeakSet<EditOp>();

    // while > 0, the per-step events are held back and fired once at the end
    private batch = 0;

    // objects whose data was swapped underneath the history since the last
    // reapplyAll - a sequence frame, a retrained output
    private replaced = new Set<object>();

    get applying() {
        return this.applyDepth > 0;
    }

    // shared queue used to serialize every history mutation. the same physical
    // CommandQueue is shared with DataProcessor callers via scene.commandQueue
    // and the 'queue' event, so all async splat work applies in initiation order.
    private commandQueue: CommandQueue;

    constructor(events: Events, commandQueue: CommandQueue) {
        this.events = events;
        this.commandQueue = commandQueue;

        events.on('edit.undo', () => this.undo());
        events.on('edit.redo', () => this.redo());
        events.on('edit.add', (editOp: EditOp, suppressOp = false) => this.add(editOp, suppressOp));
        events.on('edit.removeForShape', (shape: unknown) => this.removeForShape(shape));
        events.on('edit.goto', (cursor: number) => this.goto(cursor));
        events.function('edit.reselect', (index: number, steps: SelectStep[]) => this.reselect(index, steps));
        events.function('edit.removeAt', (indices: number[]) => this.removeAt(indices));
        events.function('edit.refresh', (index: number, mutate?: () => void) => this.refresh(index, mutate));
        events.function('edit.reapplyAll', (targets?: object[]) => this.reapplyAll(targets));
        events.function('edit.markLoaded', () => this.markLoaded());
        events.on('splat.replaced', (splat: Splat) => this.replaced.add(splat));
        // replaced before any node stood on it (a merge made as a project opens)
        events.on('splat.settled', (splat: Splat) => this.replaced.delete(splat));
        events.function('edit.setBypassed', (index: number, bypassed: boolean) => this.setBypassed(index, bypassed));
        events.function('edit.canMove', (from: number, to: number) => this.canMove(from, to));
        events.function('edit.move', (from: number, to: number) => this.move(from, to));

        // read access for views that draw the history rather than drive it -
        // the node panel builds its graph from this
        events.function('edit.history', () => ({ ops: this.history, cursor: this.cursor }));
    }

    private queue<T>(fn: () => T | Promise<T>): Promise<T> {
        return this.commandQueue.enqueue(fn);
    }

    // asked inside the queued task, before an edit is added, undone or redone:
    // a cursor to wind to first, or null. A viewer that wound the history
    // back to show a point hands back where the chain really ends, so the
    // edit lands there instead of truncating everything after the point.
    private beforeEdit: (() => number | null)[] = [];

    onBeforeEdit(fn: () => number | null) {
        this.beforeEdit.push(fn);
    }

    private async settle() {
        for (const fn of this.beforeEdit) {
            const target = fn();
            if (target !== null && target !== this.cursor) await this.travel(target);
        }
    }

    add(editOp: EditOp, suppressOp = false) {
        return this.queue(async () => {
            await this.settle();
            await this._add(editOp, suppressOp);
        });
    }

    canUndo() {
        return this.cursor > this.floor;
    }

    canRedo() {
        return this.cursor < this.history.length;
    }

    undo() {
        return this.queue(async () => {
            await this.settle();
            if (this.canUndo()) {
                await this._undo();
            }
        });
    }

    redo(suppressOp = false) {
        return this.queue(async () => {
            await this.settle();
            if (this.canRedo()) {
                await this._redo(suppressOp);
            }
        });
    }

    private async _add(editOp: EditOp, suppressOp = false) {
        while (this.cursor < this.history.length) {
            this.history.pop().destroy?.();
        }
        this.history.push(editOp);
        await this._redo(suppressOp);
    }

    private async _undo() {
        // only advance the cursor after a successful undo so a thrown editOp leaves
        // history in a consistent state for subsequent undo/redo.
        const editOp = this.history[this.cursor - 1];
        // a bypassed or skipped op was never applied, so there is nothing to reverse
        if (!editOp.bypassed && !this.skipped.has(editOp)) {
            await this.run(editOp, true);
        }
        this.skipped.delete(editOp);
        this.cursor--;
        this.events.fire('edit.apply', editOp);
        this.fireEvents();
    }

    private async _redo(suppressOp = false) {
        // only advance the cursor after a successful redo so a thrown editOp leaves
        // history in a consistent state for subsequent undo/redo.
        const editOp = this.history[this.cursor];
        if (!suppressOp && !editOp.bypassed) {
            if (orphaned(editOp)) {
                this.skipped.add(editOp);
            } else {
                await this.run(editOp, false);
            }
        }
        this.cursor++;
        this.events.fire('edit.apply', editOp);
        this.fireEvents();
    }

    private async run(op: EditOp, undo: boolean) {
        this.applyDepth++;
        try {
            await (undo ? op.undo() : op.do());
        } finally {
            this.applyDepth--;
        }
    }

    /**
     * Redo for a replay: an op that throws is stepped over rather than
     * stopping the replay with the cursor halfway. Returns false for one
     * that threw.
     */
    private async redoTolerant() {
        const editOp = this.history[this.cursor];
        try {
            await this._redo();
            return true;
        } catch (error) {
            console.error(error);
            this.skipped.add(editOp);
            this.cursor++;
            return false;
        }
    }

    private reportFailed(failed: number) {
        if (!failed) return;
        this.events.invoke('showPopup', {
            type: 'error',
            header: 'Replay',
            message: `${failed} node${failed === 1 ? '' : 's'} could not be applied and ${failed === 1 ? 'was' : 'were'} skipped. See the console for details.`
        });
    }

    /**
     * Wind back to `index`, run `mutate`, drop what the ops after it resolved,
     * then wind forward again.
     *
     * Every structural change to applied history has this shape: you cannot
     * edit an op that is currently applied without first reversing it, and
     * everything standing on it has to be asked again afterwards.
     */
    private async replayAround(index: number, mutate: () => void, cursorAfter: (resume: number) => number, changed: EditOp[]) {
        const resume = this.cursor;
        let failed = 0;

        this.batch++;
        try {
            while (this.cursor > index) {
                await this._undo();
            }

            mutate();

            this.invalidateReached(index, changed);

            const target = Math.max(0, Math.min(this.history.length, cursorAfter(resume)));
            while (this.cursor < target) {
                if (!await this.redoTolerant()) failed++;
            }
        } finally {
            this.batch--;
            this.fireEvents();
        }
        this.reportFailed(failed);
    }

    /**
     * Drop what the ops from `index` on resolved - but only those the change
     * can reach.
     *
     * Everything after `index` is wound back and forward again either way,
     * since history is one line. What costs is resolving: a selection asked
     * again, a cleanup run again. An op that edits another object, reading
     * nothing the changed ops wrote, would ask its question of the same data
     * and get the same answer, so it keeps the one it has. Reach is
     * followed forward: an op that touches anything reached is reached
     * itself, and so is everything it writes - so a select node feeding a
     * light, or an object feeding a merge, carries the change on.
     *
     * An op whose footprint is unknown is assumed to reach everything from
     * there on. Being wrong here would corrupt state silently rather than
     * throw, so doubt resolves toward asking again.
     */
    private invalidateReached(index: number, changed: EditOp[]) {
        const reached = new Set<object>();
        let everything = false;
        changed.forEach((op) => {
            const fp = footprint(op);
            if (!fp) everything = true;
            else fp.writes.forEach(w => reached.add(w));
            reached.add(op);
        });

        for (let i = index; i < this.history.length; ++i) {
            const op = this.history[i];
            const fp = footprint(op);
            const hit = everything || !fp || changed.includes(op) ||
                fp.reads.some(r => reached.has(r)) || fp.writes.some(w => reached.has(w));
            if (!hit) continue;

            if (op instanceof StateOp) op.invalidate();
            if (op instanceof MultiOp) {
                op.ops.forEach(inner => inner instanceof StateOp && inner.invalidate());
            }
            if (!fp) everything = true;
            else fp.writes.forEach(w => reached.add(w));
            reached.add(op);
        }
    }

    /** Drop ops from the history entirely, rebuilding what stood on them. */
    removeAt(indices: number[]) {
        const sorted = [...new Set(indices)].filter(i => i >= 0 && i < this.history.length).sort((a, b) => a - b);
        if (!sorted.length) return Promise.resolve();
        const removed = sorted.map(i => this.history[i]);

        return this.queue(() => this.replayAround(
            sorted[0],
            () => {
                this.floor -= sorted.filter(i => i < this.floor).length;
                // back to front, so the earlier indices stay valid as we splice
                [...sorted].reverse().forEach((i) => {
                    this.history.splice(i, 1)[0].destroy?.();
                });
            },
            resume => resume - sorted.filter(i => i < resume).length,
            removed
        ));
    }

    /**
     * Change an op's parameters and rebuild what stood on it.
     *
     * The change is handed in rather than made beforehand, and that is not a
     * convenience: the op has to be reversed while it still remembers what it
     * did. Editing it first - invalidating its resolved set, or moving the
     * target it undoes towards - leaves the undo with nothing to undo, and the
     * old effect stays applied underneath the new one.
     */
    refresh(index: number, mutate: () => void = () => {}) {
        if (!this.history[index]) return Promise.resolve();
        return this.queue(() => this.replayAround(
            index,
            mutate,
            resume => Math.max(resume, index + 1),
            [this.history[index]]
        ));
    }

    /**
     * Re-run the history that stands on data replaced underneath it - the
     * next frame of a sequence, a retrained output.
     *
     * Which objects were replaced is handed in, or else taken from the
     * `splat.replaced` events since the last call; with neither, every
     * object in the scene is assumed replaced.
     *
     * Only the ops that reach a replaced object are re-run - an edit on
     * another object is still applied and still right, and re-applying it
     * without reversing it would apply it twice. The ops that are re-run are
     * reversed first, newest first, because most of what they did outlives
     * the swap: an object transform, a palette slot, a merge hiding its
     * inputs. What does not outlive it is per-gaussian state - the new data
     * comes with its own - so a state op on a replaced object forgets what it
     * resolved before the reversal and has nothing to undo. Then they are
     * applied forward again and resolve against the new data.
     *
     * This is what "one edit, all frames" means in practice. A sphere
     * selection catches whatever is inside it on this frame; a grade follows.
     * A frozen selection cannot follow - its stored positions belong to the
     * frame it was taken on - and resolves to nothing rather than to the wrong
     * gaussians. See the numSplats check in select-query.ts.
     */
    reapplyAll(targets?: object[]) {
        return this.queue(async () => {
            let replaced: Set<object>;
            if (targets?.length) {
                replaced = new Set(targets);
                targets.forEach(t => this.replaced.delete(t));
            } else if (this.replaced.size) {
                replaced = this.replaced;
                this.replaced = new Set();
            } else {
                replaced = new Set((this.events.invoke('scene.allSplats') ?? []) as object[]);
            }
            if (!replaced.size) return;

            // what stands on the replaced data, followed forward the same way
            // invalidateReached does. The op that makes a replaced object is
            // not among them: its object is the thing that changed.
            const reached = new Set<object>(replaced);
            const hit: number[] = [];
            this.history.forEach((op, i) => {
                if (produces(op).some(o => replaced.has(o))) return;
                const fp = footprint(op);
                if (!fp || !(fp.reads.some(r => reached.has(r)) || fp.writes.some(w => reached.has(w)))) return;
                hit.push(i);
                reached.add(op);
                fp.writes.forEach(w => reached.add(w));
            });

            const onReplaced = (s: StateOp) => replaced.has(s.splat);
            hit.forEach(i => invalidateStates(this.history[i], onReplaced));

            const applied = hit.filter(i => i < this.cursor);

            this.batch++;
            try {
                for (let k = applied.length - 1; k >= 0; --k) {
                    const op = this.history[applied[k]];
                    if (!op.bypassed && !this.skipped.has(op)) {
                        await this.run(op, true);
                    }
                    this.skipped.delete(op);
                }

                hit.forEach(i => invalidateStates(this.history[i]));

                for (const i of applied) {
                    const op = this.history[i];
                    if (op.bypassed) continue;
                    if (orphaned(op)) {
                        this.skipped.add(op);
                        continue;
                    }
                    // this runs every frame during playback, so a failure is
                    // logged rather than put in front of the user each time
                    try {
                        await this.run(op, false);
                    } catch (error) {
                        console.error(error);
                        this.skipped.add(op);
                    }
                    this.events.fire('edit.apply', op);
                }
            } finally {
                this.batch--;
                this.fireEvents();
            }
        });
    }

    /**
     * What is in the history now is the starting point: undo goes no further
     * back. Queued, so ops added just before it are counted.
     */
    markLoaded() {
        return this.queue(() => {
            this.floor = this.cursor;
            this.fireEvents();
        });
    }

    /**
     * Can the op at `from` be moved to `to`? Not past anything it consumes
     * or that consumes it: a node cannot stand above the node that makes
     * its input, nor below one that takes its output. Everything else is
     * a matter of order, which is the point of moving it.
     */
    canMove(from: number, to: number) {
        const op = this.history[from];
        if (!op || to < 0 || to >= this.history.length || to === from) return false;
        const fp = footprint(op);
        if (!fp) return false;

        const lo = Math.min(from, to), hi = Math.max(from, to);
        for (let i = lo; i <= hi; ++i) {
            if (i === from) continue;
            const other = this.history[i];
            const ofp = footprint(other);
            if (!ofp) return false;
            const [earlier, later] = to < from ? [other, op] : [op, other];
            const made = [earlier, (earlier as any).output].filter(Boolean);
            const laterReads = later === op ? fp.reads : ofp.reads;
            if (laterReads.some(r => made.includes(r))) return false;
        }
        return true;
    }

    /**
     * Move an op to another place in the history, and rebuild from the
     * earlier of the two. History stops being append-only here, which is
     * why it goes through the same wind-back as every other structural
     * change: each op is reversed while it still remembers what it did,
     * the line is reordered, and everything the moved ops reach resolves
     * again in its new order.
     */
    move(from: number, to: number) {
        return this.queue(() => {
            if (!this.canMove(from, to)) return;
            const lo = Math.min(from, to), hi = Math.max(from, to);
            const shifted = this.history.slice(lo, hi + 1);
            return this.replayAround(
                lo,
                () => {
                    const [op] = this.history.splice(from, 1);
                    this.history.splice(to, 0, op);
                },
                // as many ops stay applied as were
                resume => resume,
                shifted
            );
        });
    }

    /** Turn an op off or on in place, rebuilding what stood on it. */
    setBypassed(index: number, bypassed: boolean) {
        const op = this.history[index];
        if (!op || !!op.bypassed === bypassed) return Promise.resolve();

        return this.queue(() => this.replayAround(
            index,
            () => {
                op.bypassed = bypassed;
            },
            // the op is still there, so the cursor lands exactly where it was
            resume => resume,
            [op]
        ));
    }

    /**
     * Move the cursor to an absolute position, undoing or redoing as needed.
     * One queued task rather than one per step, so nothing interleaves halfway
     * through the travel.
     */
    goto(cursor: number) {
        return this.queue(() => this.travel(cursor));
    }

    private async travel(cursor: number) {
        const target = Math.max(this.floor, Math.min(this.history.length, cursor));
        this.batch++;
        try {
            while (this.cursor > target) {
                await this._undo();
            }
            while (this.cursor < target) {
                await this._redo();
            }
        } finally {
            this.batch--;
            this.fireEvents();
        }
    }

    /**
     * Change the parameters of a selection already in the history, and rebuild
     * everything that stood on it.
     *
     * The travel is what makes it non-destructive: wind back to before the op,
     * swap its query, drop the resolved sets of everything after it, then wind
     * forward again. Each op resolves itself against the state it now lands on,
     * so a wider sphere at step two changes what step five deleted.
     *
     * Ops that froze a hit set - a brush stroke, a ring-mode pick - replay that
     * set unchanged, because there is nothing else they could mean.
     */
    reselect(index: number, steps: SelectStep[]) {
        const op = this.history[index];
        if (!(op instanceof SelectOp)) return Promise.resolve();

        // the cursor is read inside the queued task, not here: an add or undo
        // issued just before this one may still be queued, and winding back to
        // a cursor that had not happened yet leaves the tail of history undone
        return this.queue(() => this.replayAround(
            index,
            () => op.setSteps(steps),
            // at minimum the edited op itself is applied, so its result is
            // visible even if the cursor sat before it
            resume => Math.max(resume, index + 1),
            [op]
        ));
    }

    fireEvents() {
        if (this.batch > 0) return;
        this.events.fire('edit.canUndo', this.canUndo());
        this.events.fire('edit.canRedo', this.canRedo());
        // anything that reshapes history or moves the cursor lands here, so a
        // view can redraw off this one event
        this.events.fire('edit.changed');
    }

    clear() {
        // route through the queue so any in-flight add/undo/redo finishes before we wipe
        // history, preventing queued ops from running against a cleared state.
        return this.queue(() => {
            // one op failing to let go must not keep the history from emptying
            this.history.forEach((editOp) => {
                try {
                    editOp.destroy?.();
                } catch (e) {
                    console.error(e);
                }
            });
            this.history = [];
            this.cursor = 0;
            this.floor = 0;
            this.replaced.clear();
            this.fireEvents();
        });
    }

    // Remove all operations that reference a specific selection shape. Called
    // when a shape tool deactivates: the volume is transient tool state, so
    // its ops must not linger in history as steps that visibly change nothing.
    // Shape ops are never nested inside MultiOp, so a flat scan suffices.
    removeForShape(shape: unknown) {
        return this.queue(() => {
            let newCursor = 0;
            let newFloor = 0;
            const newHistory: EditOp[] = [];

            for (let i = 0; i < this.history.length; i++) {
                const op = this.history[i];
                if ((op as any).shape === shape) {
                    op.destroy?.();
                } else {
                    newHistory.push(op);
                    if (i < this.cursor) {
                        newCursor++;
                    }
                    if (i < this.floor) {
                        newFloor++;
                    }
                }
            }

            this.history = newHistory;
            this.cursor = newCursor;
            this.floor = newFloor;
            this.fireEvents();
        });
    }

    // Remove all operations that reference a specific splat
    removeForSplat(splat: Splat) {
        // serialize with the queue so we don't reshape history while a queued op is mid-flight
        // (which could leave queued undo/redo pointing at indices that no longer exist).
        return this.queue(() => {
            let newCursor = 0;
            let newFloor = 0;
            const newHistory: EditOp[] = [];

            for (let i = 0; i < this.history.length; i++) {
                const op = this.history[i];
                // Skip ops referencing the splat; don't destroy them since the caller handles that
                if (!opReferencesSplat(op, splat)) {
                    // Keep this operation
                    newHistory.push(op);
                    // Track cursor position (count kept operations before original cursor)
                    if (i < this.cursor) {
                        newCursor++;
                    }
                    if (i < this.floor) {
                        newFloor++;
                    }
                }
            }

            this.history = newHistory;
            this.cursor = newCursor;
            this.floor = newFloor;
            this.fireEvents();
        });
    }
}

export { EditHistory, produces };
