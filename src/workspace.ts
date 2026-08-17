/**
 * Workspace layout: a Blender-style tree of splits whose leaves are panes.
 * Each pane has a kind (its "editor type") switchable at runtime from the
 * pane's own header.
 *
 * Ported from Aerialist2's workspace model. The logic is framework-agnostic;
 * see ui/workspace-view.ts for the DOM/PCUI rendering of this tree.
 *
 * A pane can also be pulled out into a browser window of its own, which holds
 * a tree of the same shape - so panes out there split and switch kind exactly
 * as docked ones do.
 *
 * VoluLab constraint: every kind is backed by a single long-lived element, so
 * a kind lives in exactly one pane at a time and `assignKind` swaps rather than
 * duplicates. The viewport is stricter still - its WebGL canvas never leaves
 * the main window.
 */

export type PaneKind =
    | 'viewport'
    | 'outliner'
    | 'graph'
    | 'node'
    | 'transform'
    | 'timeline'
    | 'data'
    | 'training'
    | 'settings';

export const PANE_KINDS: { kind: PaneKind; label: string }[] = [
    { kind: 'viewport', label: 'viewport' },
    { kind: 'outliner', label: 'outliner' },
    { kind: 'graph', label: 'graph' },
    { kind: 'node', label: 'node' },
    { kind: 'transform', label: 'transform' },
    { kind: 'timeline', label: 'timeline' },
    { kind: 'data', label: 'splat data' },
    { kind: 'training', label: 'training' },
    { kind: 'settings', label: 'settings' }
];

// Kinds that have been renamed or absorbed. A stored layout naming an old one
// is migrated rather than thrown away, which would cost the user their layout.
const RENAMED_KINDS: Record<string, PaneKind> = {
    nodes: 'graph',
    // the colour panel is a node's parameters now, shown in the node pane
    color: 'node'
};

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
 * A detached browser window. It holds a layout tree of its own rather than a
 * single pane, so a detached panel can be split like any docked one.
 *
 * x/y are screen coordinates and width/height the window's inner size, so the
 * window can be reopened where the user left it. The viewport is never
 * detached: its WebGL context would have to survive being adopted into another
 * document, which is not worth betting on - see SINGLETON_KINDS.
 */
