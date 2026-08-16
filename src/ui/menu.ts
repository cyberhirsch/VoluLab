import { Container, Element, Label } from '@playcanvas/pcui';

import { Events } from '../events';
import { recentFiles } from '../recent-files';
import { ShortcutManager } from '../shortcut-manager';
import { i18n } from './localization';
import { MenuPanel, MenuItem } from './menu-panel';
import selectDelete from './svg/delete.svg';
import editRedo from './svg/edit-redo.svg';
import editUndo from './svg/edit-undo.svg';
import sceneExport from './svg/export.svg';
import sceneImport from './svg/import.svg';
import sceneNew from './svg/new.svg';
import sceneOpen from './svg/open.svg';
import scenePublish from './svg/publish.svg';
import sceneSave from './svg/save.svg';
import selectAll from './svg/select-all.svg';
import selectDuplicate from './svg/select-duplicate.svg';
import selectInverse from './svg/select-inverse.svg';
import selectLock from './svg/select-lock.svg';
import selectNone from './svg/select-none.svg';
import selectSeparate from './svg/select-separate.svg';
import selectUnlock from './svg/select-unlock.svg';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new Element({
        dom: new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement
    });
};

const getOpenRecentItems = async (events: Events) => {
    const files = await recentFiles.get();
    const items: MenuItem[] = files.map((file) => {
        return {
            text: file.name,
            onSelect: () => events.invoke('doc.openRecent', file.handle)
        };
    });

    if (items.length > 0) {
        items.push({}); // separator
        items.push({
            text: () => i18n.t('menu.file.open-recent.clear'),
            icon: createSvg(selectDelete),
            onSelect: () => recentFiles.clear()
        });
    }

    return items;
};

