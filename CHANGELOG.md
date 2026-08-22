# Changelog

What is built, and why each piece works the way it does. Newest first.

This is the companion to [task.md](task.md), which holds what is next and
what is known to be rough. Entries here keep the reasoning and the traps, not
just the feature name - the point is that someone touching this code in six
months finds out why before they change it.

---

## .vlp: the project format

Projects are `.vlp` now. The inherited `.ssproj` described a scene this
app no longer has - no camera objects, no node settings, no workspace -
and widening a format under someone else's name was the wrong way to fix
that.

A .vlp is the same zip container (`document.json` plus a PLY per splat),
but the document carries the whole session:

- the scene: splats, the viewport camera, view settings, poses, timeline
- **the camera objects**: pose, fov, lock, visibility, the full lens and
  depth-of-field settings, and each camera's animation keys
- **the session around it**: the workspace layout - which panes were
  open and how they were split - and the user's stored preferences

So opening a project puts you back in the arrangement it was authored
in, seeing what its author saw, rather than in whatever your browser
happened to remember.

Two details that matter when reading the code. Animation keys hold Vec3
instances, which JSON returns as plain objects without their methods, so
keys travel as arrays of numbers and are rebuilt on load. And only
preferences the user actually changed are written - an untouched setting
stays at its default rather than being frozen into every file that
passes through.

Saving always writes .vlp. Opening still accepts .ssproj: the container
is identical, so an old project's splats, camera and view still load,
and the parts that did not exist then come back at their defaults.

## Datasets the trainer can actually open

Every dataset packed from a dropped set was unreadable by the trainer.
The zip came from a streaming writer, which cannot know an entry's size
before writing it and so puts the size and checksum in a trailing data
descriptor - and Brush, reading the archive as a stream, rejects exactly
that: *"stream reading entries with data descriptors & Stored
compression mode"*.

Since the whole archive is built in memory anyway, the size and checksum
are known before the header is written, so the zip is now written by
hand with complete local headers and no descriptors. Stored, because a
dataset is jpegs and they do not compress.

This was invisible until training was driven end to end for the first
time - the failure lived one step past where anything had been checked.

## Keyframes are not graph nodes

Setting a key put a node in the graph - a chain of `addkey addkey
movekey` growing along the scene lane, because the graph is a view over
the edit history and every key edit is a history entry.

They are still history entries, and undo still reaches them; the graph
simply does not draw them. Keyframing is timeline work, the timeline
already shows the keys, and a node saying "movekey" tells you nothing
about how the scene is built - which is the only question the graph is
meant to answer.

## The camera, as an object

The camera node stopped being a settings panel and became a thing in the
scene: listed in the outliner, drawn as a frustum in the viewport,
selectable, and animatable on its own timeline track. There can be
several; the one you select is the one the viewport can look through.

**Two views, P and C.** The top-left readout says which one you are in -
free perspective, or through a named camera - because a viewport that
quietly changes what it means is disorienting. P and C pick a view
rather than toggling, so pressing the key for the view you are already
in leaves you there.

**The lock is the interesting half.** Unlocked, navigating in camera view
writes back into the camera: moving the view *is* framing the shot.
Locked, the framing is fixed, so the first navigation drops you back to
perspective rather than dragging the camera along - you cannot disturb a
shot you have set. That asymmetry is the whole feature, which is why the
sync lives in `camera-view.ts` rather than in the camera: it is a
question about intent, not about matrices. The right toolbar's lock
button replaces Reset Camera, which the view switch made redundant
(Shift+F still resets from the keyboard).

Animation: each camera owns a track, and every track applies through the
one viewport camera - so they are gated, and only the camera you are
looking through may drive the view. The view's own legacy track, which
the video exporter follows, stands down while a scene camera has the
view. Selecting a camera aims the timeline at its keys.

