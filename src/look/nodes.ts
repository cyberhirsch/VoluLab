/**
 * The cleanup and look nodes, in the order the graph's menus offer them.
 * Each kind is a file of its own here; see fields.ts for what they share.
 * The shadow catcher is a setting of the relight node (relight/relighter.ts).
 */

import { type LookSpec } from './fields';
import { stillMovingSplit } from './still-moving-split';

const LOOK_NODES: LookSpec[] = [
    stillMovingSplit
];

/** what the graph calls each of them, by op name */
const LOOK_LABELS: Record<string, string> = Object.fromEntries(LOOK_NODES.map(n => [n.kind, n.label]));

export { LOOK_NODES, LOOK_LABELS };
