import { Container } from '@playcanvas/pcui';

import {
    FloatNode,
    LayoutNode,
    PaneKind,
    PaneNode,
    PANE_KINDS,
    SINGLETON_KINDS,
    SplitNode,
    WorkspaceState,
    assignKind,
    closePane,
    defaultLayout,
    dockAllFloats,
    dockFloat,
    listPanes,
    listSurfaces,
    loadLayout,
    mapFloatRoot,
    saveLayout,
    setFloatRect,
    setRatio,
    splitPane,
    undockPane
} from '../workspace';
import { contributedMenuItems, showContextMenu } from './context-menu';

/**
 * Somewhere a layout tree is rendered: the main window, or one detached window.
 *
 * Panes are built against a surface rather than against `document` directly,
 * because a detached window has to build its chrome in its own document and
 * route its edits into its own branch of the state.
 */
interface Surface {
    doc: Document;
    /** the tree being rendered right now */
    root: LayoutNode;
    /** apply a tree edit to whatever this surface holds in live state */
    edit: (fn: (root: LayoutNode) => LayoutNode) => void;
    /** the same, without a rebuild - for a divider drag that already painted */
    editQuiet: (fn: (root: LayoutNode) => LayoutNode) => void;
    setKind: (paneId: string, kind: PaneKind) => void;
    /** kinds offered in the pane selector */
    kinds: { kind: PaneKind; label: string }[];
    /** only the main window hands panes out to new windows */
    canUndock: boolean;
}

/**
 * Pane-header glyphs, vendored as raw path data from Google's Material Symbols
 * (Outlined) - the same subset Aerialist2 uses, so the headers match. Kept as
 * paths rather than a font so there is no runtime font or network request, and
 * drawn with fill="currentColor" so they follow the ink-* text colour.
 */
const ICON_PATHS = {
    'split-row': 'M120-360v-80h320v80H120Zm0 160v-80h320v80H120Zm0-320v-80h320v80H120Zm0-160v-80h320v80H120Zm480 480q-33 0-56.5-23.5T520-280v-400q0-33 23.5-56.5T600-760h160q33 0 56.5 23.5T840-680v400q0 33-23.5 56.5T760-200H600Zm0-80h160v-400H600v400Zm80-200Z',
    'split-col': 'M120-200v-240h720v240H120Zm0-320v-80h720v80H120Zm0-160v-80h720v80H120Z',
    close: 'm256-200-56-56 224-224-224-224 56-56 224 224 224-224 56 56-224 224 224 224-56 56-224-224-224 224Z',
    // open_in_new - pop the pane out into a separate window
    undock: 'M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h280v80H200v560h560v-280h80v280q0 33-23.5 56.5T760-120H200Zm188-212-56-56 372-372H560v-80h280v280h-80v-144L388-332Z'
} as const;

const SVG_NS = 'http://www.w3.org/2000/svg';

// takes a document so detached windows can build icons in their own
const createIconIn = (doc: Document, name: keyof typeof ICON_PATHS, size = 14) => {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 -960 960 960');
    svg.setAttribute('width', `${size}`);
    svg.setAttribute('height', `${size}`);
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');

    const path = doc.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', ICON_PATHS[name]);
    svg.appendChild(path);
    return svg;
};

/**
 * Renders a workspace layout tree into DOM, after Aerialist2's WorkspaceView.
 *
 * Each leaf pane gets a header - a kind selector plus split/close buttons -
 * and a body. Content is not rebuilt when the layout changes: each pane kind
 * owns one long-lived element, registered up front, which is moved into
 * whichever pane body currently claims that kind. That keeps PCUI wiring,
 * event handlers and the WebGL canvas intact across splits and re-assignments.
 */
class WorkspaceView extends Container {
    private state: WorkspaceState;
    private content = new Map<PaneKind, HTMLElement>();
    private parked: HTMLElement;
    private onChange?: () => void;

    /** Open detached windows, keyed by float id. */
    private windows = new Map<string, Window>();

    private get root() {
        return this.state.root;
    }

