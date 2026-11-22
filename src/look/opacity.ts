import { type FieldSpec, type LookSpec } from './fields';
import { diagGrade, GradeRowsOp } from './grade-rows';
import { Splat } from '../splat';

/**
 * Opacity: scales the opacity of the selection, or of the whole object - 0
 * hides it, 1 leaves it, above 1 fills thin gaussians in. A plain number,
 * which the keyframe work makes keyable over time for fades.
 */
class OpacityOp extends GradeRowsOp {
    name = 'opacityNode';
    value: number;

    constructor(splat: Splat, value = 0.5) {
        super(splat);
        this.value = value;
    }

    get settings() {
        return { value: this.value };
    }

    get sourceLabel() {
        return `× ${+this.value.toFixed(2)}`;
    }

    protected plan(splat: Splat, rows: Uint32Array) {
        if (this.value === 1) return null;
        return { bucket: new Int32Array(rows.length), grades: [diagGrade(1, 1, 1, [0, 0, 0], Math.max(0, this.value))] };
    }

    fields(): FieldSpec[] {
        return [
            { kind: 'slider',
                label: 'node.opacity.value',
                value: this.value,
                min: 0,
                max: 2,
                step: 0.01,
                apply: (v) => {
                    this.value = v;
                },
                format: v => `${Math.round(v * 100)}%` },
            this.scopeStat(),
            { kind: 'note', text: 'node.opacity.note' }
        ];
    }
}

/** Mean and spread of the colour of `rows`, weighted by opacity. */

/** kept as what it did, on the grade palette: see doc-looks.ts */
const opacity: LookSpec = {
    kind: 'opacityNode',
    label: 'opacity',
    hint: 'opacity of the selection or the object scaled',
    create: splat => new OpacityOp(splat)
};

export { OpacityOp, opacity };
