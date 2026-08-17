# Node backlog

**Status: every node on this list is built, and one piece of plumbing is
not** - the COLMAP bridge under *Next* at the bottom. Everything else left is
under *Known limits*: not missing nodes, but places where a node works and
could work better, each with what it would take.

Candidate nodes for the graph, ordered by what they cost rather than by how
they read. A lot of the work is already done: several of these are a *face*
over an edit op that exists and already takes part in undo, bypass and
re-evaluation. The tiers say which.

Terms used below:

- **op** — an `EditOp` in `src/edit-ops.ts`. Every node in the graph is one.
- **selection-scoped** — acts on the selected gaussians rather than the whole
  object. This is the property that makes a node belong in a graph whose
  premise is *select, then operate*.

---

## Colour selection-scoped — done

A colour node added with a selection grades those gaussians; added with
nothing selected it grades the object, which is still the right thing for
"make this whole thing warmer".

How it works, in the order the pieces were built:

1. `gradeMatrix` in `src/color-grade.ts` folds the eight parameters into a
   3x3 matrix and a translation. Saturation is a linear map and the levels are
   affine, so nothing is lost - and two grades compose by multiplying, which
   the parameter form cannot express.
2. `src/grade-palette.ts` holds grades in a texture, one slot each, following
   the contract `TransformPalette` sets. Grades store a translation *vector*,
   because composing two does not keep the offset grey.
3. `Splat.gradeTexture` carries a per-gaussian slot index. Index 0 means no
   node has touched it, which is every gaussian until one does.
4. The shader applies the node grade first, then the object's. Keeping the
   object grade out of the palette is what lets it stay live rather than
   being frozen into each slot at the moment a node ran.
5. `ScopedColorOp` allocates one new slot per distinct slot the selection
   already sits on, each holding that slot's grade composed with the node's.
   Undo runs the map backwards, reversing by slot rather than by selection.
6. The colour panel binds to a node and commits at the end of a gesture.
7. `src/splat-serialize.ts` does the same lookup on the cpu, so what is
   written out matches what is on screen.

Two traps worth keeping in mind if this is touched again:

- **GLSL reads a mat3 column-major** and this matrix is not symmetric.
  Emitting it row-major grades plausibly and wrongly.
- **The translation must be a vector.** One number is enough for a single
  grade and not enough for two composed.

## Tier A — done

### Output node — done

Carries format, filename, SH band count and selection scope, and drives
`scene.write` directly rather than reopening the export dialog. Not an edit:
`do`/`undo` are no-ops. Writing winds the history to the node's position
first and back afterwards, so where it sits in the chain is what it exports.
Drawn with an input and no output.

### Transform node — done

Shows position, rotation and scale; editing a field replays from that node.
A transform is committed bundled with its pivot placement, so ops are now
named and edited by their principal member (`principalOp` in
`src/edit-ops.ts`) rather than being drawn as "combined edit".

Worth knowing: a world-space selection downstream of a transform will
legitimately catch different splats after the object moves. That is the
model working — see the note on the model matrix in `src/select-query.ts`.

### Delete / restore / hide — done

No parameters to turn, so they report what they did: how many splats they
touched, read from what the op resolved rather than recomputed, plus a line
on what bypassing one means. `StateOp.affected` is the accessor.

### Transform splats — done

`SplatsTransformOp` moves the selected gaussians rather than the object, so
it is the one node that already does real per-gaussian work. Read-only: the
op carries its matrix alongside a map of the transform-palette slots it moved
things between, and the two have to agree, so editing the matrix would mean
rebuilding the map. That is the gizmo's job rather than a text field's.

---

## Tier B — done

### SH bands node — done

`SetShBandsOp` caps `splat.shBandLimit`, which meets the view setting and the
file's own band count in `rebuildMaterial`. A limit rather than a truncation,
so it is reversible and the viewport previews it.

### Crop node — done

`CropOp`: a box or sphere, keep inside or outside, position and size as
numbers. Resolves through the same `resolveHits` the shape selections use.
A fresh one sits 5% wider than the object, since a box exactly on the bound
puts every surface gaussian on the boundary.

Only ever adds to what is deleted — widening it does not resurrect what an
earlier node removed. Bypassing that node does.

### Merge node — done

Two objects into one, and the first node with more than one input.

The realisation that made this small: **a linear history is already a
topological order of a DAG.** The array says when things ran; a node's
`inputs` say what fed what. `EditHistory` did not need rewriting.

Replay still invalidates everything after a node, which with branches is
conservative rather than exact - it may re-resolve a node no path reaches.
That is correct, and cheaper than maintaining a second ordering that has to
stay consistent with the first. If it ever becomes slow, the fix is to walk
`inputs` backwards from the changed node rather than to restructure history.

In the graph: an object produced by a node gets no import node, since its lane
starts at the node that made it. Edges now come from two places and mean
different things - the chain edges say "then", the input edges say "from".

