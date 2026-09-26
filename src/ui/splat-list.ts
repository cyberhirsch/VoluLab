import { Container, Label, Element as PcuiElement, TextInput } from '@playcanvas/pcui';

import { SplatRenameOp } from '../edit-ops';
import { Element, ElementType } from '../element';
import { Events } from '../events';
import { SceneCamera } from '../scene-camera';
import { SceneLight } from '../scene-light';
import { ScenePrimitive } from '../scene-primitive';
import { Splat } from '../splat';
import deleteSvg from './svg/delete.svg';
import hiddenSvg from './svg/hidden.svg';
import shownSvg from './svg/shown.svg';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

class SplatItem extends Container {
    getName: () => string;
    setName: (value: string) => void;
    getSelected: () => boolean;
    setSelected: (value: boolean) => void;
    getVisible: () => boolean;
    setVisible: (value: boolean) => void;
    destroy: () => void;

    constructor(name: string, edit: TextInput, args = {}) {
        args = {
            ...args,
            class: ['splat-item', 'visible']
        };

        super(args);

        const text = new Label({
            class: 'splat-item-text',
            text: name
        });

        const visible = new PcuiElement({
            dom: createSvg(shownSvg),
            class: 'splat-item-visible'
        });

        const invisible = new PcuiElement({
            dom: createSvg(hiddenSvg),
            class: 'splat-item-visible',
            hidden: true
        });

        const remove = new PcuiElement({
            dom: createSvg(deleteSvg),
            class: 'splat-item-delete'
        });

        this.append(text);
        this.append(visible);
        this.append(invisible);
        this.append(remove);

        this.getName = () => {
            return text.value;
        };

        this.setName = (value: string) => {
            text.value = value;
        };

        this.getSelected = () => {
            return this.class.contains('selected');
        };

        this.setSelected = (value: boolean) => {
            if (value !== this.selected) {
                if (value) {
                    this.class.add('selected');
                    this.emit('select', this);
                } else {
                    this.class.remove('selected');
                    this.emit('unselect', this);
                }
            }
        };

        this.getVisible = () => {
            return this.class.contains('visible');
        };

        this.setVisible = (value: boolean) => {
            if (value !== this.visible) {
                visible.hidden = !value;
                invisible.hidden = value;
                if (value) {
                    this.class.add('visible');
                    this.emit('visible', this);
                } else {
                    this.class.remove('visible');
                    this.emit('invisible', this);
                }
            }
        };

        const toggleVisible = (event: MouseEvent) => {
            event.stopPropagation();
            this.visible = !this.visible;
        };

        const handleRemove = (event: MouseEvent) => {
            event.stopPropagation();
            this.emit('removeClicked', this);
        };

        // rename on double click
        text.dom.addEventListener('dblclick', (event: MouseEvent) => {
            event.stopPropagation();

            const onblur = () => {
                this.remove(edit);
                this.emit('rename', edit.value);
                edit.input.removeEventListener('blur', onblur);
                text.hidden = false;
            };

            text.hidden = true;

            this.appendAfter(edit, text);
            edit.value = text.value;
            edit.input.addEventListener('blur', onblur);
            edit.focus();
        });

        // handle clicks
        visible.dom.addEventListener('click', toggleVisible);
        invisible.dom.addEventListener('click', toggleVisible);
        remove.dom.addEventListener('click', handleRemove);

        this.destroy = () => {
            visible.dom.removeEventListener('click', toggleVisible);
            invisible.dom.removeEventListener('click', toggleVisible);
            remove.dom.removeEventListener('click', handleRemove);
        };
    }

    set name(value: string) {
        this.setName(value);
    }

    get name() {
        return this.getName();
    }

    set selected(value) {
        this.setSelected(value);
    }

    get selected() {
        return this.getSelected();
    }

    set visible(value) {
        this.setVisible(value);
    }

    get visible() {
        return this.getVisible();
    }
}

