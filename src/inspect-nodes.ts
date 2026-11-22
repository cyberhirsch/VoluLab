import { ZipFileSystem } from '@playcanvas/splat-transform';

import { EditHistory } from './edit-history';
import { EditOp, StateOp } from './edit-ops';
import { Events } from './events';
import { IndexRanges } from './index-ranges';
import {
    CacheEntry, CacheOp, FrameChange, PASS_NAMES, RenderPassesOp, RenderPassSettings, StatsOp, ViewerOp, defaultRenderPassSettings, isInspectOp
} from './inspect-ops';
import { BrowserFileSystem } from './io';
import { PassSink, renderPasses } from './render-passes';
import { Scene } from './scene';
import { Splat } from './splat';
import { State } from './splat-state';
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

        // the viewer's isolate would hide objects from the frames, and its
        // point is not this node's: back to the end of the chain first
        await events.invoke('viewer.stop');
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

    // Where the chain really ends while the viewer shows an earlier point:
    // the end of the history, or after the op that was last applied. Kept as
    // an op, not an index, so removing or moving nodes while viewing does
    // not shift it.
    type Resume = { atEnd: boolean, last: EditOp | null, cursor: number };

    // what the viewport is showing instead of the end of the chain
    let viewing: { op: ViewerOp, resume: Resume, hidden: Splat[] } | null = null;
    let travelling = false;

    const resumeHere = (): Resume => {
        const { ops, cursor } = history();
        return { atEnd: cursor >= ops.length, last: cursor > 0 ? ops[cursor - 1] : null, cursor };
    };

    const resumeCursor = (resume: Resume) => {
        const { ops } = history();
        if (resume.atEnd) return ops.length;
        if (!resume.last) return 0;
        const at = ops.indexOf(resume.last);
        return at >= 0 ? at + 1 : Math.min(resume.cursor, ops.length);
    };

    const fireViewer = () => events.fire('viewer.changed', viewing?.op ?? null);

    const unhide = () => {
        viewing?.hidden.forEach((s) => {
            if (s.scene) s.visible = true;
        });
    };

    /** Stop showing the viewer's point; back to where the chain ends, unless the user has moved since. */
    const stopViewing = async (goBack = true) => {
        if (!viewing) return;
        const { resume } = viewing;
        unhide();
        viewing = null;
        fireViewer();
        if (goBack) {
            travelling = true;
            try {
                await editHistory.goto(resumeCursor(resume));
            } finally {
                travelling = false;
            }
        }
    };

    // An edit, undo or redo while viewing is the user working again: the
    // viewer lets go and the chain goes back to its end first, inside the
    // same queued task, so nothing after the viewed point is truncated.
    editHistory.onBeforeEdit(() => {
        if (!viewing) return null;
        const { resume } = viewing;
        unhide();
        viewing = null;
        fireViewer();
        return resumeCursor(resume);
    });

    events.function('viewer.view', async (op: ViewerOp) => {
        const index = indexOf(op);
        if (index < 0 || !(op instanceof ViewerOp)) return false;
        if (viewing?.op === op) return true;
        const resume = viewing ? viewing.resume : resumeHere();
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

    // Adds, undos and redos are handled before they happen (onBeforeEdit). An
    // output or render passes write winds away and back to the viewed point:
    // the viewer stays. The viewer node itself removed or bypassed: let go,
    // back to the end of the chain.
    events.on('edit.changed', () => {
        if (!viewing || travelling) return;
        if (indexOf(viewing.op) < 0 || viewing.op.bypassed) {
            stopViewing(true);
        }
    });

    // the user moving the history cursor on purpose: let go, and stay there
    events.on('edit.goto', () => {
        if (viewing && !travelling) stopViewing(false);
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

    // --- cache -----------------------------------------------------------

    // each wrapped node's own question, and the cache that answers for it
    type Wrapped = { original: (splat: Splat) => IndexRanges | Promise<IndexRanges>, cache: CacheOp, lastKey: string | null };
    const wrapped = new WeakMap<StateOp, Wrapped>();

    // every cache made this session, to check against upstream changes
    const caches = new Set<CacheOp>();

    // above this, the frames least recently used leave memory (the folder keeps them)
    const MEMORY_BUDGET = 512 * 1024 * 1024;

    /** The state nodes above a cache on its object that run, top down: bypassed ones never do. */
    const upstreamOf = (cache: CacheOp) => {
        const ops = history().ops;
        const at = ops.indexOf(cache);
        if (at < 0) return [] as StateOp[];
        const out: StateOp[] = [];
        for (let i = 0; i < at; i++) {
            const op = ops[i];
            if (op.bypassed) continue;
            const all = (op as any).ops instanceof Array ? (op as any).ops : [op];
            all.forEach((inner: EditOp) => {
                if (inner instanceof StateOp && inner.splat === cache.splat && !(inner as EditOp).bypassed) out.push(inner);
            });
        }
        return out;
    };

    const live = (cache: CacheOp) => !cache.destroyed && !cache.bypassed && history().ops.includes(cache);

    // --- validity stamp: what stands above the cache, as a hash ---

    const fnv = (h: number, s: string) => {
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return h >>> 0;
    };

    // fields that are what an op holds or points at, not what it was asked
    const NOT_PARAMS = new Set(['splat', 'ranges', 'resolved', 'resolver', 'output', 'inputs', 'events', 'scene', 'parent']);

    /** An op's parameters as text: its own fields, without the objects it works on. */
    const describe = (op: EditOp) => {
        const seen = new WeakSet<object>();
        try {
            return JSON.stringify(op, (key, value) => {
                if (key && (NOT_PARAMS.has(key) || key.startsWith('_'))) return undefined;
                if (value instanceof Splat || value instanceof IndexRanges) return undefined;
                if (ArrayBuffer.isView(value)) {
                    // a frozen hit set can be millions long: its length and an even sample
                    const a = value as unknown as ArrayLike<number>;
                    const step = Math.max(1, Math.floor(a.length / 64));
                    const sample: number[] = [];
                    for (let i = 0; i < a.length; i += step) sample.push(a[i]);
                    return `${a.length}:${sample.join(',')}`;
                }
                if (value && typeof value === 'object') {
                    if (seen.has(value)) return undefined;
                    seen.add(value);
                }
                return value;
            });
        } catch {
            return op.name ?? '?';
        }
    };

    /**
     * Everything above the cache that runs - not only the state nodes on its
     * object, since a transform or a combine above changes what they find -
     * by kind and parameters. A cached frame is only good under the stamp it
     * was made under.
     */
    const stampOf = (cache: CacheOp) => {
        const ops = history().ops;
        const at = ops.indexOf(cache);
        let h = 2166136261;
        for (let i = 0; i < at; i++) {
            const op = ops[i];
            if (op.bypassed || isInspectOp(op)) continue;
            h = fnv(h, `${op.name}|${describe(op)}|`);
        }
        return h.toString(16).padStart(8, '0');
    };

    // --- memory ---

    /** Drop the least recently used frames until the cache fits its budget; `keep` stays. */
    const evict = (cache: CacheOp, keep: string) => {
        let bytes = cache.bytes;
        for (const [key, entry] of cache.frames) {
            if (bytes <= MEMORY_BUDGET) break;
            if (key === keep) continue;
            for (const r of entry.values()) bytes -= r.data.byteLength;
            cache.frames.delete(key);
            cache.evicted++;
        }
    };

    /** A frame's entry, marked as the most recently used. */
    const touch = (cache: CacheOp, key: string) => {
        const entry = cache.frames.get(key);
        if (entry) {
            cache.frames.delete(key);
            cache.frames.set(key, entry);
        }
        return entry;
    };

    // --- disk ---
    //
    // A file per frame: vlcache_<node uid>_<stamp>_<frame>.bin. The uid is
    // the node's own and is stored with the project, so a folder shared by
    // several nodes, projects or sessions only ever serves a node its own
    // files, and only those made under what stands above it now. The header
    // says the same again and is checked on read.
    //
    // All folder work of one cache runs in order (inOrder): a clear waits
    // for the writes before it, a read for the clear before it.

    const MAGIC = 0x31434c56; // 'VLC1'
    const keyHash = (key: string) => fnv(2166136261, key);

    const safe = (s: string) => s.replace(/[^a-z0-9]+/gi, '_').slice(0, 60);
    const prefixOf = (cache: CacheOp) => `vlcache_${cache.uid}_`;
    const fileOf = (cache: CacheOp, stamp: string, key: string) => `${prefixOf(cache)}${stamp}_${safe(key)}_${keyHash(key).toString(16)}.bin`;

    const inOrder = <T>(cache: CacheOp, fn: () => Promise<T>): Promise<T> => {
        const next = cache.diskChain.then(fn, fn);
        cache.diskChain = next.then(() => {}, () => {});
        return next;
    };

    const writeDisk = (cache: CacheOp, key: string) => {
        if (!cache.settings.disk || !cache.dir) return Promise.resolve();
        const entry = cache.frames.get(key);
        if (!entry) return Promise.resolve();
        const upstream = upstreamOf(cache);
        // only a frame every node above that runs has answered for
        if (!upstream.length || !upstream.every(op => entry.has(op))) return Promise.resolve();
        const stamp = stampOf(cache);
        const { generation, dir } = cache;

        let words = 5;
        upstream.forEach((op) => {
            words += 2 + entry.get(op).data.length;
        });
        const out = new Uint32Array(words);
        out[0] = MAGIC;
        out[1] = parseInt(stamp, 16);
        out[2] = keyHash(key);
        out[3] = upstream.length;
        out[4] = words;
        let w = 5;
        upstream.forEach((op, at) => {
            const { data } = entry.get(op);
            out[w++] = at;
            out[w++] = data.length;
            out.set(data, w);
            w += data.length;
        });

        return inOrder(cache, async () => {
            // cleared since: this frame is no longer what the cache holds
            if (cache.generation !== generation || cache.dir !== dir) return;
            try {
                const file = await dir.getFileHandle(fileOf(cache, stamp, key), { create: true });
                const stream = await file.createWritable();
                await stream.write(out.buffer);
                await stream.close();
            } catch (error) {
                console.warn('cache: could not write to the folder', error);
            }
        });
    };

    const readDisk = (cache: CacheOp, key: string): Promise<CacheEntry | null> => {
        if (!cache.settings.disk || !cache.dir) return Promise.resolve(null);
        const upstream = upstreamOf(cache);
        const stamp = stampOf(cache);
        const { dir } = cache;
        return inOrder(cache, async () => {
            try {
                const file = await (await dir.getFileHandle(fileOf(cache, stamp, key))).getFile();
                if (file.size % 4 || file.size < 20) return null;
                const words = new Uint32Array(await file.arrayBuffer());
                if (words[0] !== MAGIC || words[1] !== parseInt(stamp, 16) || words[2] !== keyHash(key) ||
                    words[3] !== upstream.length || words[4] !== words.length) return null;
                const entry: CacheEntry = new Map();
                let w = 5;
                for (let k = 0; k < words[3]; k++) {
                    const at = words[w++];
                    const n = words[w++];
                    if (at >= upstream.length || w + n > words.length) return null;
                    entry.set(upstream[at], IndexRanges.fromData(words.slice(w, w + n)));
                    w += n;
                }
                return entry.size === upstream.length ? entry : null;
            } catch {
                return null;
            }
        });
    };

    /** Remove this node's files; with `except`, those made under that stamp stay. */
    const clearDisk = (cache: CacheOp, except?: string) => {
        const { dir } = cache;
        if (!dir) return Promise.resolve();
        const prefix = prefixOf(cache);
        const keep = except ? `${prefix}${except}_` : null;
        return inOrder(cache, async () => {
            try {
                const names: string[] = [];
                for await (const name of (dir as any).keys()) {
                    if (name.startsWith(prefix) && !(keep && name.startsWith(keep))) names.push(name);
                }
                for (const name of names) await dir.removeEntry(name);
            } catch {
                // the folder went away; nothing to clear
            }
        });
    };

    /** Forget what memory holds; writes still queued for it are dropped. */
    const forget = (cache: CacheOp) => {
        cache.clear();
        cache.generation++;
    };

    const clearCache = (cache: CacheOp) => {
        forget(cache);
        return clearDisk(cache);
    };

    // What stands above a cache changed - a parameter, a bypass, a node added
    // or removed above it: what it holds in memory was made under something
    // else. Checked on every history change, not only when a node asks again,
    // so a cache bypassed while the change happened does not serve it after.
    // The folder's files carry their stamp, so they need no clearing here.
    events.on('edit.changed', () => {
        caches.forEach((cache) => {
            if (cache.destroyed) {
                caches.delete(cache);
                return;
            }
            if (!history().ops.includes(cache)) return;
            const stamp = stampOf(cache);
            if (cache.stamp !== null && cache.stamp !== stamp) forget(cache);
            cache.stamp = stamp;
        });
    });

    /**
     * Put the cache between each state node above it and its question.
     *
     * A node asks again when it was invalidated: the data under it was
     * replaced (a new frame of a sequence) or something above it changed. A
     * frame it has an answer for is answered from the cache; a node asking
     * again on the frame it last asked on means the question changed, and
     * the whole cache goes.
     */
    const wrap = (cache: CacheOp) => {
        cache.stamp = stampOf(cache);
        upstreamOf(cache).forEach((op) => {
            const known = wrapped.get(op);
            if (known && known.cache === cache) return;
            if (known && live(known.cache)) return;
            const original = known?.original ?? (op as any).resolver;
            const w: Wrapped = { original, cache, lastKey: null };
            wrapped.set(op, w);
            (op as any).resolver = async (splat: Splat) => {
                const c = w.cache;
                if (!live(c) || !upstreamOf(c).includes(op)) return w.original(splat);
                const key = frameKey(splat);
                if (w.lastKey === key) {
                    await clearCache(c);
                }
                w.lastKey = key;
                // what stands above may have changed since edit.changed last looked
                const stamp = stampOf(c);
                if (c.stamp !== stamp) forget(c);
                c.stamp = stamp;
                let entry = touch(c, key);
                if (!entry?.has(op)) {
                    const generation = c.generation;
                    const fromDisk = await readDisk(c, key);
                    if (fromDisk?.has(op) && c.generation === generation) {
                        entry = fromDisk;
                        c.frames.set(key, entry);
                        evict(c, key);
                    }
                }
                const hit = entry?.get(op);
                if (hit) {
                    c.hits++;
                    return hit;
                }
                c.misses++;
                const generation = c.generation;
                const ranges = await w.original(splat);
                // cleared while it was working: the answer is for what stood here before
                if (c.generation !== generation) return ranges;
                if (!c.frames.has(key)) c.frames.set(key, new Map());
                c.frames.get(key).set(op, ranges);
                evict(c, key);
                writeDisk(c, key);
                return ranges;
            };
            // what it already resolved is the frame it stands on now
            if (op.resolved) {
                const key = frameKey(cache.splat);
                if (!cache.frames.has(key)) cache.frames.set(key, new Map());
                cache.frames.get(key).set(op, op.resolved);
                w.lastKey = key;
            }
        });
        writeDisk(cache, frameKey(cache.splat));
    };

    const newUid = () => {
        const c = (globalThis as any).crypto;
        if (c?.randomUUID) return (c.randomUUID() as string).replace(/-/g, '').slice(0, 16);
        return Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    };

    const makeCache = (splat: Splat, disk = false, uid?: string) => {
        const op = new CacheOp(splat, { disk });
        op.uid = typeof uid === 'string' && /^[a-z0-9]{1,32}$/i.test(uid) ? uid : newUid();
        caches.add(op);
        const doIt = op.do.bind(op);
        op.do = () => {
            doIt();
            wrap(op);
        };
        return op;
    };

    events.on('graph.addCacheNode', (target?: Splat) => {
        addTarget(target).forEach(splat => appendAndOpen(makeCache(splat)));
    });

    events.function('cache.addNode', (splat: Splat, bypassed?: boolean, uid?: string) => {
        if (!splat) return null;
        // the folder is not stored: disk comes back off until one is picked
        const op = makeCache(splat, false, uid);
        if (bypassed) op.bypassed = true;
        events.fire('edit.add', op);
        return op;
    });

    events.function('cache.clear', async (op: CacheOp) => {
        await clearCache(op);
        events.fire('edit.changed');
    });

    /**
     * Turn writing to a folder on (one picked, or handed in) or off. Turning
     * it on drops this node's files made under anything other than what
     * stands above it now; its files that still hold are read when asked.
     */
    events.function('cache.setDisk', async (op: CacheOp, on: boolean, dir?: FileSystemDirectoryHandle) => {
        if (!on) {
            op.settings.disk = false;
            op.dir = null;
            events.fire('edit.changed');
            return true;
        }
        let folder = dir;
        if (!folder) {
            if (!(window as any).showDirectoryPicker) return false;
            try {
                folder = await (window as any).showDirectoryPicker({ id: 'volulab-cache', mode: 'readwrite' });
            } catch {
                return false;
            }
        }
        op.dir = folder;
        op.settings.disk = true;
        await clearDisk(op, stampOf(op));
        await Promise.all([...op.frames.keys()].map(key => writeDisk(op, key)));
        events.fire('edit.changed');
        return true;
    });

    /**
     * Fill the cache for every frame of a PLY sequence, by stepping the
     * sequence through them, and go back to the frame shown.
     */
    events.function('cache.bake', async (op: CacheOp) => {
        const source = events.invoke('sequence.source');
        if (!source || events.invoke('sequence.splat') !== op.splat || source.showFrame) return 0;
        const frames = source.frameCount as number;
        const back = events.invoke('timeline.frame') ?? 0;
        events.fire('progressStart', i18n.t('node.cache.bake'), false);
        try {
            for (let f = 0; f < frames; f++) {
                await events.invoke('plysequence.setFrameAsync', f);
                await scene.commandQueue.enqueue(() => {});
                events.fire('progressUpdate', { text: `${f + 1} / ${frames}`, progress: 100 * (f + 1) / frames });
            }
        } finally {
            await events.invoke('plysequence.setFrameAsync', back);
            await scene.commandQueue.enqueue(() => {});
            events.fire('progressEnd');
            events.fire('edit.changed');
        }
        return frames;
    });

    // --- stats -----------------------------------------------------------

    const stillOf = new WeakMap<object, Uint8Array>();

    /** Per row: 1 for a gaussian of a 4D model that neither moves nor fades. */
    const stillRows = (splat: Splat) => {
        const { motion } = splat;
        if (!motion) return null;
        let still = stillOf.get(motion);
        if (!still) {
            if (motion.hierarchy) {
                still = motion.hierarchy().still;
            } else {
                const n = motion.falloff.length;
                still = new Uint8Array(n);
                const v = motion.velocityTime;
                for (let i = 0; i < n; i++) {
                    still[i] = (Math.abs(v[i * 4]) + Math.abs(v[i * 4 + 1]) + Math.abs(v[i * 4 + 2]) < 1e-7 && motion.falloff[i] < 1e-7) ? 1 : 0;
                }
            }
            stillOf.set(motion, still);
        }
        return still;
    };

    const dataBytes = (splat: Splat) => {
        let n = 0;
        const data = splat.splatData as any;
        (data?.elements ?? []).forEach((el: any) => (el.properties ?? []).forEach((p: any) => {
            n += p.storage?.byteLength ?? 0;
        }));
        if (splat.motion) n += splat.motion.velocityTime.byteLength + splat.motion.falloff.byteLength;
        return n;
    };

    const measure = (op: StatsOp) => {
        const { splat } = op;
        const data = splat?.splatData;
        if (!data) return;
        const total = data.numSplats;
        const state = data.getProp('state') as Uint8Array;
        const px = data.getProp('x') as Float32Array;
        const py = data.getProp('y') as Float32Array;
        const pz = data.getProp('z') as Float32Array;
        const still = stillRows(splat);
        let live = 0, selected = 0, hidden = 0, stillLive = 0;
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < total; i++) {
            const s = state ? state[i] : 0;
            if (s & State.deleted) continue;
            live++;
            if (s & State.locked) hidden++;
            else if (s & State.selected) selected++;
            if (still?.[i]) stillLive++;
            const x = px[i], y = py[i], z = pz[i];
            if (x < min[0]) min[0] = x;
            if (y < min[1]) min[1] = y;
            if (z < min[2]) min[2] = z;
            if (x > max[0]) max[0] = x;
            if (y > max[1]) max[1] = y;
            if (z > max[2]) max[2] = z;
        }
        const key = frameKey(splat);
        op.snapshot = {
            total,
            live,
            selected,
            hidden,
            still: still ? stillLive : null,
            bytes: dataBytes(splat),
            min: live ? min : null,
            max: live ? max : null,
            key
        };
        // a PLY sequence shows its frames one at a time: keep each one's count
        if (!splat.motion && events.invoke('sequence.splat') === splat) {
            op.seen.set(key, live);
        }
        op.perFrame = null;
    };

    const makeStats = (splat: Splat) => {
        const op = new StatsOp(splat);
        op.measure = measure;
        return op;
    };

    events.on('graph.addStatsNode', (target?: Splat) => {
        addTarget(target).forEach(splat => appendAndOpen(makeStats(splat)));
    });

    events.function('stats.addNode', (splat: Splat, bypassed?: boolean) => {
        if (!splat) return null;
        const op = makeStats(splat);
        if (bypassed) op.bypassed = true;
        events.fire('edit.add', op);
        return op;
    });

    /**
     * Per frame of a 4D model: how many gaussians are drawn and how many
     * came and went since the frame before, for the gaussians live at the
     * node. Drawn means what the shader draws: in the active set, and not
     * faded below 1/255.
     */
    events.function('stats.perFrame', async (op: StatsOp): Promise<FrameChange[] | null> => {
        const { splat } = op;
        if (!splat?.motion || !(splat.motionFrames > 0)) return null;
        const { velocityTime, falloff, activeAt } = splat.motion;
        const frames = splat.motionFrames;
        const state = splat.splatData.getProp('state') as Uint8Array;
        const n = falloff.length;
        let prev: Uint8Array | null = null;
        const out: FrameChange[] = [];
        const cut = Math.log(255);
        for (let f = 0; f < frames; f++) {
            const t = f / frames;
            const drawn = new Uint8Array(n);
            const rows = activeAt ? activeAt(t) : null;
            let count = 0;
            const test = (i: number) => {
                if (state && (state[i] & State.deleted)) return;
                const dt = t - velocityTime[i * 4 + 3];
                if (dt * dt * falloff[i] > cut) return;
                drawn[i] = 1;
                count++;
            };
            if (rows) rows.forEach(test);
            else for (let i = 0; i < n; i++) test(i);
            let appeared = 0, gone = 0;
            if (prev) {
                for (let i = 0; i < n; i++) {
                    if (drawn[i] && !prev[i]) appeared++;
                    else if (!drawn[i] && prev[i]) gone++;
                }
            }
            out.push({ frame: f, drawn: count, appeared, gone });
            prev = drawn;
            if (f % 4 === 3) {
                await new Promise<void>((r) => {
                    setTimeout(r, 0);
                });
            }
        }
        op.perFrame = out;
        events.fire('edit.changed');
        return out;
    });
};

export { registerInspectNodes, frameKey };