A camera transforms like anything else: everything transformable in this
app goes through the pivot, and a handler decides what a pivot move
means, so cameras got a handler of their own. Position comes from the
pivot, aim from its rotation with the distance to the target preserved -
rotating turns the camera on the spot rather than dragging its focus
around - and scale is ignored, so the transform panel greys that input
out rather than pretending a camera can be stretched. Starting a drag on
the camera you are looking through steps you out to perspective first,
because the view and the gizmo would otherwise argue over the same pose.

Worth knowing: the viewport camera is itself an element of type
`camera`, so every list of scene cameras filters by class rather than by
type. Missing that put a nameless row in the outliner and made the first
camera call itself "camera 2". And toolbar icons draw in a 38-unit
viewBox that is mostly padding - a 12-unit icon dropped in renders about
three times too large, which is what happened to the lock button.

## Bokeh, not blur

The first depth of field widened each gaussian by its circle of
confusion, which is a defensible convolution and looked exactly like
what it was: a gaussian blur. A lens does not image an out-of-focus
point as a gaussian - it images it as the aperture, a disc with an edge,
which is where bokeh comes from.

So the falloff itself now changes shape: the fragment shader crossfades
from the gaussian profile to a flat disc as the blur circle takes the
splat over, and the alpha is scaled by the ratio of the two profiles'
integrals (~0.26) so the frame does not brighten as it defocuses.
Widening alone was never going to produce discs, however carefully the
widening was derived.

## The camera node

Exposure, depth of field and a lens, as a node in the graph. It owns no
object and sits in its own lane; the last applied, non-bypassed camera
node is the one the renderer obeys, so undo, redo and bypass work on it
without the op moving any state around.

The three parts live in three different places, each where it is
physically true rather than where it is cheapest:

**Exposure** is in the splat shader, applied to scene-referred colour
*before* the tonemap. Done afterwards it would be a brightness slider on
already-compressed pixels, which rolls off differently and cannot
recover highlights. ±2 EV measures as 175 → 212 / 89 mean luminance.

**Depth of field** is not a screen blur - it could not be, since splats
write no usable depth. A gaussian seen out of focus *is* a gaussian
convolved with the lens point-spread function, so each splat is widened
in quadrature by the circle of confusion at its depth and dimmed by the
area it gained. Bokeh then falls out of the shape, sorting still works,
and picking stays sharp because the widening is skipped in the pick
pass. The blur rides the engine's `modifySplatRotationScale` hook, which
is included *before* `gsplatCenterVS` - hence the view depth is declared
in the modify chunk and filled in by the center chunk.

**The lens** - radial distortion, lateral chromatic aberration,
vignetting - is a screen-space pass, because that is what glass does to
a finished image. It runs in the final blit, and the exporters call the
same shader through the engine's imperative quad helper, so a render
carries the look instead of quietly dropping it.

Two traps worth writing down:

*WGSL forbids implicit-derivative sampling in non-uniform control flow.*
The lens samples after a conditional return, so `texture2D` made the
whole shader module invalid - silently: the GLSL→WGSL transpile
succeeds, only pipeline creation fails, and every draw using it
vanishes. `texture2DLod` needs no derivatives and is legal anywhere. On
WebGL2 the same shader was always fine, which is what made this look
like a pass-plumbing bug for far too long.

*The lens was meant to run inside the frame*, between the splats and the
gizmos, so the picture would warp while the handles you click stayed
put. That does not survive WebGPU: a quad pass of ours rendering into an
offscreen target draws nothing at all - the pass runs, the draw is
issued, the target reads back empty - while the same quad to the
backbuffer works. Unresolved; the consequence is that gizmos warp along
with the picture, and 360 exports skip the lens entirely (a distortion
applied per cube face would seam).

## Exports on WebGPU

Found while proving the camera node reaches renders: **image and video
export produced empty, and then upside-down, frames on WebGPU** - both
pre-existing, both exposed by making WebGPU the default, neither
specific to the camera node.