`MergeOp` builds its output before the op exists, because building it means
writing both objects out and reading them back, and `do` has to be repeatable.
So `do` adds an object that already exists, and hides the two that fed it,
reversibly.

Open: merging is offered by name in the context menu. The gesture it wants is
dragging one node's output onto another's input, which needs ports that can
*accept* a drop as well as start one.

### Frames — done

**One edit, all frames.** When a sequence advances, `EditHistory.reapplyAll`
re-runs the history against the frame that just arrived, so a selection
catches whatever is inside it on this frame and a grade follows the shot.

It does not undo first, and that is the important part. Undo reverses an op
using what it resolved against the *old* data, and that data is gone - the
indices it holds now point at different gaussians or at none. So the cursor
resets without reversing, every op forgets what it resolved, and the history
is applied forward onto the new frame from clean.

A frozen selection cannot follow. Its positions belong to one particular
array, so it records the gaussian count it was captured at and resolves to
nothing when that no longer matches - visibly nothing, rather than the wrong
gaussians, which is what it did before the check existed.

There is no separate "frame node": the decision made one unnecessary. Every
node applies to every frame, so a node naming a frame range would be a
different feature (grading one shot differently from another), not this one.

---

## Tier C — done

### Cleanup / floater removal — done

`CleanupOp`. Mean distance to the k nearest neighbours, thresholded at so
many deviations above average. Neighbours come from a uniform grid sized for
a handful of points per cell, searched outward a ring at a time. Parameters
are neighbour count and spread.

Runs on the CPU inside the op's resolver. Fine at the counts tested; a
million-point capture will want this moved to a worker, which is a change of
where it runs rather than of what it does.

### Decimate — done

`DecimateOp`. Ranks by opacity times footprint and drops the least important
until a fraction remains. Ranking rather than thresholding, because "keep
40%" transfers between captures in a way "alpha above 0.03" does not.

Open: the ordering is not yet stable across the frames of a sequence, so a
decimated sequence may shimmer. That matters only once the frame node exists.

### Voxelise — done

**A new element type**, not grid-aligned splats. `src/voxels.ts` holds a grid
of filled cells: a cell index and a colour, and nothing else. No covariance,
no view-dependent shading, no per-gaussian state - those are what a voxel
format does not want, and carrying them would mean discarding them at export.

Resampling takes the opacity-weighted mean colour of whatever lands in a cell.
Weighted rather than counted evenly, because a capture is mostly faint
gaussians and an unweighted mean lets a cloud of near-invisible points outvote
the few solid ones that describe the surface. Empty cells are absent rather
than stored, since a capture fills a shell.

This is the node that needed the DAG: its output is not the same kind of thing
as its input, so it cannot be another link in that object's chain.

---

## Train — done

Gaussians are made in VoluLab now, not only edited. **Brush**
(github.com/cyberhirsch/brush, Apache-2.0) is a 3DGS trainer in Rust on
wgpu; compiled to WASM it trains on a WebGPU device inside the app. No
server, no CUDA, and the same code path on Mac and PC - which is what ruled
out the CUDA trainers, whose kernels cannot cross into a browser at all.

`TrainOp` is the record: dataset name, the config the run used, iterations,
final splat count, PSNR. Like merge and voxelise the output exists before the
op does - training is a long job driven from the pane, and the node is
committed with its product. Its *retrain* button reopens the pane with those
settings, and everything downstream replays onto the new output.

Pieces: `src/training/brush-engine.ts` (device, pump loop, pause by not
pumping), `preview-renderer.ts` (point sprites off Brush's own GPU buffers -
watching a reconstruction appear does not need gaussian rendering),
`src/ui/training-panel.ts`, and `scripts/build-brush.mjs` producing the wasm
under `static/brush/pkg`. The fork adds three entry points brush-js lacked:
start from bytes, start from a URL, and read the result back as a PLY.

Worth knowing: training runs on its *own* WebGPU device, separate from the
WebGL2 device the rest of the app renders with. The finished splats cross
that boundary as PLY bytes, which is why the preview lives in the pane rather
than in the viewport.

---

## Next

### COLMAP bridge — decided, not started

Training needs posed images. Today a video is ingested to frames and VoluLab
writes a `run-colmap` script for the user to run - honest, but it leaves the
app, and dropping raw frames into the pane just answers *format not
recognized*.

**A local bridge, not a port.** COLMAP will not compile to WASM in any form
worth having: it wants Ceres, SuiteSparse and CUDA SIFT, and a browser build
means CPU-only feature extraction plus threads, which means SharedArrayBuffer
and COOP/COEP headers - the exact requirement avoiding which is why Brush was
chosen. So COLMAP stays native and fast, and a small local helper process
drives it, with the training pane talking to it over localhost.

The shape: drop a video or a folder of frames, VoluLab extracts and posts
them, the bridge runs feature extraction, matching and mapping, and hands
back a dataset the pane starts training on. Progress streams back so the
pane can show which stage is running.

