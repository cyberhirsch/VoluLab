/**
 * Workspace layout: a Blender-style tree of splits whose leaves are panes.
 * Each pane has a kind (its "editor type") switchable at runtime from the
 * pane's own header.
 *
 * Ported from Aerialist2's workspace model. The logic is framework-agnostic;
 * see ui/workspace-view.ts for the DOM/PCUI rendering of this tree.
 *
 * VoluLab constraint: exactly one pane may be the 3D viewport, because there
 * is a single WebGL canvas. `setPaneKind` enforces that by swapping kinds with
 * whichever pane currently holds the viewport.
 */

export type PaneKind =
    | 'viewport'
    | 'outliner'
    | 'transform'
    | 'timeline'
    | 'data'
    | 'settings'
    | 'color';

export const PANE_KINDS: { kind: PaneKind; label: string }[] = [
    { kind: 'viewport', label: 'viewport' },
    { kind: 'outliner', label: 'outliner' },
    { kind: 'transform', label: 'transform' },
    { kind: 'timeline', label: 'timeline' },
    { kind: 'data', label: 'splat data' },
    { kind: 'settings', label: 'settings' },
    { kind: 'color', label: 'color' }
];

// there is only one canvas, so only one pane can host it
export const SINGLETON_KINDS: PaneKind[] = ['viewport'];

export interface SplitNode {
    type: 'split';
    id: string;
    dir: 'row' | 'col';
    /** Fraction of space given to child `a` (0..1). */
    ratio: number;
    a: LayoutNode;
    b: LayoutNode;
}

export interface PaneNode {
    type: 'pane';
    id: string;
    kind: PaneKind;
}

export type LayoutNode = SplitNode | PaneNode;

let counter = 0;
export const paneId = (): string => `p${Date.now().toString(36)}${counter++}`;

export const pane = (kind: PaneKind): PaneNode => {
    return { type: 'pane', id: paneId(), kind };
};

/**
 * Three columns:
 *
 *   outliner    | viewport | color
 *   splat data  |          |
 *   transform   | timeline | settings
 */
export const defaultLayout = (): LayoutNode => {
    const left: LayoutNode = {
        type: 'split',
        id: paneId(),
        dir: 'col',
        ratio: 0.62,
        a: pane('outliner'),
        b: {
            type: 'split',
            id: paneId(),
            dir: 'col',
            ratio: 0.66,
            a: pane('data'),
            b: pane('transform')
        }
    };

    const centre: LayoutNode = {
        type: 'split',
        id: paneId(),
        dir: 'col',
        ratio: 0.88,
        a: pane('viewport'),
        b: pane('timeline')
    };

    const right: LayoutNode = {
        type: 'split',
        id: paneId(),
        dir: 'col',
        ratio: 0.5,
        a: pane('color'),
        b: pane('settings')
    };

    return {
        type: 'split',
        id: paneId(),
        dir: 'row',
        ratio: 0.13,
        a: left,
        b: {
            type: 'split',
            id: paneId(),
            dir: 'row',
            // the right column has to clear the settings label column plus a
            // control, so it gets a wider share than it looks like it needs
            ratio: 0.80,
            a: centre,
            b: right
        }
    };
};

export const listPanes = (node: LayoutNode): PaneNode[] => {
    if (node.type === 'pane') return [node];
    return [...listPanes(node.a), ...listPanes(node.b)];
};

export const findPane = (node: LayoutNode, id: string): PaneNode | null => {
    return listPanes(node).find(p => p.id === id) ?? null;
};

/** First pane of a kind, in visual (tree) order. */
export const firstPaneOfKind = (node: LayoutNode, kind: PaneKind): PaneNode | null => {
    return listPanes(node).find(p => p.kind === kind) ?? null;
};

const mapPane = (node: LayoutNode, fn: (p: PaneNode) => PaneNode): LayoutNode => {
    if (node.type === 'pane') return fn(node);
    return { ...node, a: mapPane(node.a, fn), b: mapPane(node.b, fn) };
};