The readbacks in `src/render.ts` were deferred, and a deferred read has
no next frame to flush it in an app that renders on demand - the same
breakage the data-processor hit during the WebGPU port, in the one file
that port never touched. And the vertical flip was unconditional, which
is right only for WebGL's bottom-up reads; WebGPU reads top-down, so
every exported image came out inverted. Both are now backend-aware, and
the two backends export byte-identical frames.

## The WebGPU viewport

WebGPU is the default device now; `?device=webgl2` keeps the old path as
the escape hatch. The port was a catalogue of five breakages, each found
by driving headless Chrome over CDP - the embedded test pane has no
WebGPU adapter, which is how the first two field reports were
misdiagnosed as stale caches while every import silently fell back to
WebGL2 locally.

The catalogue, for the next porter:

1. **`instance.orderTexture` does not exist on WebGPU** - the sort order
   lives in a storage buffer there. The centers overlay read
   `orderTexture.width` and killed every import with *reading 'width'*.
   Points are order-independent, so the overlay now indexes splats by
   vertex ID and culls deleted ones in the shader - no sort dependency
   on either backend.
2. **GLSL chunk overrides are invisible to WebGPU.** The engine composes
   gsplat materials from `shaderChunks.wgsl` there, so the splat
   shader's grading, selection tint, state culling and second MRT output
   silently reverted to engine defaults - and the missing second output
   invalidated the whole splat pipeline. The three overridden chunks now
   have hand-written WGSL twins set alongside the GLSL.
3. **`device.updateBegin` is WebGL-only.** The point-dispatch helper the
   histogram uses poked raw device internals; it is now a RenderPass
   built on the engine's QuadRender (processed shader, bind groups),
   which is what makes a custom draw legal on WebGPU.
4. **Deferred `texture.read` returns zeros on WebGPU** in an app that
   renders on demand - there is no next frame to flush the copy. Every
   data-processor and picker readback now passes
   `immediate: device.isWebGPU`. This was the quiet one: no error
   anywhere, calcBound wrote a zero-size bound, and the splat was
   frustum-culled into invisibility.
5. **Writing `gl_PointSize` makes the GLSL→WGSL transpiler drop the
   entry point** - the module still compiles, so the only symptom is a
   misleading *entry point "main" doesn't exist* at pipeline creation.
   WGSL has no point size; the writes are now guarded with
   `#ifndef WEBGPU`.

Verified: import, bound, histogram and select-all produce numerically
identical results on both backends; the flame captures render
pixel-identically. Still owed: splatSize on the centers overlay
(one-pixel points on WebGPU until a quad-expansion pass exists), and one
lost frame at startup from an engine backbuffer-resize race.

## The COLMAP bridge

Pose estimation without leaving the app. `npm run bridge` starts a small
zero-dependency node helper on 127.0.0.1:39733; with it running, importing
photos or a video sends the frames over, COLMAP runs natively
(feature extraction → matching → mapping → conversion), and the posed
dataset lands on the import node - each stage streaming onto the node's
face while it works. Photos match exhaustively, video frames sequentially.
Without the bridge, nothing changes: the script-kit fallback remains.

First run without COLMAP on the PATH (Windows): the bridge offers to
download the official portable build and unpacks it beside itself - the
cuda/nocuda choice made by an nvidia-smi probe against the live release
assets. Mac/Linux stay on brew/apt by instruction.

Worth knowing: the browser talks to the bridge across origins, so the
bridge answers CORS *and* Chrome's private-network-access preflight
(`Access-Control-Allow-Private-Network: true`) - loopback is exempt from
mixed-content blocking, which is why this works from the https deployment
too. The whole protocol was verified end to end against a stub COLMAP;
a run with the real binary is the one thing still owed.

## Import: every format, every gesture

