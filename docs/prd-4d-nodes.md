# PRD: Nodes for editing and compositing 4D Gaussian splats

Status: draft, 2026-11-21. Scope: VoluLab node graph (`src/edit-history.ts`, `src/edit-ops.ts`, `src/ui/graph-panel.ts`).

## Goal

Make VoluLab a compositor for 4D Gaussian splats: several sources, cut in time and space, combined into one scene, graded and exported as GSV, PLY sequence or video. Every node is non-destructive, stored in the project, and works the same on 3D (one frame) and 4D (frames with motion).

## Existing nodes (not part of this PRD)

import, train, camera, light, select, colour, crop, transform, delete, trim, retime, loop, freeze frame, time offset, split, cleanup, decimate, sh bands, relight, debug view, voxelise, output.

## Shared rules for new nodes

- **Inputs and outputs** are splat streams: per gaussian position, rotation, scale, opacity, SH, plus optional per frame motion and a time range.
- **Selections travel with the stream.** A node that takes a selection acts only on the selected gaussians; with none, on all.
- **Time-aware parameters.** Every numeric parameter can be keyed over time (see *keyframe*); without keys it is constant.
- **Static vs dynamic stays explicit.** Nodes keep the still/moving split so the sort worker and the compact GSV export can keep using it.
- **Preview at interactive speed** on the alley sample (1.9 M gaussians, 100 frames); heavy work runs in a worker and caches per frame.
- **Undo, project save and i18n** for every node, as for the existing ones.

## New nodes

Priority: **P1** needed for basic compositing, **P2** strongly useful, **P3** later.

### Combining

| Node | Priority | What it does |
|---|---|---|
| **merge** | P1 | Combines two or more streams into one scene. Each input keeps its own transform and time offset; time ranges are unioned, an input outside its range contributes nothing. Options: unify SH degree (pad or truncate), rename layers. The core compositing node. |
| **switch** | P2 | Passes one of several inputs, chosen by an index that can be keyed over time. For takes, A/B comparisons and cuts between captures. |
| **instance** | P3 | Places copies of one stream at several transforms (a list or a grid), each with its own time offset, without duplicating the data in memory. For crowds, repeated props, loops offset in time. |
| **layer** | P2 | Groups a branch under a name with visibility, solo, lock and an opacity multiplier, as a layer list next to the graph. Opacity scales gaussian opacity, it does not blend images. |

### Selecting and masking in space and time

| Node | Priority | What it does |
|---|---|---|
| **select by motion** | P1 | Selects gaussians by speed or travelled distance over a time range (threshold, min/max), using the velocity the debug view shows. Separates actors from the set in one step. |
| **select by colour** | P2 | Selects by colour distance to a picked colour (RGB or hue/saturation/value tolerances), for chroma-key cleanup and isolating objects. |
| **select by region over time** | P1 | A box, sphere or brush volume that can be keyed or attached to a tracked point, so a selection follows a moving subject. |
| **select by attribute** | P2 | Selects by opacity, scale, distance from camera or density, with a histogram to pick thresholds. Covers floaters and needle splats. |
| **grow / shrink selection** | P2 | Expands or erodes a selection by neighbour distance, in space and optionally across frames. |
| **invert / combine selections** | P1 | Union, intersection, difference and inversion of named selections. |
| **holdout** | P2 | Uses a stream or a selection as a matte: the gaussians render to depth but not colour, so they hide what is behind them. For placing a 4D actor behind a real foreground. |

### Transforming over time

| Node | Priority | What it does |
|---|---|---|
| **keyframe** | P1 | Adds keyframed values to any node parameter (position, rotation, scale, colour, opacity) with linear, ease and step interpolation and a curve editor. Not a node of its own in the chain but a property of every node; listed here because it is required work. |
| **track / attach** | P2 | Fits a rigid transform per frame to a selection's motion and exposes it, so another stream or a camera can be parented to it (e.g. a hat on a moving head). |
| **stabilise** | P2 | Removes a selection's per frame rigid motion from the whole stream, or from the rest of it, to fix a shaking capture rig. |
| **align** | P2 | Aligns one stream to another by picked point pairs or by ICP on overlapping static gaussians; outputs a transform node. Needed before merging captures. |
| **ground plane** | P1 | Sets up axis and floor height from three picked points or a fitted plane. Fixes the up-axis problem per source. |
| **time warp** | P3 | Retimes with a curve instead of a constant factor (speed ramps), interpolating motion between frames. |
| **motion scale** | P3 | Multiplies or damps motion around the rest pose (0 freezes, 1 original, 2 exaggerates), optionally smoothed over time to remove jitter. |
| **motion blur** | P3 | Stretches gaussians along their velocity for rendering and video output; parameter is shutter angle. |

### Cleanup and quality

| Node | Priority | What it does |
|---|---|---|
| **temporal denoise** | P2 | Smooths flickering gaussians: low-pass of position, colour and opacity over frames, with a threshold so real motion is kept. |
| **flicker removal** | P2 | Removes gaussians that appear for very few frames (lifetime threshold) or toggle opacity, the 4D equivalent of floaters. |
| **fill hole** | P3 | Copies gaussians from neighbouring frames into regions where a frame lost coverage, limited to static gaussians. |
| **static / dynamic split** | P1 | Splits a stream into still and moving gaussians by a motion threshold, as two outputs, so each part can be cleaned, decimated and exported on its own. Exposes the split the compact GSV export already uses. |
| **freeze background** | P2 | Replaces the static part with one frame (or the median over frames), removing background flicker and saving memory. |

### Look and grading

| Node | Priority | What it does |
|---|---|---|
| **colour match** | P2 | Matches one stream's colour statistics to another's or to a picked reference region, so merged captures look like one scene. |
| **exposure / white balance over time** | P2 | Colour node parameters keyed over time, plus an automatic mode that evens out exposure drift between frames. |
| **opacity** | P1 | Scales opacity of a stream or selection, keyable for fades in and out. |
| **fog / depth tint** | P3 | Blends colour towards a fog colour by distance from the camera or height, to sit inserted elements into a scene. |
| **relight shadow catcher** | P3 | Extends relight so inserted gaussians cast an approximate shadow onto a ground plane or the background stream. |

### Output and inspection

| Node | Priority | What it does |
|---|---|---|
| **render passes** | P2 | The output node writes separate passes for video: beauty, alpha, depth, velocity, selection matte, for compositing in Nuke, Resolve or After Effects. |
| **viewer** | P2 | A tap that shows any point in the graph in the viewport without changing the active output, like a Nuke viewer. |
| **cache** | P2 | Bakes a branch's result to memory or disk per frame so expensive upstream nodes are not recomputed while editing downstream. |
| **stats** | P3 | Shows count, still/moving share, memory, bounds and per frame changes at this point in the graph. |

## Out of scope

- Training or refining gaussians inside the graph beyond the existing train node.
- Mesh conversion and physics.
- Audio.

## Open questions

1. Is *keyframe* a property of every parameter (recommended) or an explicit node in the chain?
2. Does *merge* resample inputs to a common frame rate, or require equal rates and refuse otherwise?
3. Does *holdout* need depth output from the splat renderer, which WebGL2 may not support?
4. Which format carries several layers: one GSV per layer, or a layered GSV extension in `docs/format-gsv.md`?

## Suggested order

1. merge, static / dynamic split, select by motion, invert / combine selections, opacity, ground plane.
2. keyframe on parameters, select by region over time.
3. align, colour match, temporal denoise, flicker removal, viewer, cache.
4. The rest.
