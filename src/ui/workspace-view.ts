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
    closeFloat,
    closePane,
    defaultLayout,
    dockFloat,
    listPanes,
    listSurfaces,
    loadLayout,
    raiseFloat,
    saveLayout,
    setFloatKind,
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

    private get root() {
        return this.state.root;
    }

    constructor(args: { onChange?: () => void } = {}) {
        super({ id: 'workspace' });

        this.onChange = args.onChange;
        this.state = loadLayout() ?? { root: defaultLayout(), floats: [] };

        // content belonging to no visible pane lives here, off-screen but
        // still in the document so it keeps its size and GL context
        this.parked = document.createElement('div');
        this.parked.id = 'workspace-parked';
        this.dom.appendChild(this.parked);

        // Canvas resize is handled upstream: Scene observes #canvas-container
        // directly (see scene.ts), and that is the element the pane body
        // resizes, so splits and divider drags propagate without help here.
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

        // floating windows sit above the tree, in list order
        this.state.floats.forEach(f => this.dom.appendChild(this.buildFloat(f)));

        // move each kind's element into the surface claiming it, docked or not
        listSurfaces(this.state).forEach(({ id, kind }) => {
            const el = this.content.get(kind);
            const body = this.dom.querySelector(`[data-pane-body="${id}"]`);
            if (el && body) body.appendChild(el);
        });
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

        // undocking and closing both need a pane to fall back to
        if (listPanes(this.root).length > 1) {
            header.appendChild(button('ws-undock', 'undock into a window', 'undock', () => {
                // open the window over the pane it came from, nudged clear so
                // it reads as having lifted off rather than replaced it
                const paneRect = el.getBoundingClientRect();
                const host = this.dom.getBoundingClientRect();
                this.mutate(undockPane(this.state, node.id, {
                    x: paneRect.left - host.left + 24,
                    y: paneRect.top - host.top + 24,
                    width: paneRect.width,
                    height: paneRect.height
                }));
            }));
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

    /** A floating window: same header vocabulary, plus drag and resize. */
    private buildFloat(float: FloatNode): HTMLElement {
        const el = document.createElement('div');
        el.className = 'ws-float';
        el.style.left = `${float.x}px`;
        el.style.top = `${float.y}px`;
        el.style.width = `${float.width}px`;
        el.style.height = `${float.height}px`;

        // clicking anywhere in the window brings it to the front
        el.addEventListener('pointerdown', () => {
            if (this.state.floats[this.state.floats.length - 1]?.id !== float.id) {
                this.mutate(raiseFloat(this.state, float.id));
            }
        }, true);

        const header = document.createElement('div');
        header.className = 'ws-pane-header ws-float-header';

        const select = document.createElement('select');
        select.className = 'ws-pane-kind';
        PANE_KINDS.forEach(({ kind, label }) => {
            const opt = document.createElement('option');
            opt.value = kind;
            opt.textContent = label;
            select.appendChild(opt);
        });
        select.value = float.kind;
        select.addEventListener('change', () => {
            this.mutate(setFloatKind(this.state, float.id, select.value as PaneKind));
        });
        // the select must not start a window drag
        select.addEventListener('pointerdown', e => e.stopPropagation());

        const spacer = document.createElement('div');
        spacer.className = 'ws-pane-spacer';

        const button = (cls: string, title: string, glyph: keyof typeof ICON_PATHS, fn: () => void) => {
            const b = document.createElement('button');
            b.className = `ws-pane-button ${cls}`;
            b.title = title;
            b.appendChild(createIcon(glyph));
            b.addEventListener('pointerdown', e => e.stopPropagation());
            b.addEventListener('click', fn);
            return b;
        };

        header.appendChild(select);
        header.appendChild(spacer);
        header.appendChild(button('ws-dock', 'dock back into the layout', 'dock', () => {
            this.mutate(dockFloat(this.state, float.id, (paneId) => {
                const p = this.dom.querySelector(`[data-pane-body="${paneId}"]`);
                if (!p) return 0;
                const r = p.getBoundingClientRect();
                return r.width * r.height;
            }));
        }));

        // a floating singleton has nowhere to go if closed, so it can only dock
        if (!SINGLETON_KINDS.includes(float.kind)) {
            header.appendChild(button('ws-close', 'close window', 'close', () => {
                this.mutate(closeFloat(this.state, float.id));
            }));
        }

        // drag the header to move the window
        header.addEventListener('pointerdown', (e: PointerEvent) => {
            e.preventDefault();
            header.setPointerCapture(e.pointerId);
            const host = this.dom.getBoundingClientRect();
            const grabX = e.clientX - host.left - float.x;
            const grabY = e.clientY - host.top - float.y;

            const move = (ev: PointerEvent) => {
                // keep the header on screen: the window can hang off the right
                // and bottom, but never be dragged out of reach
                const x = Math.min(Math.max(0, ev.clientX - host.left - grabX), host.width - 60);
                const y = Math.min(Math.max(0, ev.clientY - host.top - grabY), host.height - 24);
                el.style.left = `${Math.round(x)}px`;
                el.style.top = `${Math.round(y)}px`;
            };

            const up = (ev: PointerEvent) => {
                header.releasePointerCapture(ev.pointerId);
                header.removeEventListener('pointermove', move);
                header.removeEventListener('pointerup', up);
                this.state = setFloatRect(this.state, float.id, {
                    x: parseFloat(el.style.left),
                    y: parseFloat(el.style.top)
                });
                saveLayout(this.state);
            };

            header.addEventListener('pointermove', move);
            header.addEventListener('pointerup', up);
        });

        const body = document.createElement('div');
        body.className = 'ws-pane-body';
        body.setAttribute('data-pane-body', float.id);

        const grip = document.createElement('div');
        grip.className = 'ws-float-resize';
        grip.addEventListener('pointerdown', (e: PointerEvent) => {
            e.preventDefault();
            e.stopPropagation();
            grip.setPointerCapture(e.pointerId);
            const startX = e.clientX, startY = e.clientY;
            const startW = float.width, startH = float.height;

            const move = (ev: PointerEvent) => {
                el.style.width = `${Math.max(220, startW + ev.clientX - startX)}px`;
                el.style.height = `${Math.max(120, startH + ev.clientY - startY)}px`;
            };

            const up = (ev: PointerEvent) => {
                grip.releasePointerCapture(ev.pointerId);
                grip.removeEventListener('pointermove', move);
                grip.removeEventListener('pointerup', up);
                this.state = setFloatRect(this.state, float.id, {
                    width: parseFloat(el.style.width),
                    height: parseFloat(el.style.height)
                });
                saveLayout(this.state);
                this.onChange?.();
            };

            grip.addEventListener('pointermove', move);
            grip.addEventListener('pointerup', up);
        });

        el.appendChild(header);
        el.appendChild(body);
        el.appendChild(grip);
        return el;
    }
}

export { WorkspaceView };