    constructor(args: { onChange?: () => void } = {}) {
        super({ id: 'workspace' });

        this.onChange = args.onChange;

        const loaded = loadLayout();
        // A detached window cannot be reopened on load: window.open outside a
        // user gesture is blocked. Rather than keep a record pointing at a
        // window that does not exist, dock everything back and start clean.
        this.state = loaded ?
            dockAllFloats(loaded, () => 1) :
            { root: defaultLayout(), floats: [] };

        // content belonging to no visible pane lives here, off-screen but
        // still in the document so it keeps its size and GL context
        this.parked = document.createElement('div');
        this.parked.id = 'workspace-parked';
        this.dom.appendChild(this.parked);

        // a detached window is a child of this page: if the page goes, so do
        // they, and their content has to come home first or it is destroyed
        window.addEventListener('pagehide', () => this.closeAllWindows());

        // Canvas resize is handled upstream: Scene observes #canvas-container
        // directly (see scene.ts), and that is the element the pane body
        // resizes, so splits and divider drags propagate without help here.
    }

    private closeAllWindows() {
        this.windows.forEach((win) => {
            try {
                win.close();
            } catch (e) {
                // already gone
            }
        });
        this.windows.clear();
    }

    /** Register the element that renders a given pane kind. */
    register(kind: PaneKind, element: HTMLElement) {
        this.content.set(kind, element);
        this.parked.appendChild(element);
    }

    private mutate(next: WorkspaceState) {
        this.state = next;
        saveLayout(this.state);
        this.rebuild();
        this.onChange?.();
    }

    /** Update the docked tree only, leaving detached windows untouched. */
    private mutateRoot(next: LayoutNode) {
        this.mutate({ ...this.state, root: next });
    }

    /** Record a state change and persist it, but leave the DOM alone. */
    private quiet(next: WorkspaceState) {
        this.state = next;
        saveLayout(this.state);
        this.onChange?.();
    }

    /** The main window as a surface. */
    private mainSurface(): Surface {
        return {
            doc: document,
            root: this.root,
            edit: fn => this.mutateRoot(fn(this.root)),
            editQuiet: fn => this.quiet({ ...this.state, root: fn(this.root) }),
            setKind: (id, kind) => this.mutate(assignKind(this.state, id, kind)),
            kinds: PANE_KINDS,
            canUndock: true
        };
    }

    /** One detached window as a surface. */
    private floatSurface(win: Window, float: FloatNode): Surface {
        return {
            doc: win.document,
            root: float.root,
            edit: fn => this.mutate(mapFloatRoot(this.state, float.id, fn)),
            editQuiet: fn => this.quiet(mapFloatRoot(this.state, float.id, fn)),
            setKind: (id, kind) => this.mutate(assignKind(this.state, id, kind)),
            // the viewport cannot be detached, so it is not on offer out here
            kinds: PANE_KINDS.filter(k => !SINGLETON_KINDS.includes(k.kind)),
            canUndock: false
        };
    }

    /**
     * Which pane each kind's element belongs to, first claim winning, docked
     * panes before detached ones.
     *
     * There is exactly one element per kind, so when two panes ask for the same
     * kind - which a split briefly produces - only one can be served. Deciding
     * it here rather than at insertion time keeps the main window and every
     * detached window from tugging the same element back and forth.
     */
    private claims(): Map<PaneKind, string> {
        const m = new Map<PaneKind, string>();
        listSurfaces(this.state).forEach((p) => {
            if (!m.has(p.kind)) m.set(p.kind, p.id);
        });
        return m;
    }

    /** Put each kind's element in the pane that claimed it, within one root. */
    private homeContent(host: HTMLElement | Document, root: LayoutNode, claims: Map<PaneKind, string>) {
        listPanes(root).forEach((p) => {
            if (claims.get(p.kind) !== p.id) return;
            const el = this.content.get(p.kind);
            const body = host.querySelector(`[data-pane-body="${p.id}"]`);
            // appendChild adopts across documents, so this also moves an
            // element that was living in a window it no longer belongs to
            if (el && body) body.appendChild(el);
        });
    }