One importer, three gestures - drop, file picker, folder picker - and each
takes single files, multi-selections and whole folders through the same
classifiers. A folder or selection holding posed cameras (COLMAP sparse,
nerfstudio `transforms.json`, RealityCapture csv) becomes a pending train
node; picked folders attach as a directory handle the trainer reads in
place, nothing copied. A folder or selection of bare photos gets the COLMAP
kit written *next to the photos* - copied under `images/` where the scripts
expect them, no second picker - and the node waits for poses. One photo
alone is told why it cannot train instead of silence. Everything else -
splats, point clouds, voxels, checkpoints, videos - falls through to the
per-file importer.

Datasets are import nodes of their own: importing one creates a node
holding the source, and nothing wires itself. The train node shows an
empty input port from birth; the user drags the import node's output
onto it to connect, and the context menu cuts the wire again. The
import node's face carries the pickers and takes the same three
gestures, so swapping a dataset happens there; the train node only
trains. The dataset node's output is a lane marker rather than a scene
object, which is what lets the graph's ordinary produce/consume
machinery draw the lane and the edge without special cases. After the
photo and video ingests write their COLMAP kit, a dialog spells out the
three steps that turn it into poses.

Point clouds (`.ply/.las/.laz/.pcd/.xyz/.pts`) import as tiny isotropic
gaussians - median-neighbour-distance scale, near-solid opacity - so every
existing tool works on them the moment they land. MagicaVoxel `.vox`
arrives as a voxel node with its palette.

Traps: a `DataTransfer`'s items die at the first `await`, so
`resolveDropPayload` captures the entries and the single-item handle
synchronously before resolving anything. Directory pickers open with
`readwrite` so the kit can land in place; dropped folders arrive read-only
and must pass `requestPermission`, falling back to the copy-out flow when
the browser says no.

## Training

Gaussians are made in VoluLab now, not only edited. **Brush**
(github.com/cyberhirsch/brush, Apache-2.0) is a 3DGS trainer in Rust on wgpu;
compiled to WASM it trains on a WebGPU device inside the app. No server, no
CUDA, and the same code path on Mac and PC - which is what ruled out the CUDA
trainers, whose kernels cannot cross into a browser at all.

`TrainOp` is the node, and the node *is* training: it enters history
pending - its dataset arriving as an import node it consumes through the
graph, its config edited on its face in the node pane -
and its output splat appears in the real viewport with the first snapshot,
refining in place every few seconds through the same `replaceData` path
sequences use. *Retrain* runs again over the same record, and downstream
ops replay onto the new output when the run completes. Undoing or bypassing
the node mid-run stops the run.

Pieces: `src/training/brush-engine.ts` (device, pump loop, pause by not
pumping), `train-run.ts` (the run controller: snapshot loop, the undo
guard), `src/ui/training-face.ts` (the node's face, mounted in the node
pane the way the colour panel is), and `scripts/build-brush.mjs` producing
the wasm under `static/brush/pkg`. The fork adds three entry points
brush-js lacked: start from bytes, start from a URL, and read the result
back as a PLY.

Worth knowing: training runs on its *own* WebGPU device, separate from the
device the rest of the app renders with. Splats cross that boundary as PLY
bytes - a snapshot is a GPU readback plus a parse, seconds at a million
splats - which is why snapshots are throttled and skipped while one is
still in flight.

Video input is ingested to frames in-app, but poses still come from an
external COLMAP run VoluLab writes a script for. The bridge that closes that
gap is in task.md.

---

## Volumetric video: trained TGH checkpoints

VoluLab opens a trained Temporal Gaussian Hierarchy checkpoint directly - the
output of the reproduction in `Repos/VolumetricVideo` - and scrubs it on the
timeline. The Python and CUDA stack is needed for training and for nothing
else after it.

