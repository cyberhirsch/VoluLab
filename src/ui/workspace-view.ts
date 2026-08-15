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
    closePane,
    defaultLayout,
    dockAllFloats,
    dockFloat,
    listPanes,
    loadLayout,
    saveLayout,
    setFloatRect,
    setPaneKind,
    setRatio,
    splitPane,
    undockPane
} from '../workspace';

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
    // open_in_new - pop the pane out into a floating window
    undock: 'M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h280v80H200v560h560v-280h80v280q0 33-23.5 56.5T760-120H200Zm188-212-56-56 372-372H560v-80h280v280h-80v-144L388-332Z',
    // close_fullscreen - put a floating window back in the tree
    dock: 'M441-441v240h-80v-160H201v-80h240Zm158-158v-160h80v80h160v80H599Zm-238 0v-240h80v160h160v80H361Zm238 398v-240h240v80H679v160h-80Z'
} as const;

const SVG_NS = 'http://www.w3.org/2000/svg';

const createIcon = (name: keyof typeof ICON_PATHS, size = 14) => {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 -960 960 960');
    svg.setAttribute('width', `${size}`);
    svg.setAttribute('height', `${size}`);
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');

    const path = document.createElementNS(SVG_NS, 'path');
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

    /** Update the tree only, leaving floating windows untouched. */
    private mutateRoot(next: LayoutNode) {
        this.mutate({ ...this.state, root: next });
    }

    /** Rebuild the pane chrome, then re-home the content elements. */
    rebuild() {
        // detach content first so removing the old chrome can't destroy it
        for (const el of this.content.values()) {
            this.parked.appendChild(el);
        }

        // clear previous chrome (everything except the parking area)
        [...this.dom.children].forEach((c) => {
            if (c !== this.parked) c.remove();
        });

        const tree = this.buildNode(this.root);
        tree.style.flex = '1 1 auto';
        tree.style.minWidth = '0';
        tree.style.minHeight = '0';
        this.dom.appendChild(tree);

        // move each docked kind's element into the pane claiming it
        listPanes(this.root).forEach((p) => {
            const el = this.content.get(p.kind);
            const body = this.dom.querySelector(`[data-pane-body="${p.id}"]`);
            if (el && body) body.appendChild(el);
        });

        this.syncWindows();
    }

    /** Open, populate and close detached windows to match the state. */
    private syncWindows() {
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
            let win = this.windows.get(float.id);
            if (!win || win.closed) {
                win = this.openWindow(float) ?? undefined;
                if (!win) {
                    // popup blocked - put the pane straight back rather than
                    // stranding its content in the parking area
                    queueMicrotask(() => this.mutate(dockFloat(this.state, float.id, id => this.paneArea(id))));
                    return;
                }
                this.windows.set(float.id, win);
            }

            const host = win.document.querySelector('.ws-detached-body');
            const el = this.content.get(float.kind);
            if (host && el && el.ownerDocument !== win.document) {
                host.appendChild(win.document.adoptNode(el));
            } else if (host && el && el.parentElement !== host) {
                host.appendChild(el);
            }

            const kindLabel = win.document.querySelector('.ws-detached-kind');
            if (kindLabel) {
                kindLabel.textContent = PANE_KINDS.find(k => k.kind === float.kind)?.label ?? float.kind;
            }
        });
    }

    private paneArea(paneId: string) {
        const p = this.dom.querySelector(`[data-pane-body="${paneId}"]`);
        if (!p) return 0;
        const r = p.getBoundingClientRect();
        return r.width * r.height;
    }

    /**
     * Open a detached window and build its document: the opener's stylesheets,
     * a host for the panel, and a small status bar with a dock-back button.
     */
    private openWindow(float: FloatNode): Window | null {
        const label = PANE_KINDS.find(k => k.kind === float.kind)?.label ?? float.kind;
        const features = [
            'popup=yes',
            `width=${float.width}`,
            `height=${float.height}`,
            `left=${float.x}`,
            `top=${float.y}`
        ].join(',');

        const win = window.open('', `volulab-${float.id}`, features);
        if (!win) return null;

        const doc = win.document;
        doc.title = `VoluLab - ${label}`;

        // Stylesheets are cloned from the opener. The href property is read
        // rather than the attribute so it is already absolute: the window is
        // about:blank, where a relative path would resolve to nothing.
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

        const body = doc.createElement('div');
        body.className = 'ws-detached-body';

        const status = doc.createElement('div');
        status.className = 'ws-detached-status';

        const kind = doc.createElement('span');
        kind.className = 'ws-detached-kind';
        kind.textContent = label;

        const spacer = doc.createElement('span');
        spacer.className = 'ws-detached-spacer';

        const dock = doc.createElement('button');
        dock.className = 'ws-detached-dock';
        dock.textContent = 'dock';
        dock.title = 'return this panel to the main window';
        dock.addEventListener('click', () => win.close());

        status.appendChild(kind);
        status.appendChild(spacer);
        status.appendChild(dock);

        doc.body.appendChild(body);
        doc.body.appendChild(status);

        // Closing the window docks the panel back. Its content must be adopted
        // home first or it dies with the document, so remember the size and
        // position the user left it at on the way out.
        win.addEventListener('pagehide', () => {
            if (!this.windows.has(float.id)) return;
            this.windows.delete(float.id);
            this.state = setFloatRect(this.state, float.id, {
                x: win.screenX,
                y: win.screenY,
                width: win.innerWidth,
                height: win.innerHeight
            });
            const el = this.content.get(float.kind);
            if (el) this.parked.appendChild(document.adoptNode(el));
            this.mutate(dockFloat(this.state, float.id, id => this.paneArea(id)));
        });

        return win;
    }

    private buildNode(node: LayoutNode): HTMLElement {
        return node.type === 'pane' ? this.buildPane(node) : this.buildSplit(node);
    }

    private buildSplit(split: SplitNode): HTMLElement {
        const isRow = split.dir === 'row';

        const el = document.createElement('div');
        el.className = 'ws-split';
        el.style.flexDirection = isRow ? 'row' : 'column';

        const a = this.buildNode(split.a);
        a.style.flex = `0 0 ${split.ratio * 100}%`;

        const divider = document.createElement('div');
        divider.className = `ws-divider ${isRow ? 'ws-divider-v' : 'ws-divider-h'}`;

        const b = this.buildNode(split.b);
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
                this.state = { ...this.state, root: setRatio(this.root, split.id, frac) };
                saveLayout(this.state);
                this.onChange?.();
            };

            divider.addEventListener('pointermove', move);
            divider.addEventListener('pointerup', up);
        });

        el.appendChild(a);
        el.appendChild(divider);
        el.appendChild(b);
        return el;
    }

    private buildPane(node: PaneNode): HTMLElement {
        const el = document.createElement('div');
        el.className = 'ws-pane';

        const header = document.createElement('div');
        header.className = 'ws-pane-header';

        const select = document.createElement('select');
        select.className = 'ws-pane-kind';
        PANE_KINDS.forEach(({ kind, label }) => {
            const opt = document.createElement('option');
            opt.value = kind;
            opt.textContent = label;
            select.appendChild(opt);
        });
        select.value = node.kind;
        select.addEventListener('change', () => {
            this.mutateRoot(setPaneKind(this.root, node.id, select.value as PaneKind));
        });

        const spacer = document.createElement('div');
        spacer.className = 'ws-pane-spacer';

        const button = (cls: string, title: string, glyph: keyof typeof ICON_PATHS, fn: () => void) => {
            const b = document.createElement('button');
            b.className = `ws-pane-button ${cls}`;
            b.title = title;
            b.appendChild(createIcon(glyph));
            b.addEventListener('click', fn);
            return b;
        };

        header.appendChild(select);
        header.appendChild(spacer);
        header.appendChild(button('ws-split-row', 'split side by side', 'split-row', () => {
            this.mutateRoot(splitPane(this.root, node.id, 'row'));
        }));
        header.appendChild(button('ws-split-col', 'split stacked', 'split-col', () => {
            this.mutateRoot(splitPane(this.root, node.id, 'col'));
        }));

        // undocking and closing both need a pane to fall back to, and the
        // viewport never leaves the main window
        if (listPanes(this.root).length > 1) {
            if (!SINGLETON_KINDS.includes(node.kind)) {
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
                this.mutateRoot(closePane(this.root, node.id));
            }));
        }

        const body = document.createElement('div');
        body.className = 'ws-pane-body';
        body.setAttribute('data-pane-body', node.id);

        el.appendChild(header);
        el.appendChild(body);
        return el;
    }
}

export { WorkspaceView };
