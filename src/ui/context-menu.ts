/**
 * The right-click menu.
 *
 * One implementation for the whole app rather than a component per surface:
 * a menu is opened by handing it a position and a list of items, so whatever
 * is under the pointer decides what it offers. Panes contribute their own
 * actions, and anything that wants more adds to the list.
 *
 * Built against a supplied document so a detached window gets its menu in its
 * own document rather than in the opener's, where it would be invisible.
 */

export interface MenuItem {
    label: string;
    action: () => void;
    /** shown greyed and not clickable */
    disabled?: boolean;
    /** short right-aligned hint - a shortcut, a value, a unit */
    hint?: string;
}

export type MenuEntry = MenuItem | 'separator';

/**
 * Contribute items to the menu the surrounding pane is about to open.
 *
 * Content sits inside a pane, and a right-click on it should still offer what
 * the pane offers - splitting, detaching, closing. So content adds to the
 * event on its way up rather than opening a menu of its own and stopping it,
 * which would trade the pane's items for its own.
 */
export const contributeMenuItems = (e: MouseEvent, entries: MenuEntry[]) => {
    const carrier = e as MouseEvent & { paneMenuItems?: MenuEntry[] };
    carrier.paneMenuItems = [...(carrier.paneMenuItems ?? []), ...entries];
};

/** What content contributed to this event, if anything. */
export const contributedMenuItems = (e: MouseEvent): MenuEntry[] => {
    return (e as MouseEvent & { paneMenuItems?: MenuEntry[] }).paneMenuItems ?? [];
};

let open: { el: HTMLElement, dispose: () => void } | null = null;

/** Close whatever menu is showing. Safe to call when none is. */
export const closeContextMenu = () => {
    open?.dispose();
    open = null;
};

/**
 * Show a menu at viewport coordinates within `doc`.
 *
 * Entries are flat - no submenus. A menu deep enough to need them is a sign
 * the surface underneath wants a panel instead.
 */
export const showContextMenu = (doc: Document, x: number, y: number, entries: MenuEntry[]) => {
    closeContextMenu();

    const usable = entries.filter(e => e === 'separator' || !!e);
    if (!usable.length) return;

    const el = doc.createElement('div');
    el.className = 'ctx-menu';

    usable.forEach((entry) => {
        if (entry === 'separator') {
            const sep = doc.createElement('div');
            sep.className = 'ctx-menu-separator';
            el.appendChild(sep);
            return;
        }

        const item = doc.createElement('button');
        item.className = 'ctx-menu-item';
        item.type = 'button';
        if (entry.disabled) item.classList.add('ctx-menu-disabled');

        const label = doc.createElement('span');
        label.className = 'ctx-menu-label';
        label.textContent = entry.label;
        item.appendChild(label);

        if (entry.hint) {
            const hint = doc.createElement('span');
            hint.className = 'ctx-menu-hint';
            hint.textContent = entry.hint;
            item.appendChild(hint);
        }

        if (!entry.disabled) {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                closeContextMenu();
                entry.action();
            });
        }

        el.appendChild(item);
    });

    doc.body.appendChild(el);

    // place it, then pull it back inside the window if it would hang off the
    // right or bottom edge. Measured after insertion because the size depends
    // on the longest label.
    const rect = el.getBoundingClientRect();
    const maxX = doc.documentElement.clientWidth - rect.width - 2;
    const maxY = doc.documentElement.clientHeight - rect.height - 2;
    el.style.left = `${Math.max(2, Math.min(x, maxX))}px`;
    el.style.top = `${Math.max(2, Math.min(y, maxY))}px`;

    const onPointerDown = (e: Event) => {
        if (!el.contains(e.target as Node)) closeContextMenu();
    };
    const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') closeContextMenu();
    };

    // capture phase: a surface that stops propagation on its own pointerdown
    // (most of the panels do) must not be able to keep the menu open
    doc.addEventListener('pointerdown', onPointerDown, true);
    doc.addEventListener('wheel', closeContextMenu, true);
    doc.defaultView?.addEventListener('keydown', onKeyDown, true);
    doc.defaultView?.addEventListener('blur', closeContextMenu);

    open = {
        el,
        dispose: () => {
            doc.removeEventListener('pointerdown', onPointerDown, true);
            doc.removeEventListener('wheel', closeContextMenu, true);
            doc.defaultView?.removeEventListener('keydown', onKeyDown, true);
            doc.defaultView?.removeEventListener('blur', closeContextMenu);
            el.remove();
        }
    };
};
