import { Container } from '@playcanvas/pcui';

import {
    LayoutNode,
    PaneKind,
    PaneNode,
    PANE_KINDS,
    SplitNode,
    closePane,
    defaultLayout,
    listPanes,
    loadLayout,
    saveLayout,
    setPaneKind,
    setRatio,
    splitPane
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
    close: 'm256-200-56-56 224-224-224-224 56-56 224 224 224-224 56 56-224 224 224 224-56 56-224-224-224 224Z'
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
    private root: LayoutNode;
    private content = new Map<PaneKind, HTMLElement>();
    private parked: HTMLElement;
    private onChange?: () => void;

    constructor(args: { onChange?: () => void } = {}) {
        super({ id: 'workspace' });

        this.onChange = args.onChange;
        this.root = loadLayout() ?? defaultLayout();

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

    private mutate(next: LayoutNode) {
        this.root = next;
        saveLayout(this.root);
        this.rebuild();
        this.onChange?.();
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

        // move each kind's element into the body of the pane claiming it
        listPanes(this.root).forEach((p) => {
            const el = this.content.get(p.kind);
            const body = this.dom.querySelector(`[data-pane-body="${p.id}"]`);
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
                this.root = setRatio(this.root, split.id, frac);
                saveLayout(this.root);
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
            this.mutate(setPaneKind(this.root, node.id, select.value as PaneKind));
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
            this.mutate(splitPane(this.root, node.id, 'row'));
        }));
        header.appendChild(button('ws-split-col', 'split stacked', 'split-col', () => {
            this.mutate(splitPane(this.root, node.id, 'col'));
        }));

        // never offer to close the last pane
        if (listPanes(this.root).length > 1) {
            header.appendChild(button('ws-close', 'close pane', 'close', () => {
                this.mutate(closePane(this.root, node.id));
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