A TGH model is one global set of 4D gaussians plus a small integer index
saying which are alive at a given time. That is a flat tensor dump, so
`src/tgh/npz.ts` reads the `.npz` through splat-transform's existing zip
layer, and `tgh-model.ts` evaluates it: `activeIndices(t)` for the live
subset, then a multivariate-normal conditional that collapses each 4D
gaussian to the 3D gaussian it looks like on that frame. `eigen.ts` turns the
resulting covariance into the scale and rotation the renderer wants, via an
analytic symmetric 3x3 eigendecomposition.

The port mirrors the training code exactly - the same variance clamps, the
same float64 segment floors, the same active-set ordering. That is not
fussiness: `active_mask` and `active_indices` in the Python disagree at
segment boundaries because one floors in float32, and following the wrong one
would select the wrong gaussians on exactly the frames where it shows.

Verified against fixtures generated by the real Python classes: active sets
match element for element at eight query times including boundaries, values
at float32 noise, and the covariance checked by rebuilding it from the scale
and rotation that were emitted. Then end to end on a real 300-frame
checkpoint - 406 MB of tensors, about a million active gaussians per frame.

`TghFrameSource` implements the same `FrameSource` interface the PLY sequence
loader does, so playback, scrubbing and the per-frame edit replay all worked
untouched. A checkpoint carrying no timeline metadata asks for a frame count
on load.

---

## Voxelise

**A new element type**, not grid-aligned splats. `src/voxels.ts` holds a grid
of filled cells: a cell index and a colour, and nothing else. No covariance,
no view-dependent shading, no per-gaussian state - those are what a voxel
format does not want, and carrying them would mean discarding them at export.

Resampling takes the opacity-weighted mean colour of whatever lands in a
cell. Weighted rather than counted evenly, because a capture is mostly faint
gaussians and an unweighted mean lets a cloud of near-invisible points outvote
the few solid ones that describe the surface. Empty cells are absent rather
than stored, since a capture fills a shell.

This is the node that needed the DAG: its output is not the same kind of
thing as its input, so it cannot be another link in that object's chain.

---

## Frames: one edit, all frames

When a sequence advances, `EditHistory.reapplyAll` re-runs the history
against the frame that just arrived, so a selection catches whatever is
inside it on this frame and a grade follows the shot.

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

## Merge, and the graph as a DAG

Two objects into one, and the first node with more than one input.

The realisation that made this small: **a linear history is already a
topological order of a DAG.** The array says when things ran; a node's
`inputs` say what fed what. `EditHistory` did not need rewriting.

Replay still invalidates everything after a node, which with branches is
conservative rather than exact - it may re-resolve a node no path reaches.
That is correct, and cheaper than maintaining a second ordering that has to
stay consistent with the first. If it ever becomes slow, the fix is to walk
`inputs` backwards from the changed node rather than to restructure history.

In the graph: an object produced by a node gets no import node, since its
lane starts at the node that made it. Edges now come from two places and mean
different things - the chain edges say "then", the input edges say "from".

`MergeOp` builds its output before the op exists, because building it means
writing both objects out and reading them back, and `do` has to be
repeatable. So `do` adds an object that already exists, and hides the two
that fed it, reversibly.

---

## Cleanup, decimate, crop, SH bands

**Cleanup** (`CleanupOp`): mean distance to the k nearest neighbours,
thresholded at so many deviations above average. Neighbours come from a
uniform grid sized for a handful of points per cell, searched outward a ring
at a time. Parameters are neighbour count and spread. Runs on the CPU inside
the op's resolver.

**Decimate** (`DecimateOp`): ranks by opacity times footprint and drops the
least important until a fraction remains. Ranking rather than thresholding,
because "keep 40%" transfers between captures in a way "alpha above 0.03"
does not.

**Crop** (`CropOp`): a box or sphere, keep inside or outside, position and
size as numbers, resolved through the same `resolveHits` the shape selections
use. A fresh one sits 5% wider than the object, since a box exactly on the
bound puts every surface gaussian on the boundary. It only ever adds to what
is deleted - widening it does not resurrect what an earlier node removed, but
bypassing that node does.