    /** Rebuild the pane chrome, then re-home the content elements. */
    rebuild() {
        // Park content first so removing the old chrome can't destroy it, but
        // only what lives in this document: a detached window parks its own,
        // otherwise every edit here would drag its panel home and straight back.
        for (const el of this.content.values()) {
            if (el.ownerDocument === document) this.parked.appendChild(el);
        }

        // clear previous chrome (everything except the parking area)
        [...this.dom.children].forEach((c) => {
            if (c !== this.parked) c.remove();
        });

        const tree = this.buildNode(this.mainSurface(), this.root);
        tree.style.flex = '1 1 auto';
        tree.style.minWidth = '0';
        tree.style.minHeight = '0';
        this.dom.appendChild(tree);

        const claims = this.claims();
        this.homeContent(this.dom, this.root, claims);
        this.syncWindows(claims);
    }

    /** Open, render and close detached windows to match the state. */
    private syncWindows(claims: Map<PaneKind, string>) {
        // close windows whose float is gone
        [...this.windows.keys()].forEach((id) => {
            if (!this.state.floats.some(f => f.id === id)) {
                const win = this.windows.get(id);
                this.windows.delete(id);
                try {
                    win?.close();
                } catch (e) {
                    // already gone
                }
            }
        });

        this.state.floats.forEach((float) => {
            const existing = this.windows.get(float.id);
            if (existing && !existing.closed) {
                this.renderWindow(existing, float, claims);
                return;
            }

            // requestWindow is async, so this has to stay in the click's task
            // to keep the user gesture that both it and window.open require
            this.openWindow(float).then((win) => {
                if (!win) {
                    // blocked - put the pane straight back rather than
                    // stranding its content in the parking area
                    this.mutate(dockFloat(this.state, float.id, id => this.paneArea(id)));
                    return;
                }
                // the float may have been docked or edited while we waited, so
                // render what state says now rather than the snapshot we opened
                const live = this.state.floats.find(f => f.id === float.id);
                if (!live) {
                    win.close();
                    return;
                }
                this.windows.set(float.id, win);
                this.renderWindow(win, live, this.claims());
            });
        });
    }

    /** Build a detached window's pane chrome and move its panels in. */
    private renderWindow(win: Window, float: FloatNode, claims: Map<PaneKind, string>) {
        const doc = win.document;
        const parked = doc.querySelector('#workspace-parked');
        if (!parked) return;

        // park this window's own content before the chrome holding it goes
        for (const el of this.content.values()) {
            if (el.ownerDocument === doc) parked.appendChild(el);
        }
        [...doc.body.children].forEach((c) => {
            if (c !== parked) c.remove();
        });

        const tree = this.buildNode(this.floatSurface(win, float), float.root);
        tree.style.flex = '1 1 auto';
        tree.style.minWidth = '0';
        tree.style.minHeight = '0';
        doc.body.appendChild(tree);

        this.homeContent(doc, float.root, claims);

        // the window is small and the browser truncates anyway, so name it
        // after what it holds and only count when it holds more than one thing
        const panes = listPanes(float.root);
        const label = panes.length === 1 ?
            (PANE_KINDS.find(k => k.kind === panes[0].kind)?.label ?? panes[0].kind) :
            `volulab (${panes.length})`;
        if (doc.title !== label) doc.title = label;
    }

    private paneArea(paneId: string) {
        const p = this.dom.querySelector(`[data-pane-body="${paneId}"]`);
        if (!p) return 0;
        const r = p.getBoundingClientRect();
        return r.width * r.height;
    }

