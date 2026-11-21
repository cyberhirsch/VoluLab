import { ZipFileSystem } from '@playcanvas/splat-transform';

import { EditHistory } from './edit-history';
import { EditOp } from './edit-ops';
import { Events } from './events';
import {
    PASS_NAMES, RenderPassesOp, RenderPassSettings, ViewerOp, defaultRenderPassSettings
} from './inspect-ops';
import { BrowserFileSystem } from './io';
import { PassSink, renderPasses } from './render-passes';
import { Scene } from './scene';
import { Splat } from './splat';
import { i18n } from './ui/localization';

type Helpers = {
    appendAndOpen: (op: EditOp) => void;
    addTarget: (splat?: Splat) => Splat[];
};

const removeExtension = (name: string) => name.replace(/\.[^/.]+$/, '');

/**
 * What the data of an object is right now: a frame of a PLY sequence is its
 * own asset, a 3D or GPU-played 4D object keeps one for good.
 */
const frameKey = (splat: Splat) => `${splat.asset?.name ?? ''}#${splat.splatData?.numSplats ?? 0}`;

/**
 * The output and inspection nodes - render passes, viewer, cache, stats -
 * and what they do when asked (inspect-ops.ts has the nodes themselves).
 */
const registerInspectNodes = (events: Events, editHistory: EditHistory, scene: Scene, helpers: Helpers) => {
    const { appendAndOpen, addTarget } = helpers;
    const history = () => (events.invoke('edit.history') ?? { ops: [], cursor: 0 }) as { ops: EditOp[], cursor: number };
    const indexOf = (op: EditOp) => history().ops.indexOf(op);

    // the velocity pass's step, for objects the pass has not set it on
    scene.graphicsDevice.scope.resolve('passMotionStep').setValue(0);

    // --- render passes ---------------------------------------------------

    events.on('graph.addRenderPassesNode', (target?: Splat) => {
        addTarget(target).forEach((splat) => {
            appendAndOpen(new RenderPassesOp(splat, defaultRenderPassSettings(removeExtension(splat.name ?? 'render'))));
        });
    });

    // a project's render passes node, with its settings
    events.function('renderPasses.addNode', (splat: Splat, settings?: Partial<RenderPassSettings>, bypassed?: boolean) => {
        if (!splat) return null;
        const base = defaultRenderPassSettings(removeExtension(splat.name ?? 'render'));
        const op = new RenderPassesOp(splat, { ...base, ...(settings ?? {}), passes: { ...base.passes, ...(settings?.passes ?? {}) } });
        if (bypassed) op.bypassed = true;
        events.fire('edit.add', op);
        return op;
    });

    /**
     * Render a render passes node's sequences. The history is wound to the
     * node first, as for an output node, and back afterwards. Into a folder
     * the user picks, or the one handed in; without the File System Access
     * API, into one zip download.
     */
    events.function('renderPasses.write', async (index: number, dir?: FileSystemDirectoryHandle | 'zip') => {
        const op = history().ops[index];
        if (!(op instanceof RenderPassesOp)) return -1;
        const { settings } = op;
        if (!PASS_NAMES.some(p => settings.passes[p])) return 0;

        let sink: PassSink;
        if (dir !== 'zip' && (dir || (window as any).showDirectoryPicker)) {
            let folder: FileSystemDirectoryHandle;
            try {
                folder = dir ?? await (window as any).showDirectoryPicker({ id: 'volulab-passes', mode: 'readwrite' });
            } catch {
                return -1;
            }
            sink = {
                write: async (name, bytes) => {
                    const file = await folder.getFileHandle(name, { create: true });
                    const stream = await file.createWritable();
                    await stream.write(bytes as unknown as ArrayBuffer);
                    await stream.close();
                },
                close: () => Promise.resolve()
            };
        } else {
            const zip = new ZipFileSystem(new BrowserFileSystem(`${settings.filename}_passes.zip`).createWriter(`${settings.filename}_passes.zip`));
            sink = {
                write: async (name, bytes) => {
                    const w = await zip.createWriter(name);
                    await w.write(bytes);
                    await w.close();
                },
                close: () => zip.close()
            };
        }

        const resume = history().cursor;
        await editHistory.goto(index + 1);
        try {
            return await renderPasses(scene, events, settings, sink);
        } catch (error) {
            await events.invoke('showPopup', {
                type: 'error',
                header: i18n.t('node.passes.failed'),
                message: `'${(error as any)?.message ?? error}'`
            });
            return -1;
        } finally {
            await editHistory.goto(resume);
        }
    });

    // --- viewer ----------------------------------------------------------

    // what the viewport is showing instead of the end of the chain
    let viewing: { op: ViewerOp, resume: number, hidden: Splat[] } | null = null;
    let travelling = false;

    const fireViewer = () => events.fire('viewer.changed', viewing?.op ?? null);

    const unhide = () => {
        viewing?.hidden.forEach((s) => {
            if (s.scene) s.visible = true;
        });
    };

    /** Stop showing the viewer's point; back to where the chain was, unless the user has moved since. */
    const stopViewing = async (goBack = true) => {
        if (!viewing) return;
        const { resume } = viewing;
        unhide();
        viewing = null;
        fireViewer();
        if (goBack) {
            travelling = true;
            try {
                await editHistory.goto(resume);
            } finally {
                travelling = false;
            }
        }
    };

    events.function('viewer.view', async (op: ViewerOp) => {
        const index = indexOf(op);
        if (index < 0 || !(op instanceof ViewerOp)) return false;
        if (viewing?.op === op) return true;
        const resume = viewing ? viewing.resume : history().cursor;
        await stopViewing(false);
        travelling = true;
        try {
            await editHistory.goto(index + 1);
        } finally {
            travelling = false;
        }
        const hidden = op.isolate ? (events.invoke('scene.allSplats') as Splat[]).filter(s => s !== op.splat && s.visible) : [];
        hidden.forEach((s) => {
            s.visible = false;
        });
        viewing = { op, resume, hidden };
        fireViewer();
        return true;
    });

    events.function('viewer.stop', () => stopViewing(true));
    events.function('viewer.active', () => viewing?.op ?? null);

    // Anything that moves the history while viewing - an undo, a new node, a
    // changed parameter - is the user working again: the viewer lets go,
    // where the history now is.
    events.on('edit.changed', () => {
        if (!viewing || travelling) return;
        const index = indexOf(viewing.op);
        if (index < 0 || history().cursor !== index + 1) {
            stopViewing(false);
        }
    });

    events.on('graph.addViewerNode', (target?: Splat) => {
        addTarget(target).forEach(splat => appendAndOpen(new ViewerOp(splat)));
    });

    events.function('viewer.addNode', (splat: Splat, isolate?: boolean, bypassed?: boolean) => {
        if (!splat) return null;
        const op = new ViewerOp(splat);
        if (isolate === false) op.isolate = false;
        if (bypassed) op.bypassed = true;
        events.fire('edit.add', op);
        return op;
    });
};

export { registerInspectNodes, frameKey };
