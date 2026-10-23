import { CommandQueue } from './command-queue';
import { EditOp, MultiOp, SelectOp, SelectStep, StateOp } from './edit-ops';
import { Events } from './events';
import { Splat } from './splat';

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
        events.function('edit.reapplyAll', () => this.reapplyAll());
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

    add(editOp: EditOp, suppressOp = false) {
        return this.queue(() => this._add(editOp, suppressOp));
    }

    canUndo() {
        return this.cursor > 0;
    }

    canRedo() {
        return this.cursor < this.history.length;
    }

    undo() {
        return this.queue(async () => {
            if (this.canUndo()) {
                await this._undo();
            }
        });
    }

    redo(suppressOp = false) {
        return this.queue(async () => {
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
        // a bypassed op was never applied, so there is nothing to reverse
        if (!editOp.bypassed) {
            await editOp.undo();
        }
        this.cursor--;
        this.events.fire('edit.apply', editOp);
        this.fireEvents();
    }

    private async _redo(suppressOp = false) {
        // only advance the cursor after a successful redo so a thrown editOp leaves
        // history in a consistent state for subsequent undo/redo.
        const editOp = this.history[this.cursor];
        if (!suppressOp && !editOp.bypassed) {
            await editOp.do();
        }
        this.cursor++;
        this.events.fire('edit.apply', editOp);
        this.fireEvents();
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

        while (this.cursor > index) {
            await this._undo();
        }

        mutate();

        this.invalidateReached(index, changed);

        const target = Math.max(0, Math.min(this.history.length, cursorAfter(resume)));
        while (this.cursor < target) {
            await this._redo();
        }
        this.fireEvents();
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
     * Re-run the whole history against data that has been replaced underneath
     * it - the next frame of a sequence.
     *
     * Deliberately does not undo first. Undo reverses an op using what it
     * resolved against the *old* data, and that data is gone: the indices it
     * holds now point at different gaussians, or at none. So the cursor is
     * reset without reversing anything, every op forgets what it resolved, and
     * the history is applied forward onto the new frame from a clean state.
     *
     * This is what "one edit, all frames" means in practice. A sphere
     * selection catches whatever is inside it on this frame; a grade follows.
     * A frozen selection cannot follow - its stored positions belong to the
     * frame it was taken on - and resolves to nothing rather than to the wrong
     * gaussians. See the numSplats check in select-query.ts.
     */
    reapplyAll() {
        return this.queue(async () => {
            const resume = this.cursor;
            this.cursor = 0;

            this.history.forEach((op) => {
                if (op instanceof StateOp) op.invalidate();
            });

            while (this.cursor < resume) {
                await this._redo();
            }
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
        return this.queue(async () => {
            const target = Math.max(0, Math.min(this.history.length, cursor));
            while (this.cursor > target) {
                await this._undo();
            }
            while (this.cursor < target) {
                await this._redo();
            }
        });
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
            this.history.forEach((editOp) => {
                editOp.destroy?.();
            });
            this.history = [];
            this.cursor = 0;
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
                }
            }

            this.history = newHistory;
            this.cursor = newCursor;
            this.fireEvents();
        });
    }

    // Remove all operations that reference a specific splat
    removeForSplat(splat: Splat) {
        // serialize with the queue so we don't reshape history while a queued op is mid-flight
        // (which could leave queued undo/redo pointing at indices that no longer exist).
        return this.queue(() => {
            let newCursor = 0;
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
                }
            }

            this.history = newHistory;
            this.cursor = newCursor;
            this.fireEvents();
        });
    }
}

export { EditHistory };
