import { type FieldSpec, type LookSpec } from './fields';
import { diagGrade, GradeRowsOp, gradedColour } from './grade-rows';
import { scopeRows, sigmoid } from './measure';
import { PortSpec } from '../edit-ops';
import { Splat } from '../splat';
import { State } from '../splat-state';

const colourStats = (splat: Splat, rows: Uint32Array | null) => {
    const data = splat.splatData;
    const colourOf = gradedColour(splat);
    const rgba = [0, 0, 0, 1];
    const opacity = data.getProp('opacity') as Float32Array;
    const state = data.getProp('state') as Uint8Array;
    const n = data.numSplats;
    const sum = [0, 0, 0];
    const sq = [0, 0, 0];
    let weight = 0;
    const visit = (r: number) => {
        colourOf(r, rgba);
        const w = (opacity ? sigmoid(opacity[r]) : 1) * rgba[3];
        weight += w;
        for (let c = 0; c < 3; ++c) {
            const v = rgba[c];
            sum[c] += w * v;
            sq[c] += w * v * v;
        }
    };
    if (rows) {
        rows.forEach(visit);
    } else {
        for (let r = 0; r < n; ++r) {
            if ((state[r] & State.deleted) === 0) visit(r);
        }
    }
    if (!(weight > 0)) return null;
    const mean = sum.map(s => s / weight);
    const std = sq.map((s, c) => Math.sqrt(Math.max(1e-8, s / weight - mean[c] * mean[c])));
    return { mean, std };
};

type MatchMode = 'mean' | 'spread';

/**
 * Colour match: grades this object's colours - the selection's, or all of
 * them - so their mean (and with "spread", their contrast) per channel are
 * the reference's: another object, or what is selected on it. So merged
 * captures read as one scene. Both are measured on the captured colours,
 * opacity weighted, before either object's own grade, which still applies
 * on top. `strength` blends between no change and the full match.
 */
class ColourMatchOp extends GradeRowsOp {
    name = 'colourMatch';
    reference: Splat | null;
    mode: MatchMode;
    strength: number;

    constructor(splat: Splat, reference: Splat | null = null, settings: Partial<{ mode: MatchMode, strength: number }> = {}) {
        super(splat);
        this.reference = reference;
        this.mode = settings.mode === 'mean' ? 'mean' : 'spread';
        this.strength = settings.strength ?? 1;
    }

    /** the reference is wired into a port, like a light's source */
    accepts(port: string, source: object | null) {
        return port === 'reference' && (source === null || (source instanceof Splat && source !== this.splat));
    }

    connect(port: string, source: object | null) {
        if (this.accepts(port, source)) this.reference = source as Splat | null;
    }

    get ports(): PortSpec[] {
        return [{ name: 'reference', label: 'reference', accepts: ['object'], source: this.reference }];
    }

    get settings() {
        return { mode: this.mode, strength: this.strength };
    }

    get sourceLabel() {
        return this.reference ? `to ${this.reference.name}` : 'no reference';
    }

    protected plan(splat: Splat, rows: Uint32Array) {
        const ref = this.reference;
        if (!ref?.splatData || ref === splat || !ref.scene) return null;
        const refRows = scopeRows(ref);
        const want = colourStats(ref, refRows.rows);
        const have = colourStats(splat, rows);
        if (!want || !have) return null;
        const s = Math.min(1, Math.max(0, this.strength));
        const gain = [0, 1, 2].map(c => (this.mode === 'spread' ? Math.min(4, Math.max(0.25, want.std[c] / have.std[c])) : 1));
        const g = gain.map(v => 1 + s * (v - 1));
        const t = [0, 1, 2].map(c => s * (want.mean[c] - gain[c] * have.mean[c])) as [number, number, number];
        return { bucket: new Int32Array(rows.length), grades: [diagGrade(g[0], g[1], g[2], t)] };
    }

    fields(): FieldSpec[] {
        return [
            { kind: 'object',
                label: 'node.match.reference',
                value: this.reference,
                exclude: this.splat,
                apply: (v) => {
                    this.reference = v;
                } },
            { kind: 'choice',
                label: 'node.match.mode',
                value: this.mode,
                options: [['mean', 'node.match.mean'], ['spread', 'node.match.spread']],
                apply: (v) => {
                    this.mode = v as MatchMode;
                } },
            { kind: 'slider',
                label: 'node.match.strength',
                value: this.strength,
                min: 0,
                max: 1,
                step: 0.05,
                apply: (v) => {
                    this.strength = v;
                },
                format: v => `${Math.round(v * 100)}%` },
            ...this.scopeStat(),
            { kind: 'note', text: this.reference ? 'node.match.note' : 'node.match.none' }
        ];
    }

    destroy() {
        super.destroy();
        this.reference = null;
    }
}

/** kept as what it did, on the grade palette: see doc-looks.ts */
const colourMatch: LookSpec = {
    kind: 'colourMatch',
    label: 'colour match',
    hint: 'colours matched to another object',
    // matched to the first other object; the port or the pane changes it
    create: (splat, others) => new ColourMatchOp(splat, others.find(s => s.visible) ?? null)
};

export { ColourMatchOp, colourMatch };
