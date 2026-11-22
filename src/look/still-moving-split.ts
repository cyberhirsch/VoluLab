import { type FieldNode, type FieldSpec, type LookSpec } from './fields';
import { GSV_MAX_DRIFT, stillFlags } from './measure';
import { SplitOp, type SplitBuilt } from '../edit-ops';
import { Scene } from '../scene';
import { Splat } from '../splat';
import { State } from '../splat-state';

/** what the part split off is called: the source's name and the part */
const partName = (source: Splat | null, part: StillPart) => `${(source?.name ?? 'object').replace(/\.[^.]+$/, '').replace(/-(still|moving)$/, '')}-${part}`;

/** name an object, in the scene or not yet (the setter tells the scene) */
const nameSplat = (splat: Splat, name: string) => {
    if (splat.scene) {
        splat.name = name;
    } else {
        (splat as any)._name = name;
    }
};

type StillPart = 'still' | 'moving';

/**
 * Still / moving split: a split node whose rows are picked by motion rather
 * than by a selection. The object keeps one part and the other becomes an
 * object of its own, in its own lane - the two outputs. By default the
 * object keeps the still part, the background, and the moving part leaves.
 *
 * The rule is the one the compact GSV export splits by (see stillFlags), and
 * the threshold scales its drift: 0.001 of a gaussian's thinnest axis over
 * the sequence. With "fading is moving" off, a gaussian that fades in or out
 * but does not move counts as still. A 3D object is all still.
 */
class StillMovingSplitOp extends SplitOp implements FieldNode {
    name = 'stillMovingSplit';

    /** drift over the sequence, as a share of the thinnest axis, still up to here */
    drift: number;
    /** a gaussian that fades over the sequence is moving */
    fade: boolean;
    /** the part the object keeps; the other is the new object */
    keep: StillPart;

    constructor(scene: Scene, source: Splat, output: Splat, rows: Uint32Array, build: (source: Splat, rows: Uint32Array) => Promise<SplitBuilt>, settings: Partial<{ drift: number, fade: boolean, keep: StillPart }> = {}) {
        super(scene, source, output, rows, build, 'move');
        this.drift = settings.drift ?? GSV_MAX_DRIFT;
        this.fade = settings.fade ?? true;
        this.keep = settings.keep === 'moving' ? 'moving' : 'still';
    }

    /** the rows the new object gets, for these settings */
    static rowsOf(source: Splat, drift: number, fade: boolean, keep: StillPart) {
        const flags = stillFlags(source, drift, fade);
        const state = source.splatData.getProp('state') as Uint8Array;
        const want = keep === 'still' ? 0 : 1;
        let k = 0;
        for (let i = 0; i < flags.length; ++i) {
            if (flags[i] === want && (state[i] & State.deleted) === 0) k++;
        }
        const rows = new Uint32Array(k);
        k = 0;
        for (let i = 0; i < flags.length; ++i) {
            if (flags[i] === want && (state[i] & State.deleted) === 0) rows[k++] = i;
        }
        return rows;
    }

    protected pickRows(source: Splat) {
        return StillMovingSplitOp.rowsOf(source, this.drift, this.fade, this.keep);
    }

    async do() {
        await super.do();
        // the new object is named for the part it holds, which the settings can swap
        if (this.output?.scene) nameSplat(this.output, partName(this.inputs[0], this.keep === 'still' ? 'moving' : 'still'));
    }

    get sourceLabel() {
        return this.keep === 'still' ? 'keeps still' : 'keeps moving';
    }

    get settings() {
        return { drift: this.drift, fade: this.fade, keep: this.keep };
    }

    fields(): FieldSpec[] {
        const source = this.inputs?.[0];
        const n = this.selectedIn;
        const total = source?.splatData?.numSplats ?? 0;
        return [
            { kind: 'choice',
                label: 'node.stillMoving.keep',
                value: this.keep,
                options: [['still', 'node.stillMoving.still'], ['moving', 'node.stillMoving.moving']],
                apply: (v) => {
                    this.keep = v as StillPart;
                } },
            { kind: 'slider',
                label: 'node.stillMoving.drift',
                value: Math.log10(this.drift),
                min: -4,
                max: 1,
                step: 0.05,
                apply: (v) => {
                    this.drift = 10 ** v;
                },
                format: v => `${+(10 ** v).toPrecision(2)}` },
            { kind: 'choice',
                label: 'node.stillMoving.fade',
                value: this.fade ? 'yes' : 'no',
                options: [['yes', 'node.look.yes'], ['no', 'node.look.no']],
                apply: (v) => {
                    this.fade = v === 'yes';
                } },
            { kind: 'stat', label: 'node.stillMoving.out', value: n < 0 ? 'node.look.not-applied' : `${n.toLocaleString()} / ${total.toLocaleString()}`, raw: n >= 0 },
            { kind: 'note', text: source?.motion ? (n === 0 ? 'node.stillMoving.none' : 'node.stillMoving.note') : 'node.stillMoving.still3d' }
        ];
    }
}

/** the editor builds the part that leaves (look/register.ts), so there is no create or restore here */
const stillMovingSplit: LookSpec = { kind: 'stillMovingSplit', label: 'still / moving split', hint: 'the still and the moving gaussians as two objects' };

export { StillMovingSplitOp, stillMovingSplit, partName, nameSplat, type StillPart };