class Menu extends Container {
    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'menu'
        };

        super(args);

        const menubar = new Container({
            id: 'menu-bar'
        });

        menubar.dom.addEventListener('pointerdown', (event) => {
            event.stopPropagation();
        });

        const scene = new Label({
            class: 'menu-option'
        });
        i18n.bindText(scene, 'menu.file');

        const edit = new Label({
            class: 'menu-option'
        });
        i18n.bindText(edit, 'menu.edit');

        const render = new Label({
            class: 'menu-option'
        });
        i18n.bindText(render, 'menu.render');

        const selection = new Label({
            class: 'menu-option'
        });
        i18n.bindText(selection, 'menu.select');

        // brand mark, sitting to the left of the menu options
        const logo = new Container({
            id: 'menu-logo'
        });
        logo.append(new Label({
            text: 'VOLU',
            class: 'menu-logo-primary'
        }));
        logo.append(new Label({
            text: 'LAB',
            class: 'menu-logo-secondary'
        }));

        const buttonsContainer = new Container({
            id: 'menu-bar-options'
        });
        buttonsContainer.append(logo);
        buttonsContainer.append(scene);
        buttonsContainer.append(edit);
        buttonsContainer.append(selection);
        buttonsContainer.append(render);

        // Undo and redo live up here as well as in the Edit menu, because the
        // menu bar is the only chrome that is always on screen. The toolbar
        // copies of these buttons belong to the viewport, and go with it when
        // its pane is showing something else.
        const history = new Container({
            id: 'menu-history'
        });

        const shortcuts: ShortcutManager = events.invoke('shortcutManager');

        const historyButton = (svg: string, label: string, shortcutId: string, fire: string) => {
            const button = new Container({
                class: 'menu-history-button'
            });
            button.append(createSvg(svg));
            button.dom.setAttribute('role', 'button');
            const shortcut = shortcuts?.formatShortcut(shortcutId);
            button.dom.title = shortcut ? `${label} (${shortcut})` : label;
            button.dom.addEventListener('click', () => {
                if (!button.class.contains('disabled')) events.fire(fire);
            });
            // nothing to undo yet, so they start out unavailable
            button.class.add('disabled');
            history.append(button);
            return button;
        };

        const undoButton = historyButton(editUndo, 'undo', 'edit.undo', 'edit.undo');
        const redoButton = historyButton(editRedo, 'redo', 'edit.redo', 'edit.redo');

        events.on('edit.canUndo', (value: boolean) => {
            undoButton.class[value ? 'remove' : 'add']('disabled');
        });
        events.on('edit.canRedo', (value: boolean) => {
            redoButton.class[value ? 'remove' : 'add']('disabled');
        });

        buttonsContainer.append(history);

        menubar.append(buttonsContainer);

        // Get the shortcut manager for displaying keyboard shortcuts
        const shortcutManager: ShortcutManager = events.invoke('shortcutManager');

        const exportMenuPanel = new MenuPanel([{
            text: 'PLY (.ply)',
            icon: createSvg(sceneExport),
            isEnabled: () => !events.invoke('scene.empty'),
            onSelect: () => events.invoke('scene.export', 'ply')
        }, {
            text: 'SOG (.sog)',
            icon: createSvg(sceneExport),
            isEnabled: () => !events.invoke('scene.empty'),
            onSelect: () => events.invoke('scene.export', 'sog')
        }, {
            text: 'SPZ (.spz)',
            icon: createSvg(sceneExport),
            isEnabled: () => !events.invoke('scene.empty'),
            onSelect: () => events.invoke('scene.export', 'spz')
        }, {
            text: 'Splat (.splat)',
            icon: createSvg(sceneExport),
            isEnabled: () => !events.invoke('scene.empty'),
            onSelect: () => events.invoke('scene.export', 'splat')
        }, {
            // separator
        }, {
            text: () => i18n.t('menu.file.export.viewer', { ellipsis: true }),
            icon: createSvg(sceneExport),
            isEnabled: () => !events.invoke('scene.empty'),
            onSelect: () => events.invoke('scene.export', 'viewer')
        }]);

        const openRecentMenuPanel = new MenuPanel([]);

        const fileMenuPanel = new MenuPanel([{
            text: () => i18n.t('menu.file.new'),
            icon: createSvg(sceneNew),
            isEnabled: () => !events.invoke('scene.empty'),
            onSelect: () => events.invoke('doc.new')
        }, {
            text: () => i18n.t('menu.file.open'),
            icon: createSvg(sceneOpen),
            onSelect: async () => {
                await events.invoke('doc.open');
            }
        }, {
            text: () => i18n.t('menu.file.open-recent'),
            icon: createSvg(sceneOpen),
            subMenu: openRecentMenuPanel,
            isEnabled: async () => {
                // refresh open recent menu items when the parent menu is opened
                try {
                    const items = await getOpenRecentItems(events);
                    openRecentMenuPanel.setItems(items);
                    return items.length > 0;
                } catch (error) {
                    console.error('Failed to load recent files:', error);
                    return false;
                }
            }
        }, {
            // separator
        }, {
            text: () => i18n.t('menu.file.save'),
            icon: createSvg(sceneSave),
            isEnabled: () => events.invoke('doc.name'),
            onSelect: async () => await events.invoke('doc.save')
        }, {
            text: () => i18n.t('menu.file.save-as', { ellipsis: true }),
            icon: createSvg(sceneSave),
            isEnabled: () => !events.invoke('scene.empty'),
            onSelect: async () => await events.invoke('doc.saveAs')
        }, {
            // separator
        }, {
            text: () => i18n.t('menu.file.import', { ellipsis: true }),
            icon: createSvg(sceneImport),
            onSelect: async () => {
                await events.invoke('scene.import');
            }
        }, {
            text: () => i18n.t('menu.file.export'),
            icon: createSvg(sceneExport),
            subMenu: exportMenuPanel
        }, {
            text: () => i18n.t('menu.file.publish', { ellipsis: true }),
            icon: createSvg(scenePublish),
            isEnabled: () => !events.invoke('scene.empty'),
            onSelect: async () => await events.invoke('show.publishSettingsDialog')
        }]);

        // track undo/redo availability for menu item enablement
        let canUndo = false;
        let canRedo = false;
        events.on('edit.canUndo', (value: boolean) => {
            canUndo = value;
        });
        events.on('edit.canRedo', (value: boolean) => {
            canRedo = value;
        });

        const editMenuPanel = new MenuPanel([{
            text: () => i18n.t('menu.edit.undo'),
            icon: createSvg(editUndo),
            extra: shortcutManager.formatShortcut('edit.undo'),
            isEnabled: () => canUndo,
            onSelect: () => events.fire('edit.undo')
        }, {
            text: () => i18n.t('menu.edit.redo'),
            icon: createSvg(editRedo),
            extra: shortcutManager.formatShortcut('edit.redo'),
            isEnabled: () => canRedo,
            onSelect: () => events.fire('edit.redo')
        }, {
            // separator
        }, {
            text: () => i18n.t('menu.edit.duplicate'),
            icon: createSvg(selectDuplicate),
            isEnabled: () => events.invoke('selection.splats'),
            onSelect: () => events.fire('edit.duplicate')
        }, {
            text: () => i18n.t('menu.edit.separate'),
            icon: createSvg(selectSeparate),
            isEnabled: () => events.invoke('selection.splats'),
            onSelect: () => events.fire('edit.separate')
        }]);

        const selectionMenuPanel = new MenuPanel([{
            text: () => i18n.t('menu.select.all'),
            icon: createSvg(selectAll),
            extra: shortcutManager.formatShortcut('select.all'),
            onSelect: () => events.fire('select.all')
        }, {
            text: () => i18n.t('menu.select.none'),
            icon: createSvg(selectNone),
            extra: shortcutManager.formatShortcut('select.none'),
            onSelect: () => events.fire('select.none')
        }, {
            text: () => i18n.t('menu.select.invert'),
            icon: createSvg(selectInverse),
            extra: shortcutManager.formatShortcut('select.invert'),
            onSelect: () => events.fire('select.invert')
        }, {
            // separator
        }, {
            text: () => i18n.t('menu.select.lock'),
            icon: createSvg(selectLock),
            extra: shortcutManager.formatShortcut('select.hide'),
            isEnabled: () => events.invoke('selection.splats'),
            onSelect: () => events.fire('select.hide')
        }, {
            text: () => i18n.t('menu.select.unlock'),
            icon: createSvg(selectUnlock),
            extra: shortcutManager.formatShortcut('select.unhide'),
            onSelect: () => events.fire('select.unhide')
        }, {
            text: () => i18n.t('menu.select.delete'),
            icon: createSvg(selectDelete),
            extra: shortcutManager.formatShortcut('select.delete'),
            isEnabled: () => events.invoke('selection.splats'),
            onSelect: () => events.fire('select.delete')
        }, {
            text: () => i18n.t('menu.select.reset'),
            onSelect: () => events.fire('scene.reset')
        }]);

        const renderMenuPanel = new MenuPanel([{
            text: () => i18n.t('menu.render.image', { ellipsis: true }),
            icon: createSvg(sceneExport),
            onSelect: async () => await events.invoke('show.imageSettingsDialog')
        }, {
            text: () => i18n.t('menu.render.video', { ellipsis: true }),
            icon: createSvg(sceneExport),
            onSelect: async () => await events.invoke('show.videoSettingsDialog')
        }]);

        this.append(menubar);
        this.append(fileMenuPanel);
        this.append(openRecentMenuPanel);
        this.append(exportMenuPanel);
        this.append(editMenuPanel);
        this.append(selectionMenuPanel);
        this.append(renderMenuPanel);

        const options: { dom: HTMLElement, menuPanel: MenuPanel }[] = [{
            dom: scene.dom,
            menuPanel: fileMenuPanel
        }, {
            dom: edit.dom,
            menuPanel: editMenuPanel
        }, {
            dom: selection.dom,
            menuPanel: selectionMenuPanel
        }, {
            dom: render.dom,
            menuPanel: renderMenuPanel
        }];

        options.forEach((option) => {
            const activate = () => {
                option.menuPanel.position(option.dom, 'bottom', 2);
                options.forEach((opt) => {
                    opt.menuPanel.hidden = opt !== option;
                });
            };

            option.dom.addEventListener('pointerdown', (event: PointerEvent) => {
                if (!option.menuPanel.hidden) {
                    option.menuPanel.hidden = true;
                } else {
                    activate();
                }
            });

            option.dom.addEventListener('pointerenter', (event: PointerEvent) => {
                if (!options.every(opt => opt.menuPanel.hidden)) {
                    activate();
                }
            });
        });

        const checkEvent = (event: PointerEvent) => {
            if (!this.dom.contains(event.target as Node)) {
                options.forEach((opt) => {
                    opt.menuPanel.hidden = true;
                });
            }
        };

        window.addEventListener('pointerdown', checkEvent, true);
        window.addEventListener('pointerup', checkEvent, true);
    }
}

export { Menu };
