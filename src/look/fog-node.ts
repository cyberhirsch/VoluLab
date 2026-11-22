import { BoundingBox } from 'playcanvas';

import { type FieldNode, type FieldSpec, type LookSpec } from './fields';
import { normalizeFog, type FogMode, type FogSettings } from '../fog';
import { Splat } from '../splat';

/**
 * Fog / depth tint: the object's colour blends towards a fog colour by how
 * far it is from the camera, or how low it stands in the world - drawn in
 * the splat shader, so it follows the camera and the video export. The
 * object holds the settings while the node is applied (Splat.fog); with
 * several, the last applied is the one drawn. Whole objects only: it is
 * where an object sits in the view, not which of its gaussians, that it is
 * about. Files written from the object do not carry it.
 */
class FogOp implements FieldNode {
    name = 'fogNode';
    splat: Splat;
    fog: FogSettings;
    bypassed?: boolean;
    private before: FogSettings | null = null;
    private applied: FogSettings | null = null;

    constructor(splat: Splat, settings: Partial<FogSettings> = {}) {
        this.splat = splat;
        this.fog = normalizeFog(settings);
    }

    /** where fog starts and ends for an object this size, so the node shows something at once */
    static defaultsFor(splat: Splat, mode: FogMode = 'depth'): Partial<FogSettings> {
        const bound = splat.worldBound as BoundingBox;
        if (mode === 'height') {
            // the lowest quarter of the object
            const bottom = bound ? bound.center.y - bound.halfExtents.y : 0;
            const tall = bound ? Math.max(1e-3, bound.halfExtents.y * 2) : 1;
            return { mode, start: +bottom.toFixed(3), end: +(bottom + tall * 0.25).toFixed(3) };
        }
        // from the camera to twice as far as the object stands from it now,
        // half way at the object: a capture's bound is stretched by its
        // floaters, the view is not
        const camera = splat.scene?.camera?.mainCamera?.getPosition();
        const away = camera && bound ? camera.distance(bound.center) : (bound ? bound.halfExtents.length() : 1);
        const d = Math.max(1e-3, away);
        return { mode, start: 0, end: +(d * 2).toFixed(3) };
    }

    get settings() {
        return { ...this.fog, colour: [...this.fog.colour] };
    }

    get sourceLabel() {
        return this.fog.mode;
    }

    do() {
        const { splat } = this;
        this.fog = normalizeFog(this.fog);
        this.before = splat.fog;
        this.applied = this.fog;
        splat.fog = this.fog;
        if (splat.scene) splat.scene.forceRender = true;
    }

    undo() {
        const { splat } = this;
        if (splat.fog === this.applied) splat.fog = this.before;
        this.applied = null;
        this.before = null;
        if (splat.scene) splat.scene.forceRender = true;
    }

    destroy() {
        this.splat = null;
    }

    fields(): FieldSpec[] {
        const f = this.fog;
        return [
            { kind: 'choice',
                label: 'node.fog.mode',
                value: f.mode,
                options: [['depth', 'node.fog.depth'], ['height', 'node.fog.height']],
                apply: (v) => {
                    const d = FogOp.defaultsFor(this.splat, v as FogMode);
                    this.fog = normalizeFog({ ...f, ...d });
                } },
            { kind: 'colour',
                label: 'node.fog.colour',
                value: f.colour,
                apply: (v) => {
                    this.fog = normalizeFog({ ...f, colour: v });
                } },
            { kind: 'slider',
                label: 'node.fog.amount',
                value: f.amount,
                min: 0,
                max: 1,
                step: 0.01,
                apply: (v) => {
                    this.fog = normalizeFog({ ...f, amount: v });
                },
                format: v => `${Math.round(v * 100)}%` },
            { kind: 'number',
                label: f.mode === 'depth' ? 'node.fog.near' : 'node.fog.low',
                value: f.start,
                step: 0.1,
                neutral: 0,
                apply: (v) => {
                    this.fog = normalizeFog({ ...f, start: v, end: Math.max(f.end, v + 1e-3) });
                } },
            { kind: 'number',
                label: f.mode === 'depth' ? 'node.fog.far' : 'node.fog.high',
                value: f.end,
                step: 0.1,
                neutral: f.start + 1,
                apply: (v) => {
                    this.fog = normalizeFog({ ...f, end: v });
                } },
            { kind: 'note', text: f.mode === 'depth' ? 'node.fog.note-depth' : 'node.fog.note-height' }
        ];
    }
}

const fog: LookSpec = {
    kind: 'fogNode',
    label: 'fog / depth tint',
    hint: 'colour blended to a fog colour by distance or height',
    create: splat => new FogOp(splat, FogOp.defaultsFor(splat)),
    restore: (splat, settings) => new FogOp(splat, settings ?? {}),
    stored: true
};

export { FogOp, fog };