    /**
     * Open a detached window and prepare its document: the opener's
     * stylesheets and a parking area. The pane chrome itself is built by
     * renderWindow, exactly as it is in the main window.
     *
     * Document Picture-in-Picture is preferred because its window has no
     * address bar or tab strip, only a thin title bar - a plain popup spends
     * ~60px of a small panel's height telling you it is at about:blank. Only
     * one PiP window may exist at a time, so anything beyond the first falls
     * back to window.open.
     */
    private async openWindow(float: FloatNode): Promise<Window | null> {
        let win: Window | null = null;

        const pip = (window as any).documentPictureInPicture;
        if (pip?.requestWindow && !pip.window) {
            try {
                win = await pip.requestWindow({
                    width: float.width,
                    height: float.height,
                    disallowReturnToOpener: true
                });
            } catch (e) {
                // denied or unsupported options - fall through to a popup
                win = null;
            }
        }

        if (!win) {
            const features = [
                'popup=yes',
                `width=${float.width}`,
                `height=${float.height}`,
                `left=${float.x}`,
                `top=${float.y}`
            ].join(',');
            win = window.open('', `volulab-${float.id}`, features);
        }

        if (!win) return null;

        const doc = win.document;

        // Stylesheets are cloned from the opener. The href property is read
        // rather than the attribute so it is already absolute: a detached
        // window has no useful base URL for a relative path to resolve against.
        document.querySelectorAll('link[rel="stylesheet"]').forEach((node) => {
            const link = doc.createElement('link');
            link.rel = 'stylesheet';
            link.href = (node as HTMLLinkElement).href;
            doc.head.appendChild(link);
        });
        document.querySelectorAll('style').forEach((node) => {
            const style = doc.createElement('style');
            style.textContent = node.textContent;
            doc.head.appendChild(style);
        });

        doc.body.className = 'ws-detached';

        // content this window owns but no pane of its own currently claims -
        // the same trick the main window plays with #workspace-parked
        const parked = doc.createElement('div');
        parked.id = 'workspace-parked';
        doc.body.appendChild(parked);

        // Closing the window docks its panes back. There is no button for it:
        // the window's own close is the obvious gesture and a detached panel is
        // small enough that a button it doesn't need is a button in the way.
        // Content must come home before the document dies, so remember the size
        // and position the user left it at on the way out.
        win.addEventListener('pagehide', () => {
            if (!this.windows.has(float.id)) return;
            this.windows.delete(float.id);
            this.state = setFloatRect(this.state, float.id, {
                x: win.screenX,
                y: win.screenY,
                width: win.innerWidth,
                height: win.innerHeight
            });
            for (const el of this.content.values()) {
                if (el.ownerDocument === doc) this.parked.appendChild(document.adoptNode(el));
            }
            this.mutate(dockFloat(this.state, float.id, id => this.paneArea(id)));
        });

        return win;
    }

    private buildNode(s: Surface, node: LayoutNode): HTMLElement {
        return node.type === 'pane' ? this.buildPane(s, node) : this.buildSplit(s, node);
    }

    private buildSplit(s: Surface, split: SplitNode): HTMLElement {
        const isRow = split.dir === 'row';

        const el = s.doc.createElement('div');
        el.className = 'ws-split';
        el.style.flexDirection = isRow ? 'row' : 'column';

        const a = this.buildNode(s, split.a);
        a.style.flex = `0 0 ${split.ratio * 100}%`;

        const divider = s.doc.createElement('div');
        divider.className = `ws-divider ${isRow ? 'ws-divider-v' : 'ws-divider-h'}`;

        const b = this.buildNode(s, split.b);
        b.style.flex = '1 1 0';

        divider.addEventListener('pointerdown', (e: PointerEvent) => {
            e.preventDefault();
            divider.setPointerCapture(e.pointerId);
            const rect = el.getBoundingClientRect();

            const move = (ev: PointerEvent) => {
                const frac = isRow ?
                    (ev.clientX - rect.left) / rect.width :
                    (ev.clientY - rect.top) / rect.height;
                // live feedback without a full rebuild
                const clamped = Math.max(0.1, Math.min(0.9, frac));
                a.style.flex = `0 0 ${clamped * 100}%`;
            };

            const up = (ev: PointerEvent) => {
                divider.releasePointerCapture(ev.pointerId);
                divider.removeEventListener('pointermove', move);
                divider.removeEventListener('pointerup', up);
                const frac = isRow ?
                    (ev.clientX - rect.left) / rect.width :
                    (ev.clientY - rect.top) / rect.height;
                // the drag already painted the result, so don't rebuild over it
                s.editQuiet(root => setRatio(root, split.id, frac));
            };

            divider.addEventListener('pointermove', move);
            divider.addEventListener('pointerup', up);
        });

        el.appendChild(a);
        el.appendChild(divider);
        el.appendChild(b);
        return el;
    }

    /**
     * A kind nothing is showing yet, so a fresh half of a split has something
     * of its own to display rather than fighting its sibling for one element.
     */
    private freeKind(fallback: PaneKind): PaneKind {
        const taken = new Set(listSurfaces(this.state).map(p => p.kind));
        const free = PANE_KINDS.find(k => !SINGLETON_KINDS.includes(k.kind) && !taken.has(k.kind));
        return free?.kind ?? fallback;
    }