/**
 * Assign a kind to a pane. A singleton kind (the viewport) can only live in
 * one pane, so the pane that previously held it inherits the target's old
 * kind rather than being left duplicated.
 */
export const setPaneKind = (node: LayoutNode, id: string, kind: PaneKind): LayoutNode => {
    const target = findPane(node, id);
    if (!target || target.kind === kind) return node;

    if (SINGLETON_KINDS.includes(kind)) {
        const holder = firstPaneOfKind(node, kind);
        if (holder && holder.id !== id) {
            const swapped = target.kind;
            return mapPane(node, (p) => {
                if (p.id === id) return { ...p, kind };
                if (p.id === holder.id) return { ...p, kind: swapped };
                return p;
            });
        }
    }

    return mapPane(node, p => (p.id === id ? { ...p, kind } : p));
};

export const setRatio = (node: LayoutNode, id: string, ratio: number): LayoutNode => {
    if (node.type === 'pane') return node;
    if (node.id === id) {
        return { ...node, ratio: Math.max(0.1, Math.min(0.9, ratio)) };
    }
    return { ...node, a: setRatio(node.a, id, ratio), b: setRatio(node.b, id, ratio) };
};

/** Split a pane in two; the new sibling inherits the pane's kind. */
export const splitPane = (node: LayoutNode, id: string, dir: 'row' | 'col'): LayoutNode => {
    if (node.type === 'pane') {
        if (node.id !== id) return node;
        // a singleton can't be duplicated - the new sibling falls back
        const siblingKind: PaneKind = SINGLETON_KINDS.includes(node.kind) ? 'outliner' : node.kind;
        return {
            type: 'split',
            id: paneId(),
            dir,
            ratio: 0.5,
            a: node,
            b: pane(siblingKind)
        };
    }
    return { ...node, a: splitPane(node.a, id, dir), b: splitPane(node.b, id, dir) };
};

/**
 * Remove a pane; its sibling takes the parent split's place. Closing the pane
 * that holds a singleton kind hands that kind to the surviving sibling, so the
 * viewport can never be closed out of existence.
 */
export const closePane = (root: LayoutNode, id: string): LayoutNode => {
    if (root.type === 'pane') return root;

    const target = findPane(root, id);
    if (!target) return root;

    const rescue = SINGLETON_KINDS.includes(target.kind) ? target.kind : null;

    // the surviving subtree adopts the rescued singleton in its first pane
    const promote = (survivor: LayoutNode): LayoutNode => {
        if (!rescue) return survivor;
        let done = false;
        return mapPane(survivor, (p) => {
            if (done) return p;
            done = true;
            return { ...p, kind: rescue };
        });
    };

    const walk = (node: LayoutNode): LayoutNode => {
        if (node.type === 'pane') return node;
        if (node.a.type === 'pane' && node.a.id === id) return promote(node.b);
        if (node.b.type === 'pane' && node.b.id === id) return promote(node.a);
        return { ...node, a: walk(node.a), b: walk(node.b) };
    };

    return walk(root);
};

/* ── persistence ─────────────────────────────────────────────── */

const STORAGE_KEY = 'volulab.layout.v1';

export const saveLayout = (root: LayoutNode) => {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(root));
    } catch (e) {
        // storage full/unavailable - layout just won't persist
    }
};

const isValidNode = (n: unknown): n is LayoutNode => {
    if (typeof n !== 'object' || n === null) return false;
    const node = n as Record<string, unknown>;
    if (node.type === 'pane') {
        return typeof node.id === 'string' && PANE_KINDS.some(k => k.kind === node.kind);
    }
    if (node.type === 'split') {
        return typeof node.id === 'string' &&
            (node.dir === 'row' || node.dir === 'col') &&
            typeof node.ratio === 'number' &&
            isValidNode(node.a) &&
            isValidNode(node.b);
    }
    return false;
};

export const loadLayout = (): LayoutNode | null => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as LayoutNode;
        if (!isValidNode(parsed)) return null;
        // a stored layout that lost its viewport would strand the canvas
        return firstPaneOfKind(parsed, 'viewport') ? parsed : null;
    } catch (e) {
        return null;
    }
};
