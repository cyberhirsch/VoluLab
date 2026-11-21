/**
 * The cleanup and look nodes, in the order the graph's menus offer them.
 * Each kind is a file of its own here; see fields.ts for what they share.
 * The shadow catcher is a setting of the relight node (relight/relighter.ts).
 */

import { colourMatch } from './colour-match';
import { type LookSpec } from './fields';
import { fillHole } from './fill-hole';
import { flickerRemoval } from './flicker-removal';
import { freezeBackground } from './freeze-background';
import { opacity } from './opacity';
import { stillMovingSplit } from './still-moving-split';
import { temporalDenoise } from './temporal-denoise';

const LOOK_NODES: LookSpec[] = [
    stillMovingSplit,
    temporalDenoise,
    flickerRemoval,
    fillHole,
    freezeBackground,
    opacity,
    colourMatch
];

/** what the graph calls each of them, by op name */
const LOOK_LABELS: Record<string, string> = Object.fromEntries(LOOK_NODES.map(n => [n.kind, n.label]));

export { LOOK_NODES, LOOK_LABELS };
