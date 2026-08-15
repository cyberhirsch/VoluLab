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

/**
 * A pane that has been pulled out into its own browser window.
 *
 * x/y are screen coordinates and width/height the window's inner size, so the
 * window can be reopened where the user left it. The viewport is never
 * detached: its WebGL context would have to survive being adopted into another
 * document, which is not worth betting on - see SINGLETON_KINDS.
 */
export interface FloatNode {
    type: 'float';
    id: string;
    kind: PaneKind;
    x: number;
    y: number;
    width: number;
    height: number;
}

/** The docked tree plus whatever has been floated out of it. */
export interface WorkspaceState {
    root: LayoutNode;
    floats: FloatNode[];
}

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

/** Is a kind on screen at all - docked or floating? */
export const kindIsPresent = (state: WorkspaceState, kind: PaneKind): boolean => {
    return !!firstPaneOfKind(state.root, kind) || state.floats.some(f => f.kind === kind);
};

/** Every visible surface, docked or floating, as id/kind pairs. */
export const listSurfaces = (state: WorkspaceState): { id: string; kind: PaneKind }[] => {
    return [
        ...listPanes(state.root).map(p => ({ id: p.id, kind: p.kind })),
        ...state.floats.map(f => ({ id: f.id, kind: f.kind }))
    ];
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
 * Remove a pane; its sibling takes the parent split's place.
 *
 * `rescueKind` is the kind that must not be lost - normally the singleton the
 * closing pane holds. Undocking passes null, because the kind is not being
 * destroyed there, it is moving to a floating window.
 */
export const closePane = (root: LayoutNode, id: string, rescueSingleton = true): LayoutNode => {
    if (root.type === 'pane') return root;

    const target = findPane(root, id);
    if (!target) return root;

    const rescue = (rescueSingleton && SINGLETON_KINDS.includes(target.kind)) ? target.kind : null;

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

/* ── floating windows ────────────────────────────────────────── */

const FLOAT_MIN_W = 220;
const FLOAT_MIN_H = 120;

/** Pull a pane out of the tree into a floating window at the given rect. */
export const undockPane = (
    state: WorkspaceState,
    id: string,
    rect: { x: number; y: number; width: number; height: number }
): WorkspaceState => {
    const target = findPane(state.root, id);
    if (!target) return state;

    // the viewport stays in the main window - moving a live WebGL canvas into
    // another document is not something to rely on
    if (SINGLETON_KINDS.includes(target.kind)) return state;

    // the last docked pane has to stay: detaching everything would leave the
    // tree with nothing to render and no way to drop a window back in
    if (listPanes(state.root).length < 2) return state;

    return {
        // rescue is off: the kind is not disappearing, it is moving to a float
        root: closePane(state.root, id, false),
        floats: [...state.floats, {
            type: 'float',
            id: paneId(),
            kind: target.kind,
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.max(FLOAT_MIN_W, Math.round(rect.width)),
            height: Math.max(FLOAT_MIN_H, Math.round(rect.height))
        }]
    };
};

/** Largest docked pane by area - where a re-docked window lands. */
const largestPane = (root: LayoutNode, areaOf: (id: string) => number): PaneNode | null => {
    const panes = listPanes(root);
    if (!panes.length) return null;
    return panes.reduce((best, p) => (areaOf(p.id) > areaOf(best.id) ? p : best), panes[0]);
};

/**
 * Put a floating window back in the tree by splitting the largest docked pane,
 * which is the least disruptive place to land and is predictable to the user.
 */
export const dockFloat = (
    state: WorkspaceState,
    id: string,
    areaOf: (paneId: string) => number
): WorkspaceState => {
    const float = state.floats.find(f => f.id === id);
    if (!float) return state;

    const host = largestPane(state.root, areaOf);
    if (!host) return state;

    // split the host along its longer axis so neither half becomes a sliver
    const dir = 'col';
    let root = splitPane(state.root, host.id, dir);
    // splitPane gives the new sibling the host's kind; set it to the float's
    const added = listPanes(root).find(p => !listPanes(state.root).some(o => o.id === p.id));
    if (added) root = setPaneKind(root, added.id, float.kind);

    return { root, floats: state.floats.filter(f => f.id !== id) };
};

export const setFloatRect = (
    state: WorkspaceState,
    id: string,
    rect: Partial<{ x: number; y: number; width: number; height: number }>
): WorkspaceState => {
    return {
        ...state,
        floats: state.floats.map(f => (f.id === id ? {
            ...f,
            x: rect.x !== undefined ? Math.round(rect.x) : f.x,
            y: rect.y !== undefined ? Math.round(rect.y) : f.y,
            width: rect.width !== undefined ? Math.max(FLOAT_MIN_W, Math.round(rect.width)) : f.width,
            height: rect.height !== undefined ? Math.max(FLOAT_MIN_H, Math.round(rect.height)) : f.height
        } : f))
    };
};

/**
 * Assign a kind to a detached window. No singleton juggling is needed here:
 * the viewport is never offered in a detached window's selector, because it
 * cannot leave the main window in the first place.
 */
export const setFloatKind = (state: WorkspaceState, id: string, kind: PaneKind): WorkspaceState => {
    if (SINGLETON_KINDS.includes(kind)) return state;
    return {
        ...state,
        floats: state.floats.map(f => (f.id === id ? { ...f, kind } : f))
    };
};

/** Dock every detached window back into the tree. */
export const dockAllFloats = (
    state: WorkspaceState,
    areaOf: (paneId: string) => number
): WorkspaceState => {
    return state.floats.reduce((acc, f) => dockFloat(acc, f.id, areaOf), state);
};

/* ── persistence ─────────────────────────────────────────────── */

const STORAGE_KEY = 'volulab.layout.v2';

export const saveLayout = (state: WorkspaceState) => {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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

const isValidFloat = (n: unknown): n is FloatNode => {
    if (typeof n !== 'object' || n === null) return false;
    const f = n as Record<string, unknown>;
    return f.type === 'float' &&
        typeof f.id === 'string' &&
        PANE_KINDS.some(k => k.kind === f.kind) &&
        ['x', 'y', 'width', 'height'].every(k => typeof f[k] === 'number' && isFinite(f[k] as number));
};

export const loadLayout = (): WorkspaceState | null => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as WorkspaceState;
        if (!parsed || !isValidNode(parsed.root)) return null;

        const floats = Array.isArray(parsed.floats) ? parsed.floats.filter(isValidFloat) : [];
        const state = { root: parsed.root, floats };

        // a stored layout that lost its viewport entirely would strand the
        // canvas, so fall back to the default rather than load it
        return kindIsPresent(state, 'viewport') ? state : null;
    } catch (e) {
        return null;
    }
};