The cost, stated plainly: this is the first piece of VoluLab that is not
client-side. It has to stay strictly optional - everything already built
must keep working with no bridge running, and a posed dataset must still be
loadable by hand.

---

## Known limits

Every node works. These are the places where one could work better, and what
each would take:

**Training is Chromium-only, and unproven end to end.** Brush's backward
kernels need WebGPU subgroups, which Firefox and Safari do not expose yet;
the pane says so rather than failing obscurely. And no full run has been
watched from dataset to committed node - the pieces typecheck, build and
load, but a real training run is the next thing to sit down and verify.

**The viewport is still WebGL2 while training is WebGPU.** Two devices, so
splats cross between them as PLY bytes and the live preview has to live in
the training pane. Moving the viewport to WebGPU would let the trainer's
buffers be rendered directly, with no copy and no second canvas - it means
porting sixteen shaders and the render-target readbacks in
`src/data-processor`, which is its own project.

**The voxel renderer is a box entity per cell.** Certainly correct, no custom
shader, and slow once the count runs to thousands. Fast means instancing with
a per-instance colour stream - a vertex format and a shader.

**Voxels have no export path.** They render and they are an element the scene
holds, but nothing writes them out. That wants a target format chosen first,
since the format decides what the writer looks like.

**Merging is offered by name**, in the context menu, rather than by dragging
one node's output onto another's input. Ports can start a drag but cannot
accept a drop - that is the gesture it wants.

**Cleanup runs on the CPU inside the op's resolver.** Fine at the counts
tested; a million-point capture wants it in a worker. That is a change of
where it runs, not of what it does.

**Decimate's ranking is not stable between frames**, so a decimated sequence
may shimmer. It ranks by importance within one frame; keeping a sequence
steady means ranking against something that does not move frame to frame.

**Replay after a change is conservative.** It invalidates everything after a
node rather than everything reachable from it, so it may re-resolve a node no
path touches. Correct, and cheaper than a second ordering to keep consistent.
If it becomes slow, walk `inputs` backwards from the changed node.

---

## Related gaps, not nodes

- **Colour grade is affine only.** No gamma, contrast or curve of any kind,
  so midtones cannot be touched without moving everything. No lift/gamma/gain
  split.
- **Temperature is not temperature.** `r*(1+t)`, `b*(1-t)`, green untouched —
  an R/B tilt with no white-point model and no magenta/green axis, and it
  shifts luminance as a side effect.
- **Saturation uses Rec.601 luma coefficients** (0.299/0.587/0.114). Rec.709
  is the defensible choice for anything modern. Left alone deliberately:
  changing them changes how every existing grade looks, so it is a decision
  rather than a fix.
- **Node reordering is impossible.** Node positions are free, but the chain
  order is history order. Reordering means reordering history, which is a
  real feature and not a drawing change.

---

## Decisions taken

These were open questions in earlier drafts of this file. They are settled
now, and the answers are the maximal option in each case - worth knowing,
because each one costs more than its alternative and the cheaper paths were
deliberately turned down rather than overlooked.

**Colour on overlapping regions: stack.** A second colour node over gaussians
an earlier one already graded composes with it rather than replacing it. This
is why grades are stored as matrices - two of them multiply. The alternative,
one grade per gaussian with the newest winning, would have been a plain index
and no composition.

**The graph becomes a real DAG.** Nodes get multiple inputs; the chain stops
being one lane per object with order fixed by history. This is the largest
change on the list and the hardest to walk back, and it is a prerequisite for
merge and for anything whose output is a different kind of thing than its
input.

**Sequences: one edit, all frames.** A node re-resolves per frame as frames
load - a sphere selection catches whatever is inside it on each frame. The
consequence to keep in mind: freehand and frozen selections cannot follow,
because a stored hit set means nothing on a different frame's data. Those
stay bound to the frame they were made on, and the UI has to say so.

**Voxelise produces a new element type.** Not grid-aligned splats. The rest
of the app has to learn about a second kind of element - its own renderer,
its own export path, its own selection behaviour.

**Training happens in VoluLab, on WebGPU.** Not a launcher driving an
external trainer, and not a port of anyone's CUDA kernels - those cannot run
in a browser at all, and would have cost the Mac. Brush is embedded rather
than reimplemented: writing a differentiable rasteriser, its backward pass
and Adam in WGSL is weeks of work that already exists, done well, under a
licence that allows it.

**COLMAP gets a local bridge, not a port.** The one decision here that is
*not* the maximal option, and deliberately: a WASM COLMAP would be weeks of
work likely ending too slow to use, so the pose step stays a native process
and gains a thin local server instead. It costs VoluLab its
purely-client-side property, which is why the bridge must stay optional.

### Order of work

The first four are done, in the order they were listed: the colour palette,
then the DAG with merge, then frames, then voxelise. The order held up - each
one was easier for the ones before it having landed, and voxelise in
particular would have been much harder to shape without the DAG. Training
followed, and needed none of them; the COLMAP bridge is what it wants next.