    private buildPane(s: Surface, node: PaneNode): HTMLElement {
        const doc = s.doc;

        const el = doc.createElement('div');
        el.className = 'ws-pane';

        const header = doc.createElement('div');
        header.className = 'ws-pane-header';

        const select = doc.createElement('select');
        select.className = 'ws-pane-kind';
        s.kinds.forEach(({ kind, label }) => {
            const opt = doc.createElement('option');
            opt.value = kind;
            opt.textContent = label;
            select.appendChild(opt);
        });
        select.value = node.kind;
        select.addEventListener('change', () => {
            s.setKind(node.id, select.value as PaneKind);
        });

        const spacer = doc.createElement('div');
        spacer.className = 'ws-pane-spacer';

        const button = (cls: string, title: string, glyph: keyof typeof ICON_PATHS, fn: () => void) => {
            const b = doc.createElement('button');
            b.className = `ws-pane-button ${cls}`;
            b.title = title;
            b.appendChild(createIconIn(doc, glyph));
            b.addEventListener('click', fn);
            return b;
        };

        const split = (dir: 'row' | 'col') => {
            s.edit(root => splitPane(root, node.id, dir, this.freeKind(node.kind)));
        };

        header.appendChild(select);
        header.appendChild(spacer);
        header.appendChild(button('ws-split-row', 'split side by side', 'split-row', () => split('row')));
        header.appendChild(button('ws-split-col', 'split stacked', 'split-col', () => split('col')));

        // undocking and closing both need a pane to fall back to, and the
        // viewport never leaves the main window
        if (listPanes(s.root).length > 1) {
            if (s.canUndock && !SINGLETON_KINDS.includes(node.kind)) {
                header.appendChild(button('ws-undock', 'open in a separate window', 'undock', () => {
                    // open over the pane it came from, in screen coordinates
                    const paneRect = el.getBoundingClientRect();
                    this.mutate(undockPane(this.state, node.id, {
                        x: window.screenX + paneRect.left,
                        y: window.screenY + paneRect.top,
                        width: Math.round(paneRect.width),
                        height: Math.round(paneRect.height)
                    }));
                }));
            }
            header.appendChild(button('ws-close', 'close pane', 'close', () => {
                s.edit(root => closePane(root, node.id));
            }));
        }

        const body = doc.createElement('div');
        body.className = 'ws-pane-body';
        body.setAttribute('data-pane-body', node.id);

        // Right-click anywhere in the pane offers what the header offers. The
        // handler sits on the pane rather than on the app so it works in a
        // detached window too, and content that wants its own menu simply
        // stops the event before it reaches here.
        el.addEventListener('contextmenu', (e: MouseEvent) => {
            e.preventDefault();
            const last = listPanes(s.root).length <= 1;
            // whatever the pointer was over gets to go first - its items are
            // the specific ones, the pane's are the general fallback
            const contributed = contributedMenuItems(e);
            showContextMenu(doc, e.clientX, e.clientY, [
                ...(contributed.length ? [...contributed, 'separator' as const] : []),
                {
                    label: 'split side by side',
                    action: () => split('row')
                },
                {
                    label: 'split stacked',
                    action: () => split('col')
                },
                'separator',
                {
                    label: 'open in a separate window',
                    disabled: last || !s.canUndock || SINGLETON_KINDS.includes(node.kind),
                    action: () => {
                        const paneRect = el.getBoundingClientRect();
                        this.mutate(undockPane(this.state, node.id, {
                            x: window.screenX + paneRect.left,
                            y: window.screenY + paneRect.top,
                            width: Math.round(paneRect.width),
                            height: Math.round(paneRect.height)
                        }));
                    }
                },
                {
                    label: 'close pane',
                    disabled: last,
                    hint: last ? 'last pane' : undefined,
                    action: () => s.edit(root => closePane(root, node.id))
                }
            ]);
        });

        el.appendChild(header);
        el.appendChild(body);
        return el;
    }
}

export { WorkspaceView };