class SplatList extends Container {
    constructor(events: Events, args = {}) {
        args = {
            ...args,
            class: 'splat-list'
        };

        super(args);

        const items = new Map<Splat, SplatItem>();
        let soloMode = false;
        const savedVisibility = new Map<Splat, boolean>();

        // edit input used during renames
        const edit = new TextInput({
            id: 'splat-edit'
        });

        events.on('scene.elementAdded', (element: Element) => {
            if (element.type === ElementType.splat) {
                const splat = element as Splat;
                const item = new SplatItem(splat.name, edit);
                this.append(item);
                items.set(splat, item);

                if (soloMode) {
                    savedVisibility.set(splat, splat.visible);
                    splat.visible = false;
                }

                item.on('visible', () => {
                    splat.visible = true;

                    // also select it if there is no other selection
                    if (!events.invoke('selection')) {
                        events.fire('selection', splat);
                    }
                });
                item.on('invisible', () => {
                    splat.visible = false;
                });
                item.on('rename', (value: string) => {
                    events.fire('edit.add', new SplatRenameOp(splat, value));
                });
            }
        });

        // Cameras share the outliner with objects: they are things in the
        // scene you point at and switch between, so hiding them in a
        // separate list would only make you look in two places. The row
        // visuals are the same; what a click means is not - selecting a
        // camera makes it the one the viewport can look through.
        const cameraItems = new Map<SceneCamera, SplatItem>();

        events.on('scene.elementAdded', (element: Element) => {
            // the viewport's own camera is an element of this type as well,
            // and it is not a thing the outliner should list
            if (!(element instanceof SceneCamera)) return;
            const camera = element as SceneCamera;
            const item = new SplatItem(camera.name, edit);
            item.class.add('camera-item');
            this.append(item);
            cameraItems.set(camera, item);

            item.on('visible', () => {
                camera.visible = true;
                events.fire('camera.sceneCameraChanged', camera);
            });
            item.on('invisible', () => {
                camera.visible = false;
                events.fire('camera.sceneCameraChanged', camera);
            });
            item.on('rename', (value: string) => {
                camera.name = value;
                events.fire('camera.sceneCameraChanged', camera);
                events.fire('edit.changed');
            });
        });

        // Lights join them for the same reason. A light's eye switches it on
        // and off: a hidden light lights nothing.
        const lightItems = new Map<SceneLight, SplatItem>();

        events.on('scene.elementAdded', (element: Element) => {
            if (!(element instanceof SceneLight)) return;
            const light = element as SceneLight;
            const item = new SplatItem(light.name, edit);
            item.class.add('light-item');
            item.visible = light.visible;
            this.append(item);
            lightItems.set(light, item);

            item.on('visible', () => {
                light.visible = true;
                light.changed();
            });
            item.on('invisible', () => {
                light.visible = false;
                light.changed();
            });
            item.on('rename', (value: string) => {
                light.name = value;
                light.changed();
                events.fire('edit.changed');
            });
        });

        events.on('light.selectionChanged', (light: SceneLight | null) => {
            lightItems.forEach((value, key) => {
                value.selected = key === light;
            });
        });

        events.on('light.changed', (light: SceneLight) => {
            const item = lightItems.get(light);
            if (item) {
                item.name = light.name;
                item.visible = light.visible;
            }
        });

        // Primitives as well: shapes placed in the scene. The eye hides the
        // wireframe; what uses the shape still does.
        const primitiveItems = new Map<ScenePrimitive, SplatItem>();

        events.on('scene.elementAdded', (element: Element) => {
            if (!(element instanceof ScenePrimitive)) return;
            const primitive = element as ScenePrimitive;
            const item = new SplatItem(primitive.name, edit);
            item.class.add('primitive-item');
            item.visible = primitive.visible;
            this.append(item);
            primitiveItems.set(primitive, item);

            item.on('visible', () => {
                primitive.visible = true;
                primitive.changed();
            });
            item.on('invisible', () => {
                primitive.visible = false;
                primitive.changed();
            });
            item.on('rename', (value: string) => {
                primitive.name = value;
                primitive.changed();
                events.fire('edit.changed');
            });
        });

        events.on('primitive.selectionChanged', (primitive: ScenePrimitive | null) => {
            primitiveItems.forEach((value, key) => {
                value.selected = key === primitive;
            });
        });

        events.on('primitive.changed', (primitive: ScenePrimitive) => {
            const item = primitiveItems.get(primitive);
            if (item) {
                item.name = primitive.name;
                item.visible = primitive.visible;
            }
        });

        events.on('scene.elementRemoved', (element: Element) => {
            if (element instanceof ScenePrimitive) {
                const item = primitiveItems.get(element as ScenePrimitive);
                if (item) {
                    this.remove(item);
                    primitiveItems.delete(element as ScenePrimitive);
                }
            }
            if (element instanceof SceneLight) {
                const item = lightItems.get(element as SceneLight);
                if (item) {
                    this.remove(item);
                    lightItems.delete(element as SceneLight);
                }
            }
            if (element instanceof SceneCamera) {
                const item = cameraItems.get(element as SceneCamera);
                if (item) {
                    this.remove(item);
                    cameraItems.delete(element as SceneCamera);
                }
            }
            if (element.type === ElementType.splat) {
                const splat = element as Splat;
                const item = items.get(splat);
                if (item) {
                    this.remove(item);
                    items.delete(splat);
                }
                savedVisibility.delete(splat);
            }
        });

        events.on('selection.changed', (selection: Splat, prev: Splat) => {
            items.forEach((value, key) => {
                value.selected = key === selection;
            });

            if (soloMode) {
                if (prev) {
                    prev.visible = false;
                }
                if (selection) {
                    selection.visible = true;
                }
            }
        });

        events.on('scene.solo', (value: boolean) => {
            soloMode = value;
            const selection = events.invoke('selection') as Splat;

            if (soloMode) {
                items.forEach((item, splat) => {
                    savedVisibility.set(splat, splat.visible);
                    splat.visible = splat === selection;
                });
            } else {
                items.forEach((item, splat) => {
                    const wasVisible = savedVisibility.get(splat);
                    splat.visible = wasVisible !== undefined ? wasVisible : true;
                });
                savedVisibility.clear();
            }
        });

        events.on('splat.name', (splat: Splat) => {
            const item = items.get(splat);
            if (item) {
                item.name = splat.name;
            }
        });

        events.on('splat.visibility', (splat: Splat) => {
            const item = items.get(splat);
            if (item) {
                item.visible = splat.visible;
            }
        });

        this.on('click', (item: SplatItem) => {
            for (const [key, value] of lightItems) {
                if (item === value) {
                    events.fire('light.select', key);
                    return;
                }
            }

            for (const [key, value] of primitiveItems) {
                if (item === value) {
                    events.fire('primitive.select', key);
                    return;
                }
            }

            for (const [key, value] of cameraItems) {
                if (item === value) {
                    // one highlight in the list, so picking a camera drops
                    // the object selection and vice versa
                    events.fire('selection', null);
                    events.fire('camera.select', key);
                    return;
                }
            }

            for (const [key, value] of items) {
                if (item === value) {
                    if (soloMode && !key.visible) {
                        key.visible = true;
                    }
                    events.fire('camera.select', null);
                    events.fire('selection', key);
                    break;
                }
            }
        });

        // the selected camera is highlighted like a selected object
        events.on('camera.selectionChanged', (camera: SceneCamera | null) => {
            cameraItems.forEach((value, key) => {
                value.selected = key === camera;
            });
        });

        events.on('camera.sceneCameraChanged', (camera: SceneCamera) => {
            const item = cameraItems.get(camera);
            if (item) {
                item.name = camera.name;
                item.visible = camera.visible;
            }
        });

        this.on('removeClicked', async (item: SplatItem) => {
            let splat;
            for (const [key, value] of items) {
                if (item === value) {
                    splat = key;
                    break;
                }
            }

            if (!splat) {
                return;
            }

            const result = await events.invoke('showPopup', {
                type: 'yesno',
                header: 'Remove Splat',
                message: `Are you sure you want to remove '${splat.name}' from the scene? This operation can not be undone.`
            });

            if (result?.action === 'yes') {
                splat.destroy();
            }
        });
    }

    protected _onAppendChild(element: PcuiElement): void {
        super._onAppendChild(element);

        if (element instanceof SplatItem) {
            element.on('click', () => {
                this.emit('click', element);
            });

            element.on('removeClicked', () => {
                this.emit('removeClicked', element);
            });
        }
    }

    protected _onRemoveChild(element: PcuiElement): void {
        if (element instanceof SplatItem) {
            element.unbind('click');
            element.unbind('removeClicked');
        }

        super._onRemoveChild(element);
    }
}

export { SplatList, SplatItem };
