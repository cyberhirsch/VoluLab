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
        events.function('edit.refresh', (index: number) => this.refresh(index));
        events.function('edit.setBypassed', (index: number, bypassed: boolean) => this.setBypassed(index, bypassed));

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
    private async replayAround(index: number, mutate: () => void, cursorAfter: (resume: number) => number) {
        const resume = this.cursor;

        while (this.cursor > index) {
            await this._undo();
        }

        mutate();

        for (let i = index; i < this.history.length; ++i) {
            const later = this.history[i];
            if (later instanceof StateOp) later.invalidate();
        }

        const target = Math.max(0, Math.min(this.history.length, cursorAfter(resume)));
        while (this.cursor < target) {
            await this._redo();
        }
        this.fireEvents();
    }

    /** Drop ops from the history entirely, rebuilding what stood on them. */
    removeAt(indices: number[]) {
        const sorted = [...new Set(indices)].filter(i => i >= 0 && i < this.history.length).sort((a, b) => a - b);
        if (!sorted.length) return Promise.resolve();

        return this.queue(() => this.replayAround(
            sorted[0],
            () => {
                // back to front, so the earlier indices stay valid as we splice
                [...sorted].reverse().forEach((i) => {
                    this.history.splice(i, 1)[0].destroy?.();
                });
            },
            resume => resume - sorted.filter(i => i < resume).length
        ));
    }

    /**
     * Re-apply an op whose parameters were changed in place, rebuilding what
     * stood on it. Nothing to mutate here - the caller already has.
     */
    refresh(index: number) {
        if (!this.history[index]) return Promise.resolve();
        return this.queue(() => this.replayAround(
            index,
            () => {},
            resume => Math.max(resume, index + 1)
        ));
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
            resume => resume
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
            resume => Math.max(resume, index + 1)
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
