import { Mat4, Quat, Vec3 } from 'playcanvas';

import { gradeMatrix, GradeParams } from './color-grade';
import { CropOp, EditOp, EntityTransformOp, ScopedColorOp, SetSplatColorAdjustmentOp, TransformNodeOp, principalOp } from './edit-ops';
import { composeGrades, toGrade } from './grade-palette';
import { keyableLive } from './keyframe-driver';
import { keyable, ParamSpec } from './keyframes';

/**
 * The keyable parameters of the nodes that were there before keys: transform,
 * crop and the scoped colour node. This is all a node needs to be keyed - see
 * keyframes.ts. A node added later does the same next to its own class.
 */

const AXES = ['x', 'y', 'z'] as const;

const placesObject = (op: EditOp, splat: unknown) => {
    const p = principalOp(op);
    return (p instanceof EntityTransformOp || p instanceof TransformNodeOp) && p.splat === splat;
};

const cropTRS = (op: CropOp) => {
    const t = new Vec3();
    const s = new Vec3();
    op.transform.getTranslation(t);
    op.transform.getScale(s);
    return { t, s };
};

const cropSet = (op: CropOp, which: 't' | 's', axis: 'x' | 'y' | 'z', v: number) => {
    const { t, s } = cropTRS(op);
    (which === 't' ? t : s)[axis] = which === 's' ? Math.max(1e-4, v) : v;
    op.setVolume(op.shape, new Mat4().setTRS(t, Quat.IDENTITY, s), op.keepInside);
};

type GradeKey = Exclude<keyof GradeParams, 'tintClr'>;

const GRADE: { key: GradeKey, min: number, max: number }[] = [
    { key: 'temperature', min: -0.5, max: 0.5 },
    { key: 'saturation', min: 0, max: 2 },
    { key: 'exposure', min: -10, max: 10 },
    { key: 'brightness', min: -2, max: 2 },
    { key: 'blackPoint', min: 0, max: 1 },
    { key: 'whitePoint', min: 0, max: 1 },
    { key: 'transparency', min: 0, max: 4 }
];

const withGrade = (op: ScopedColorOp, change: (g: GradeParams) => void) => {
    const g: GradeParams = { ...op.grade, tintClr: op.grade.tintClr.clone() };
    change(g);
    op.setGrade(g);
};

// A function, not module code: the bundle drops a module imported only for
// what it does when it loads.
const registerKeyframeParams = () => {
    // ---- transform: position, rotation (degrees, as typed) and scale per axis

    keyable(TransformNodeOp, [
        ...AXES.map((a): ParamSpec<TransformNodeOp> => ({
            id: `position.${a}`,
            get: op => op.newt.position[a],
            set: (op, v) => {
                op.newt.position[a] = v;
            }
        })),
        ...AXES.map((a): ParamSpec<TransformNodeOp> => ({
            id: `rotation.${a}`,
            get: op => op.euler[a],
            set: (op, v) => {
                const e = op.euler.clone();
                e[a] = v;
                op.setRotation(e.x, e.y, e.z);
            }
        })),
        ...AXES.map((a): ParamSpec<TransformNodeOp> => ({
            id: `scale.${a}`,
            get: op => op.newt.scale[a],
            // a zero scale cannot be taken out again by what follows it
            set: (op, v) => {
                op.newt.scale[a] = v || 1e-4;
            }
        }))
    ]);

    // nothing after it places the object: moving the object is all there is to do
    keyableLive(TransformNodeOp, (op, later) => {
        if (!op.applied || later.some(o => placesObject(o, op.splat))) return false;
        op.preview();
        return true;
    });

    // ---- crop: the volume's centre and size per axis

    keyable(CropOp, [
        ...AXES.map((a): ParamSpec<CropOp> => ({
            id: `centre.${a}`,
            get: op => cropTRS(op).t[a],
            set: (op, v) => cropSet(op, 't', a, v)
        })),
        ...AXES.map((a): ParamSpec<CropOp> => ({
            id: `size.${a}`,
            min: 0,
            get: op => cropTRS(op).s[a],
            set: (op, v) => cropSet(op, 's', a, v)
        }))
    ]);

    // ---- scoped colour: the grade's numbers, the tint per channel

    keyable(ScopedColorOp, [
        ...GRADE.map(({ key, min, max }): ParamSpec<ScopedColorOp> => ({
            id: key,
            min,
            max,
            get: op => op.grade[key] ?? 0,
            set: (op, v) => withGrade(op, (g) => {
                g[key] = v;
            })
        })),
        ...(['r', 'g', 'b'] as const).map((c): ParamSpec<ScopedColorOp> => ({
            id: `tint.${c}`,
            min: 0,
            max: 1,
            get: op => op.grade.tintClr[c],
            set: (op, v) => withGrade(op, (g) => {
                g.tintClr[c] = v;
            })
        }))
    ]);

    // A scoped colour node holds palette slots, each its source slot's grade
    // composed with its own. With no colour node after it on the object, no slot
    // was composed from these, and they can be written again in place.
    keyableLive(ScopedColorOp, (op, later) => {
        const map = (op as any).paletteMap as Map<number, number> | null;
        if (!map || later.some(o => principalOp(o) instanceof ScopedColorOp && (principalOp(o) as ScopedColorOp).splat === op.splat)) {
            return false;
        }
        const palette = op.splat.gradePalette;
        const mine = toGrade(gradeMatrix(op.grade));
        map.forEach((slot, old) => palette.setGrade(slot, composeGrades(palette.getGrade(old), mine)));
        op.splat.scene.forceRender = true;
        return true;
    });

    // ---- the object's own grade (a colour node with nothing selected)

    keyable(SetSplatColorAdjustmentOp, GRADE.map(({ key, min, max }): ParamSpec<SetSplatColorAdjustmentOp> => ({
        id: key,
        min,
        max,
        get: op => op.newState[key] ?? 0,
        set: (op, v) => {
            op.newState = { ...op.newState, [key]: v };
        }
    })));

    // the grade is the object's, read by the shader every frame: with no
    // later grade of the object, setting it is all there is to do
    keyableLive(SetSplatColorAdjustmentOp, (op, later) => {
        if (later.some(o => principalOp(o) instanceof SetSplatColorAdjustmentOp && (principalOp(o) as SetSplatColorAdjustmentOp).splat === op.splat)) {
            return false;
        }
        const s = op.newState;
        GRADE.forEach(({ key }) => {
            if (typeof s[key] === 'number') (op.splat as any)[key] = s[key];
        });
        return true;
    });
};

export { registerKeyframeParams };
