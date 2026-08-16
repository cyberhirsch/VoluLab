# Node backlog

**Status.** Tier A is done. Making colour selection-scoped turned out to be
the largest item in the document rather than the smallest - the note below
says why, and what the shape of it is. Tiers B and C are untouched.

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

## Still open: make colour selection-scoped

`SetSplatColorAdjustmentOp` grades the whole object. Every other node is
selection-scoped, so this is the odd one out.

The grade lives in per-splat uniforms (`clrScale`, `clrOffset`, see
`Splat.onPreRender` and `gradeTransform` in `src/color-grade.ts`), which is
why it cannot vary per gaussian.

**Baking it into the colour data is the wrong answer.** The grade is
currently a live view transform, which is exactly why a colour node stays
re-editable for nothing. Baking would mean re-grading already-graded data.

The right answer is a **grade palette**, following the precedent
`transformPalette` sets for per-gaussian transforms:

- A per-gaussian `R16U` index texture alongside `splatTransform`.
- A palette of grades. Store each as a **3x4 matrix plus an alpha scale**,
  not as the eight parameters: saturation is a linear map and the levels are
  affine, so a grade *is* a matrix — and two of them compose by multiplying,
  which the eight-parameter form cannot represent. Composition is what lets a
  second colour node stack on a region an earlier one already touched.
- The op keeps its parameters, as now, so the panel still edits meaning
  rather than matrix entries. The slot is recomputed from them on replay.

The cost is not the palette, it is that **four paths read the grade** and all
four would need the per-gaussian lookup: the render shader
(`src/shaders/splat-shader.ts`), the histogram and range-select shaders
(`src/shaders/splat-value-shader.ts`), and the CPU export path
(`src/splat-serialize.ts`, which builds one `ColorGrade` per splat). Doing
only the renderer would leave export and the histogram quietly disagreeing
with what is on screen, which is worse than the current honest limitation.

A useful first step that is safe on its own: make `gradeTransform` return a
matrix and have all four consumers use it *with a single per-object grade*.
Behaviour-identical, verifiable, and it removes the parameterisation problem
before any per-gaussian work starts.

---

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

## Tier B — modest new work

### SH bands node

The biggest single lever on file size for volumetric video.

- Exists: `maxSHBands` in `src/splat-serialize.ts` (export-time only), and
  `view.bands` which already previews band count on screen.
- Needed: an op that fixes the band count for a branch rather than for the
  export as a whole, so it is visible in the chain and previewable.

### Crop node

- Composable today as box-select → invert → delete, which is three nodes for
  one idea.
- Needed: one node with a volume gizmo and an inside/outside switch.
  `BoxShape`/`SphereShape` and `ShapeTransformOp` already exist.

### Merge node

Two objects into one.

- Needed: **a second input**, which is the real cost. The chain is linear
  today — one lane per object, order fixed by history — so a node with two
  inputs is the point at which the graph has to become a genuine DAG. That
  is an architectural change, not a computational one, and it should be
  taken deliberately rather than as a side effect of wanting merge.
- Exists: `AddSplatOp` and the duplicate/separate machinery in
  `performSelectionFunc` (`src/editor.ts`).

### Frame / time node

Where the 4D direction actually starts. Makes "grade this shot" mean
something across a sequence rather than on one frame.

- Exists: `src/sequence.ts` (per-frame PLY loading,
  `plysequence.setFrameAsync`), `src/anim-track.ts`, `src/timeline.ts`,
  `AnimTrackEditOp`.
- Needed: a node fixing which frame or frame range a branch applies to, and
  a decision about what an edit means on a frame that has not been loaded
  yet.

---

## Tier C — real new machinery, and the ones people want daily

### Cleanup / floater removal

The most-wanted operation on captured splats. Right now it is a manual lasso
job.

- Statistical outlier removal: drop gaussians whose mean distance to their k
  nearest neighbours exceeds some multiple of the standard deviation.
- Needed: a spatial structure — a GPU grid, or a kd-tree built in a worker.
  Nothing like it exists yet.
- Parameters: neighbour count, standard-deviation multiplier.

### Decimate

The other half of file size.

- Reduce count by importance: opacity × volume × screen contribution.
- Needed: an importance pass and a stable ordering so the result does not
  flicker between frames of a sequence — which matters more here than it
  would for a single still.

### Voxelise

The bridge to voxels and the other volumetric formats named as targets.

- Resample gaussians onto a regular grid.
- Needed: essentially all of it, plus a decision about what the output *is*
  — a splat object that happens to be grid-aligned, or a genuinely different
  element type the rest of the app has to understand.

---

## Recommended order from here

1. **Colour selection-scoped**, in the two steps above: matrix form first as
   a safe no-op refactor, then the palette.
2. **Cleanup** — the operation that would make this reached for daily.
3. **SH bands node** — the file-size lever, and cheap next to Tier C.

---

## Related gaps, not nodes

- **Colour grade is affine only.** No gamma, contrast or curve of any kind,
  so midtones cannot be touched without moving everything. No lift/gamma/gain
  split.
- **Temperature is not temperature.** `r*(1+t)`, `b*(1-t)`, green untouched —
  an R/B tilt with no white-point model and no magenta/green axis, and it
  shifts luminance as a side effect.
- **Saturation uses Rec.601 luma coefficients** (0.299/0.587/0.114). Rec.709
  is the defensible choice for anything modern.
- **Transparency wastes half its slider.** The panel maps it through
  `exp(value)` over -6…6, so everything above ~0 is a multiplier large enough
  to clamp immediately.
- **Node reordering is impossible.** Node positions are free, but the chain
  order is history order. Reordering means reordering history, which is a
  real feature and not a drawing change.
