/**
 * The cleanup and look nodes (src/look/): what each lists of its settings
 * for the node pane, and what each kind is to the menus and the project.
 *
 * They work through three mechanisms the editor already has, so none of
 * them adds a pass of its own to the renderer:
 *
 *  - A 4D model's motion (Splat.motion): per gaussian a velocity, a
 *    temporal centre and a temporal falloff. Nodes that edit those hand the
 *    object new motion (setMotion), which gives the shader new textures and
 *    the sort worker the new model. The splat data - position, shape,
 *    colour - is not touched, so a project, which stores a 4D model as its
 *    source file, keeps the node and applies it again on open.
 *  - The state bits, as cleanup and delete use them.
 *  - The grade palette (grade-palette.ts): per gaussian an index into a
 *    palette of affine colour grades with an alpha scale, as the scoped
 *    colour node uses it.
 *
 * Each node acts on what the select nodes above it left selected, or on the
 * whole object when nothing is (the PRD's "selections travel with the
 * stream").
 */

import { EditOp } from '../edit-ops';
import { Scene } from '../scene';
import { Splat } from '../splat';

type FieldSpec =
    | { kind: 'slider', label: string, value: number, min: number, max: number, step: number, apply: (v: number) => void, format?: (v: number) => string }
    | { kind: 'number', label: string, value: number, step: number, neutral: number, apply: (v: number) => void }
    | { kind: 'choice', label: string, value: string, options: [string, string][], apply: (v: string) => void }
    | { kind: 'colour', label: string, value: [number, number, number], apply: (v: [number, number, number]) => void }
    | { kind: 'object', label: string, value: Splat | null, exclude: Splat | null, apply: (v: Splat | null) => void }
    | { kind: 'stat', label: string, value: string, raw?: boolean }
    | { kind: 'note', text: string };

/**
 * A node that lists its settings for the node pane. Labels, option texts
 * and notes are i18n keys; stat values are shown as they are, or as keys
 * when they start with 'node.'.
 */
interface FieldNode {
    fields(scene: Scene): FieldSpec[];
    /** JSON-safe settings, which its kind's `restore` makes the node from again */
    settings: Record<string, any>;
    /** whether a wire from `source` (null: none) can go into its input `port` */
    accepts?(port: string, source: object | null): boolean;
    /** take `source` into `port` (null: unwire); the editor replays the node around it */
    connect?(port: string, source: object | null): void;
}

const isFieldNode = (op: unknown): op is FieldNode & EditOp => typeof (op as any)?.fields === 'function';

const count = (n: number) => (n < 0 ? 'node.look.not-applied' : n.toLocaleString());

/** A kind of node, as the graph's menus offer it and a project stores it. */
type LookSpec = {
    /** the op's name */
    kind: string;
    /** the menu label, and what the graph calls the node */
    label: string;
    /** what it is for */
    hint: string;
    /** a new node on `splat`, with the settings it starts with; `others` are the scene's other objects */
    create?: (splat: Splat, others: Splat[]) => (EditOp & FieldNode) | null;
    /** the node again from what a project stored of it; `objects` resolves a stored object index */
    restore?: (splat: Splat, settings: any, objects: (i: number) => Splat | null) => (EditOp & FieldNode) | null;
    /** a project stores it as a node (doc-looks.ts); otherwise what it did is stored, or nothing */
    stored?: boolean;
};

export { isFieldNode, count, type FieldSpec, type FieldNode, type LookSpec };
