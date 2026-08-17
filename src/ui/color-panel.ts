import { ColorPicker, Container, Label, SliderInput } from '@playcanvas/pcui';
import { Color } from 'playcanvas';

import { Events } from '../events';
import { i18n } from './localization';
import { Tooltips } from './tooltips';
import { ScopedColorOp, SetSplatColorAdjustmentOp } from '../edit-ops';
import { Splat } from '../splat';

// pcui slider doesn't include start and end events
class MyFancySliderInput extends SliderInput {
    _onSlideStart(pageX: number) {
        super._onSlideStart(pageX);
        this.emit('slide:start');
    }

    _onSlideEnd(pageX: number) {
        super._onSlideEnd(pageX);
        this.emit('slide:end');
    }
}

class ColorPanel extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'color-panel',
            class: 'panel',
            hidden: true
        };

        super(args);

        // stop pointer events bubbling
        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
            this.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });

        // header


        // tint

        const tintRow = new Container({
            class: 'color-panel-row'
        });

        const tintLabel = new Label({
            class: 'color-panel-row-label'
        });
        i18n.bindText(tintLabel, 'panel.colors.tint');

        const tintPicker = new ColorPicker({
            class: 'color-panel-row-picker',
            value: [1, 1, 1]
        });

        tintRow.append(tintLabel);
        tintRow.append(tintPicker);

        // temperature

        const temperatureRow = new Container({
            class: 'color-panel-row'
        });

        const temperatureLabel = new Label({
            class: 'color-panel-row-label'
        });
        i18n.bindText(temperatureLabel, 'panel.colors.temperature');

        const temperatureSlider = new MyFancySliderInput({
            class: 'color-panel-row-slider',
            min: -0.5,
            max: 0.5,
            step: 0.005,
            value: 0
        });

        temperatureRow.append(temperatureLabel);
        temperatureRow.append(temperatureSlider);

        // saturation

        const saturationRow = new Container({
            class: 'color-panel-row'
        });

        const saturationLabel = new Label({
            class: 'color-panel-row-label'
        });
        i18n.bindText(saturationLabel, 'panel.colors.saturation');

        const saturationSlider = new MyFancySliderInput({
            class: 'color-panel-row-slider',
            min: 0,
            max: 2,
            step: 0.1,
            value: 1
        });

        saturationRow.append(saturationLabel);
        saturationRow.append(saturationSlider);

        // exposure, in stops

        const exposureRow = new Container({
            class: 'color-panel-row'
        });

        const exposureLabel = new Label({
            class: 'color-panel-row-label'
        });
        i18n.bindText(exposureLabel, 'panel.colors.exposure');

        // A multiply, where brightness is an add. Stops rather than a factor,
        // because that is the unit the change is actually thought in, and it
        // makes the ends of the range useful instead of crowded at one side.
        const exposureSlider = new MyFancySliderInput({
            class: 'color-panel-row-slider',
            min: -10,
            max: 10,
            step: 0.1,
            precision: 2,
            value: 0
        });

        exposureRow.append(exposureLabel);
        exposureRow.append(exposureSlider);

        // brightness

        const brightnessRow = new Container({
            class: 'color-panel-row'
        });

        const brightnessLabel = new Label({
            class: 'color-panel-row-label'
        });
        i18n.bindText(brightnessLabel, 'panel.colors.brightness');

        // Brightness is a lift, added after the levels have scaled the signal
        // up - so on a narrow white point the old +/-1 could not reach. Large
        // changes belong to exposure; this is the fine adjustment, with room.
        const brightnessSlider = new MyFancySliderInput({
            class: 'color-panel-row-slider',
            min: -2,
            max: 2,
            step: 0.01,
            precision: 3,
            value: 0
        });

        brightnessRow.append(brightnessLabel);
        brightnessRow.append(brightnessSlider);

        // black point

        const blackPointRow = new Container({
            class: 'color-panel-row'
        });

        const blackPointLabel = new Label({
            class: 'color-panel-row-label'
        });
        i18n.bindText(blackPointLabel, 'panel.colors.black-point');

        const blackPointSlider = new MyFancySliderInput({
            class: 'color-panel-row-slider',
            min: 0,
            max: 1,
            step: 0.01,
            value: 0
        });

        blackPointRow.append(blackPointLabel);
        blackPointRow.append(blackPointSlider);

        // white point

        const whitePointRow = new Container({
            class: 'color-panel-row'
        });

        const whitePointLabel = new Label({
            class: 'color-panel-row-label'
        });
        i18n.bindText(whitePointLabel, 'panel.colors.white-point');

        const whitePointSlider = new MyFancySliderInput({
            class: 'color-panel-row-slider',
            min: 0,
            max: 1,
            step: 0.01,
            value: 1
        });

        whitePointRow.append(whitePointLabel);
        whitePointRow.append(whitePointSlider);

        // transparency

        const transparencyRow = new Container({
            class: 'color-panel-row'
        });

        const transparencyLabel = new Label({
            class: 'color-panel-row-label'
        });
        i18n.bindText(transparencyLabel, 'panel.colors.transparency');

        // The slider is in log space - the panel stores exp(value) - so the old
        // +6 end asked for a 400x alpha multiplier, and everything much above
        // zero clamped on arrival. Half the travel did nothing. The top now
        // stops at a little over 4x, which is as far as boosting alpha stays
        // meaningful, and the bottom still reaches effectively transparent.
        const transparencySlider = new MyFancySliderInput({
            class: 'color-panel-row-slider',
            min: -6,
            max: 1.5,
            step: 0.01,
            value: 0
        });

        transparencyRow.append(transparencyLabel);
        transparencyRow.append(transparencySlider);

        // control row

        const controlRow = new Container({
            class: 'color-panel-control-row'
        });

        const reset = new Label({
            class: 'panel-header-button',
            text: '\uE304'
        });

        controlRow.append(new Label({ class: 'panel-header-spacer' }));
        controlRow.append(reset);
        controlRow.append(new Label({ class: 'panel-header-spacer' }));

        this.append(tintRow);
        this.append(temperatureRow);
        this.append(saturationRow);
        this.append(exposureRow);
        this.append(brightnessRow);
        this.append(blackPointRow);
        this.append(whitePointRow);
        this.append(transparencyRow);
        this.append(new Label({ class: 'panel-header-spacer' }));
        this.append(controlRow);

        // handle ui updates

        let suppress = false;
        let selected: Splat = null;
        let op: SetSplatColorAdjustmentOp = null;

        /**
         * A scoped colour node the panel is editing instead of the object.
         *
         * The controls are the same either way; what changes is where the
         * numbers live. An object grade is a property of the splat and applies
         * live; a node's grade belongs to the op, and changing it has to go
         * through the history so everything downstream rebuilds.
         */
        let boundOp: ScopedColorOp = null;
        let boundIndex = -1;
        let dragging = false;

        // assigned once updateUIFromState exists, which is defined further down
        let refreshFromObject: (splat: Splat) => void = () => {};

        const readBound = () => {
            const g = boundOp.grade;
            suppress = true;
            tintPicker.value = [g.tintClr.r, g.tintClr.g, g.tintClr.b];
            temperatureSlider.value = g.temperature;
            saturationSlider.value = g.saturation;
            exposureSlider.value = g.exposure ?? 0;
            brightnessSlider.value = g.brightness;
            blackPointSlider.value = g.blackPoint;
            whitePointSlider.value = g.whitePoint;
            transparencySlider.value = Math.log(g.transparency);
            suppress = false;
        };

        // gather the controls into a grade, which is what a node stores
        const readControls = () => ({
            tintClr: new Color(tintPicker.value[0], tintPicker.value[1], tintPicker.value[2]),
            temperature: temperatureSlider.value,
            saturation: saturationSlider.value,
            exposure: exposureSlider.value,
            brightness: brightnessSlider.value,
            blackPoint: blackPointSlider.value,
            whitePoint: whitePointSlider.value,
            transparency: Math.exp(transparencySlider.value)
        });

        const commitBound = () => {
            const next = readControls();
            events.invoke('edit.refresh', boundIndex, () => boundOp.setGrade(next));
        };

        // Reachable from the element, because that is what the node pane holds:
        // panels are mounted by their dom rather than by their instance.
        (this.dom as any).bindNode = (node: ScopedColorOp | null, index = -1) => {
            boundOp = node;
            boundIndex = index;
            if (node) {
                readBound();
            } else if (selected) {
                // rebound to the object, so the controls show its own grade
                refreshFromObject(selected);
            }
        };

        const updateUIFromState = (splat: Splat) => {
            if (boundOp) return;
            if (suppress) return;
            suppress = true;
            tintPicker.value = splat ? [splat.tintClr.r, splat.tintClr.g, splat.tintClr.b] : [1, 1, 1];
            temperatureSlider.value = splat ? splat.temperature : 0;
            saturationSlider.value = splat ? splat.saturation : 0;
            exposureSlider.value = splat ? splat.exposure : 0;
            brightnessSlider.value = splat ? splat.brightness : 0;
            blackPointSlider.value = splat ? splat.blackPoint : 0;
            whitePointSlider.value = splat ? splat.whitePoint : 1;
            transparencySlider.value = splat ? Math.log(splat.transparency) : 0;
            suppress = false;
        };

        refreshFromObject = updateUIFromState;

        const start = () => {
            if (selected) {
                op = new SetSplatColorAdjustmentOp({
                    splat: selected,
                    newState: {
                        tintClr: selected.tintClr.clone(),
                        temperature: selected.temperature,
                        saturation: selected.saturation,
                        exposure: selected.exposure,
                        brightness: selected.brightness,
                        blackPoint: selected.blackPoint,
                        whitePoint: selected.whitePoint,
                        transparency: selected.transparency
                    },
                    oldState: {
                        tintClr: selected.tintClr.clone(),
                        temperature: selected.temperature,
                        saturation: selected.saturation,
                        exposure: selected.exposure,
                        brightness: selected.brightness,
                        blackPoint: selected.blackPoint,
                        whitePoint: selected.whitePoint,
                        transparency: selected.transparency
                    }
                });
            }
        };

        const end = () => {
            if (op) {
                const { newState } = op;
                newState.tintClr.set(tintPicker.value[0], tintPicker.value[1], tintPicker.value[2]);
                newState.temperature = temperatureSlider.value;
                newState.saturation = saturationSlider.value;
                newState.exposure = exposureSlider.value;
                newState.brightness = brightnessSlider.value;
                newState.blackPoint = blackPointSlider.value;
                newState.whitePoint = whitePointSlider.value;
                newState.transparency = Math.exp(transparencySlider.value);
                // merged into the colour node being worked on, rather than
                // leaving a node behind for every slider gesture
                events.invoke('edit.addColour', op);
                op = null;
            }
        };

        const updateOp = (setFunc: (op: SetSplatColorAdjustmentOp) => void) => {
            if (suppress) return;

            // Editing a node: the controls already hold the new value, so the
            // setter has nothing to add. Committing waits for the end of a drag,
            // because each commit replays the history from that node down.
            if (boundOp) {
                if (!dragging) commitBound();
                return;
            }

            suppress = true;
            if (op) {
                setFunc(op);
                op.do();
            } else if (selected) {
                start();
                setFunc(op);
                op.do();
                end();
            }
            suppress = false;
        };

        const gestureStart = () => {
            dragging = true;
            if (!boundOp) start();
        };

        const gestureEnd = () => {
            dragging = false;
            if (boundOp) commitBound(); else end();
        };

        [temperatureSlider, saturationSlider, exposureSlider, brightnessSlider, blackPointSlider, whitePointSlider, transparencySlider].forEach((slider) => {
            slider.on('slide:start', gestureStart);
            slider.on('slide:end', gestureEnd);
        });
        tintPicker.on('picker:color:start', gestureStart);
        tintPicker.on('picker:color:end', gestureEnd);

        tintPicker.on('change', (value: number[]) => {
            updateOp((op) => {
                op.newState.tintClr.set(value[0], value[1], value[2]);
            });
        });

        temperatureSlider.on('change', (value: number) => {
            updateOp((op) => {
                op.newState.temperature = value;
            });
        });

        saturationSlider.on('change', (value: number) => {
            updateOp((op) => {
                op.newState.saturation = value;
            });
        });

        exposureSlider.on('change', (value: number) => {
            updateOp((op) => {
                op.newState.exposure = value;
            });
        });

        brightnessSlider.on('change', (value: number) => {
            updateOp((op) => {
                op.newState.brightness = value;
            });
        });

        blackPointSlider.on('change', (value: number) => {
            updateOp((op) => {
                op.newState.blackPoint = value;
            });

            if (value > whitePointSlider.value) {
                whitePointSlider.value = value;
            }
        });

        whitePointSlider.on('change', (value: number) => {
            updateOp((op) => {
                op.newState.whitePoint = value;
            });

            if (value < blackPointSlider.value) {
                blackPointSlider.value = value;
            }
        });

        transparencySlider.on('change', (value: number) => {
            updateOp((op) => {
                op.newState.transparency = Math.exp(value);
            });
        });

        reset.on('click', () => {
            if (selected) {
                const op = new SetSplatColorAdjustmentOp({
                    splat: selected,
                    newState: {
                        tintClr: new Color(1, 1, 1),
                        temperature: 0,
                        saturation: 1,
                        brightness: 0,
                        blackPoint: 0,
                        whitePoint: 1,
                        transparency: 1
                    },
                    oldState: {
                        tintClr: selected.tintClr.clone(),
                        temperature: selected.temperature,
                        saturation: selected.saturation,
                        exposure: selected.exposure,
                        brightness: selected.brightness,
                        blackPoint: selected.blackPoint,
                        whitePoint: selected.whitePoint,
                        transparency: selected.transparency
                    }
                });

                // merged into the colour node being worked on, rather than
                // leaving a node behind for every slider gesture
                events.invoke('edit.addColour', op);
            }
        });

        events.on('selection.changed', (splat) => {
            selected = splat;
            updateUIFromState(splat);
        });

        events.on('splat.tintClr', updateUIFromState);
        events.on('splat.temperature', updateUIFromState);
        events.on('splat.saturation', updateUIFromState);
        events.on('splat.brightness', updateUIFromState);
        events.on('splat.blackPoint', updateUIFromState);
        events.on('splat.whitePoint', updateUIFromState);
        events.on('splat.transparency', updateUIFromState);

        tooltips.register(reset, () => i18n.t('panel.colors.reset'), 'bottom');

        // handle panel visibility

        const setVisible = (visible: boolean) => {
            if (visible === this.hidden) {
                this.hidden = !visible;
                events.fire('colorPanel.visible', visible);
            }
        };

        events.function('colorPanel.visible', () => {
            return !this.hidden;
        });

        events.on('colorPanel.setVisible', (visible: boolean) => {
            setVisible(visible);
        });

        events.on('colorPanel.toggleVisible', () => {
            setVisible(this.hidden);
        });

        events.on('settingsPanel.visible', (visible: boolean) => {
            if (visible) {
                setVisible(false);
            }
        });
    }
}

export { ColorPanel };