export interface FloatNode {
    type: 'float';
    id: string;
    root: LayoutNode;
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
 *   outliner    | viewport | node
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
        a: pane('node'),
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

/** Every pane on screen, docked first, then each detached window's tree. */
export const listSurfaces = (state: WorkspaceState): PaneNode[] => {
    return [
        ...listPanes(state.root),
        ...state.floats.flatMap(f => listPanes(f.root))
    ];
};

/** Is a kind on screen at all - docked or detached? */
export const kindIsPresent = (state: WorkspaceState, kind: PaneKind): boolean => {
    return listSurfaces(state).some(p => p.kind === kind);
};

const mapPane = (node: LayoutNode, fn: (p: PaneNode) => PaneNode): LayoutNode => {
    if (node.type === 'pane') return fn(node);
    return { ...node, a: mapPane(node.a, fn), b: mapPane(node.b, fn) };
};

/**
 * Assign a kind to a pane, anywhere on screen.
 *
 * Every kind is backed by exactly one long-lived element, so a kind can only
 * be in one place: whichever pane currently holds it takes over the kind being
 * displaced, rather than both panes asking for the same element and one of
 * them coming up blank. The swap crosses windows - the holder may be detached.
 */
export const assignKind = (state: WorkspaceState, id: string, kind: PaneKind): WorkspaceState => {
    const isDocked = (paneId: string) => !!findPane(state.root, paneId);

    const target = listSurfaces(state).find(p => p.id === id);
    if (!target || target.kind === kind) return state;

    // the viewport's canvas never leaves the main window, in either direction
    if (SINGLETON_KINDS.includes(kind) && !isDocked(id)) return state;

    const holder = listSurfaces(state).find(p => p.kind === kind) ?? null;
    if (holder && SINGLETON_KINDS.includes(target.kind) && !isDocked(holder.id)) return state;

    const swap = (p: PaneNode): PaneNode => {
        if (p.id === id) return { ...p, kind };
        if (holder && p.id === holder.id) return { ...p, kind: target.kind };
        return p;
    };

    return {
        root: mapPane(state.root, swap),
        floats: state.floats.map(f => ({ ...f, root: mapPane(f.root, swap) }))
    };
};

export const setRatio = (node: LayoutNode, id: string, ratio: number): LayoutNode => {
    if (node.type === 'pane') return node;
    if (node.id === id) {
        return { ...node, ratio: Math.max(0.1, Math.min(0.9, ratio)) };
    }
    return { ...node, a: setRatio(node.a, id, ratio), b: setRatio(node.b, id, ratio) };
};

/**
 * Split a pane in two.
 *
 * `sibling` is the kind for the new half. Only one element exists per kind, so
 * letting the sibling inherit the pane's own kind leaves one of the two halves
 * empty - callers pass a kind that is not on screen yet (see `freeKind` in the
 * view). Falls back to inheriting when nothing is free.
 */
export const splitPane = (
    node: LayoutNode,
    id: string,
    dir: 'row' | 'col',
    sibling?: PaneKind
): LayoutNode => {
    if (node.type === 'pane') {
        if (node.id !== id) return node;
        // a singleton can't be duplicated - the new sibling falls back
        const inherited: PaneKind = SINGLETON_KINDS.includes(node.kind) ? 'outliner' : node.kind;
        const siblingKind = (sibling && !SINGLETON_KINDS.includes(sibling)) ? sibling : inherited;
        return {
            type: 'split',
            id: paneId(),
            dir,
            ratio: 0.5,
            a: node,
            b: pane(siblingKind)
        };
    }
    return {
        ...node,
        a: splitPane(node.a, id, dir, sibling),
        b: splitPane(node.b, id, dir, sibling)
    };
};

/** Swap a pane for an arbitrary subtree - how a detached tree is grafted back. */
const replacePane = (root: LayoutNode, id: string, node: LayoutNode): LayoutNode => {
    if (root.type === 'pane') return root.id === id ? node : root;
    return { ...root, a: replacePane(root.a, id, node), b: replacePane(root.b, id, node) };
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
            root: pane(target.kind),
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
 * Put a detached window back in the tree by splitting the largest docked pane,
 * which is the least disruptive place to land and is predictable to the user.
 * The window's whole tree comes home, not just its first pane.
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

    let root = splitPane(state.root, host.id, 'col');
    // graft the detached tree over the placeholder splitPane just made. Its
    // pane ids left the main tree when it was undocked, so they can't collide.
    const added = listPanes(root).find(p => !listPanes(state.root).some(o => o.id === p.id));
    if (added) root = replacePane(root, added.id, float.root);

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

/** Apply a tree edit inside one detached window, leaving the rest alone. */
export const mapFloatRoot = (
    state: WorkspaceState,
    id: string,
    fn: (root: LayoutNode) => LayoutNode
): WorkspaceState => {
    return {
        ...state,
        floats: state.floats.map(f => (f.id === id ? { ...f, root: fn(f.root) } : f))
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
        isValidNode(f.root) &&
        ['x', 'y', 'width', 'height'].every(k => typeof f[k] === 'number' && isFinite(f[k] as number));
};

/** Floats used to hold a single kind. Give an old one the tree it now needs. */
const migrateFloat = (n: unknown): unknown => {
    if (typeof n !== 'object' || n === null) return n;
    const f = n as Record<string, unknown>;
    if (f.root || typeof f.kind !== 'string') return n;
    return { ...f, root: pane(f.kind as PaneKind) };
};

/** Rewrite panes naming a kind that has since been renamed or absorbed. */
const migrateKinds = (n: unknown): unknown => {
    if (typeof n !== 'object' || n === null) return n;
    const node = n as Record<string, unknown>;
    if (node.type === 'pane') {
        const renamed = RENAMED_KINDS[node.kind as string];
        return renamed ? { ...node, kind: renamed } : node;
    }
    if (node.type === 'split') {
        return { ...node, a: migrateKinds(node.a), b: migrateKinds(node.b) };
    }
    return node;
};

export const loadLayout = (): WorkspaceState | null => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as WorkspaceState;
        // migrate before validating: an unmigrated pane names a kind that no
        // longer exists, which validation would reject as corrupt
        const root = migrateKinds(parsed?.root);
        if (!isValidNode(root)) return null;

        const floats = Array.isArray(parsed.floats) ?
            parsed.floats
            .map(migrateFloat)
            .map(f => (typeof f === 'object' && f !== null ?
                { ...(f as object), root: migrateKinds((f as any).root) } : f))
            .filter(isValidFloat) : [];
        const state = { root, floats };

        // a stored layout that lost its viewport entirely would strand the
        // canvas, so fall back to the default rather than load it
        return kindIsPresent(state, 'viewport') ? state : null;
    } catch (e) {
        return null;
    }
};