**SH bands** (`SetShBandsOp`): caps `splat.shBandLimit`, which meets the view
setting and the file's own band count in `rebuildMaterial`. A limit rather
than a truncation, so it is reversible and the viewport previews it.

---

## Output, transform, delete and hide

**Output node**: carries format, filename, SH band count and selection scope,
and drives `scene.write` directly rather than reopening the export dialog.
Not an edit - `do`/`undo` are no-ops. Writing winds the history to the node's
position first and back afterwards, so where it sits in the chain is what it
exports. Drawn with an input and no output.

**Transform node**: shows position, rotation and scale; editing a field
replays from that node. A transform is committed bundled with its pivot
placement, so ops are named and edited by their principal member
(`principalOp` in `src/edit-ops.ts`) rather than being drawn as "combined
edit". Worth knowing: a world-space selection downstream of a transform will
legitimately catch different splats after the object moves. That is the model
working - see the note on the model matrix in `src/select-query.ts`.

**Delete / restore / hide**: no parameters to turn, so they report what they
did - how many splats they touched, read from what the op resolved rather
than recomputed, plus a line on what bypassing one means. `StateOp.affected`
is the accessor.

**Transform splats**: `SplatsTransformOp` moves the selected gaussians rather
than the object, so it is the one node that does real per-gaussian work.
Read-only: the op carries its matrix alongside a map of the transform-palette
slots it moved things between, and the two have to agree, so editing the
matrix would mean rebuilding the map. That is the gizmo's job rather than a
text field's.

---

## Colour, selection-scoped

A colour node added with a selection grades those gaussians; added with
nothing selected it grades the object, which is still the right thing for
"make this whole thing warmer".

How it works, in the order the pieces were built:

1. `gradeMatrix` in `src/color-grade.ts` folds the eight parameters into a
   3x3 matrix and a translation. Saturation is a linear map and the levels
   are affine, so nothing is lost - and two grades compose by multiplying,
   which the parameter form cannot express.
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

---

## Decisions behind the above

Each of these was an open question, and in every case the answer taken was
the more expensive option. Worth knowing that the cheaper paths were turned
down rather than overlooked.

**Colour on overlapping regions: stack.** A second colour node over gaussians
an earlier one already graded composes with it rather than replacing it. This
is why grades are stored as matrices - two of them multiply. The alternative,
one grade per gaussian with the newest winning, would have been a plain index
and no composition.

**The graph becomes a real DAG.** Nodes get multiple inputs; the chain stops
being one lane per object with order fixed by history. The largest change on
the list and the hardest to walk back, and a prerequisite for merge and for
anything whose output is a different kind of thing than its input.

**Sequences: one edit, all frames.** A node re-resolves per frame as frames
load. The consequence: freehand and frozen selections cannot follow, because
a stored hit set means nothing on a different frame's data. Those stay bound
to the frame they were made on, and the UI has to say so.

**Voxelise produces a new element type.** Not grid-aligned splats. The rest
of the app had to learn about a second kind of element - its own renderer,
its own export path, its own selection behaviour.

**Volumetric video is read natively.** VoluLab evaluates the 4D
representation itself rather than talking to a Python server that renders it.
That makes the trained checkpoint one of VoluLab's file formats instead of
something it borrows, and drops CUDA out of everything downstream of
training.

**Training happens in VoluLab, on WebGPU.** Not a launcher driving an
external trainer, and not a port of anyone's CUDA kernels - those cannot run
in a browser at all, and would have cost the Mac. Brush is embedded rather
than reimplemented: writing a differentiable rasteriser, its backward pass
and Adam in WGSL is weeks of work that already exists, done well, under a
licence that allows it.

### The order it happened in

Colour palette, then the DAG with merge, then frames, then voxelise, then
reading trained TGH checkpoints, then training. The order held up - each was
easier for the ones before it having landed, and voxelise in particular would
have been much harder to shape without the DAG. Training needed none of them.
