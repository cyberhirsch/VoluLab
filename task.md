# What's next

Everything outstanding, phased and ranked in the table below and then
described in full: the work in flight, then relighting - all four of its
items built - then the places where something built works and could work
better. What is already built is in [CHANGELOG.md](CHANGELOG.md), with the
reasoning kept.

Terms used below:

- **op** — an `EditOp` in `src/edit-ops.ts`. Every node in the graph is one.
- **selection-scoped** — acts on the selected gaussians rather than the whole
  object. This is the property that makes a node belong in a graph whose
  premise is *select, then operate*.

---

## Phases, difficulty, and who should take it

Most of this list is genuinely parallel. Six ordering constraints are not,
and each one costs rework if ignored - they are what the phases are for. The
model column is a starting point rather than a rule; what makes something
hard here is rarely the amount of code.

| Phase | # | Work | Model |
|---|---|---|---|
| 0 | 11 | A whole training run on a real capture (synthetic runs reach "done") | Sonnet 5 |
| 1 | 4 | COLMAP bridge | Opus 5 |
| 2 | 1 | WebGPU: draw the trainer's buffers directly (device shared, interim snapshots read the buffers; zero-copy draw open) | Fable 5 |
| 2 | 20 | GSV encoder: per-band SH palettes | Opus 5 |
| 3 | 21 | Camera poses in the browser, no helper | Opus 5 |
| 4 | 3 | Colour beyond affine (gamma, contrast, curves) | Fable 5 |
| 4 | 7 | A real temperature model | Opus 5 |
| 4 | 15 | Rec.709 luma coefficients | Haiku 4.5 |
| 5 | 16 | Relighting: density grid, lights, soft shadows (built, needs a real-GPU run) | |
| 5 | 17 | Relighting: occlusion and ambient light (built, needs a real-GPU run) | |
| 5 | 18 | Relighting: de-light by occlusion and a matched sun (built, needs a real-GPU run) | |
| 5 | 19 | Relighting: area and volume lights (built, needs a real-GPU run) | |
| — | 13 | A voxel export path | Sonnet 5 |
| — | 6 | Decimate: a merge mode (ranking frame-stable and per region, done) | Opus 5 |

**Phase 0 gates everything else about training.** A training run gets well
past its first refine now, but has never been watched from dataset to
committed node. Building the COLMAP bridge on
top of a pipeline nobody has seen finish would mean debugging two unproven
things through each other.

**Phase 1 finishes the training story** - video in, poses found, gaussians
out. A cleaned-up result can already seed the next run (CHANGELOG.md); what
is left of the phase is COLMAP on a real capture.

**Phase 2 is what is left of the device move.** The viewport runs on WebGPU
by default, and voxels needed no shader after all (CHANGELOG.md). What
remains is sharing the device with the trainer. The TGH item that sat
here is done: 4D gaussians are conditioned in the shader (CHANGELOG.md).

**Phase 3 is done**: precise invalidation first, then node reordering on top
of the dependency walk it built (CHANGELOG.md).

**Phase 4 is the colour pipeline, and the point is doing it at once.** All
three change how every existing grade looks. Landing them separately means
three rounds of everything shifting under the user; landing them together
means one deliberate break with one explanation. Rec.709 in particular is a
one-constant change that has been left alone precisely because it is not
worth spending a visual regression on by itself.

**Phase 5 is relighting, and its four items land in order.** Each one is
a query against what the one before built. The grid and the per-gaussian
light texture come first because everything after traces through them.
Occlusion is next because ambient light is dimmed by it and de-lighting
divides by it. De-light comes before the extra light types because it
needs nothing more than occlusion, and it is what stops new light landing
on top of old shadows. Area and volume lights come last, as more of what
the first item already does. The phase needed the WebGPU viewport, which
is done - the lighting runs in compute - and it is independent of phase 4:
lighting is off by default and multiplies after the grade, so no existing
grade changes how it looks.

**The last two have no dependencies at all** and can be picked up whenever
someone wants a clean, self-contained piece of work. Decimate's remaining
two sit there rather than in a phase because they only start to matter at
aggressive ratios.

On the tiers themselves: the Fable items are grouped not by size - all three
are small diffs - but because each overturns an assumption other code relies
on. WebGPU has a genuine unknown at its centre and touches every shader at
once. Node reordering makes history stop being append-only, which is what
every op's undo is written against. Colour beyond affine breaks the property
the grade palette rests on, since grades compose by matrix multiply and a
gamma curve does not.

The Opus items are substantial work that overturns nothing. Two of them sit
at opposite extremes of shape: the COLMAP bridge is the largest by volume and
the least likely to surprise anyone, while precise invalidation is a small
diff in `EditHistory` that earns its tier because being wrong there corrupts
state silently rather than throwing.

And worth naming honestly: there is not much genuinely trivial work left.
Rec.709 is one constant plus a decision someone else has to make. Padding
that tier from the one above would only move the surprise later.

---

## Training runs; a whole run is still owed

Training gets past loading, its first refine and on, on a real 127-view
dataset, driven through an import node into a train node with the output
splat in the scene. Four blockers fell on the way, each in
[CHANGELOG.md](CHANGELOG.md): the dataset zip, the sort kernels'
`enable subgroups;`, wgpu reading a clean error scope as an error, and
cubecl's throughput probe blocking on wasm - that last one in the forks
(cyberhirsch/cubecl@wasm-throughput, cyberhirsch/brush@volulab), together
with brush's `refine` asking for the default device instead of its own.
A panic now ends the run with its own message on the node, rather than
leaving it on "loading".

A run now also finishes: the pump used to poll the stream once past its
end and turn every completed run into an error (CHANGELOG.md, "A run that
finishes, finishes"). Watched to "done" headless on a synthetic four-view
dataset, the result committed to the node.

What is still owed: the same on a real capture at default settings, with
its time and its PSNR written down. Two costs to check
while there: autotune on the web picks kernels without a measured rate,
and per-image loading progress stays invisible until the trainer's API
changes (both in the changelog).

How to debug the trainer, since it took some doing: run it under
headless Chrome with `--enable-unsafe-webgpu`, hook
`GPUDevice.createShaderModule` and read `getCompilationInfo()` for the
real shader errors (wgpu only says "invalid due to a previous error"),
set `Error.stackTraceLimit` high, and build the trainer with
`wasm-pack build --profiling` so panic stacks carry names.

## COLMAP bridge — built, needs a real-COLMAP run

The bridge exists (`bridge/server.mjs`, `npm run bridge`): a zero-dependency
node helper on 127.0.0.1:39733 that takes images, runs COLMAP's
feature/match/map/convert pipeline, and serves the sparse model back.
Importing photos or a video with it running estimates poses automatically -
stages stream onto the import node's face - and without it the script-kit
fallback still works. On first run without COLMAP (Windows) it offers to
download the official portable build; the asset selection was verified
against the live release API (4.1.1, cuda/nocuda by nvidia-smi probe).

What remains: the pipeline is verified end to end against a stub COLMAP
(the browser pane used for testing cannot reach other local ports, so the
protocol was driven from node - identical requests). A run with *real*
COLMAP on a real capture has not been watched yet, and the provisioning
download path has not actually pulled the 1-2 GB zip. Both want one manual
session. Non-Windows provisioning stays manual (brew/apt) by design.

Why a bridge, not a port, for the record: COLMAP will not compile to WASM
in any form worth having - Ceres, SuiteSparse, CUDA SIFT, threads,
COOP/COEP. The bridge is the first piece of VoluLab that is not
client-side, and it stays strictly optional: everything works with no
bridge running, and a posed dataset is still loadable by hand.

---

## Camera poses in the browser, no helper

**Built** (CHANGELOG.md, "Camera poses in the browser"): colmap-wasm runs
COLMAP in the page; the bridge and the kit remain as fallbacks. Left: a
real capture against native COLMAP, photos of mixed sizes, a long video
(hundreds of frames, memory), then retire the bridge. The text below is
the plan as written.

VoluLab is meant to stand alone: everything, training included, should
run in the browser without a local helper. Training already does (Brush
on WebGPU); camera poses are the one step that still needs the COLMAP
bridge or a hand-run script kit. Heavy training - TGH, 4D, the paper's
runs - lives in VoluGym; this is about VoluLab's own static workflow.

The route that keeps the MIT license: build COLMAP's or GLOMAP's
pipeline (both BSD) for WebAssembly - features, matching, mapping,
bundle adjustment - and run it in a worker. The hard part is the native
dependencies (Ceres, Eigen, SuiteSparse); CPU-only in the browser, so
slow on hundreds of images, fine on dozens. A learned pose model (VGGT,
MASt3R, MapAnything) on ONNX Runtime Web is the fast alternative or a
later preview, but the downloads are 1-4 GB and several carry
non-commercial licenses - check each. Spirula Studio's SfM is GPL-3.0
and cannot be ported in.

Done when importing photos or a video estimates poses with no helper
running, and the poses match COLMAP's on a real capture. The bridge can
then go; a connection to VoluGym, if wanted, is a separate item.

## WebGPU viewport — ported, now the default

Done: WebGPU is the default device, WebGL2 the `?device=webgl2` escape
hatch. The five breakages and their fixes are in the changelog; splat
rendering, bound calculation, histogram and selection were verified
numerically identical across both backends in headless Chrome (which,
unlike the embedded test pane, has a WebGPU adapter with subgroups -
driven over CDP, the debugging loop that made this port possible).

What remains on this front: the engine loses one frame at startup to a
backbuffer-resize race (*Destroyed texture WebgpuFramebuffer*,
engine-side, cosmetic); a click-through in the user's real Chrome is
still owed; and the original payoff - sharing the device with the Brush
trainer so training renders in the viewport without the PLY round-trip -
is now actually reachable. Since done: the centers overlay draws quads,
so splatSize holds on WebGPU, and the lens runs inside the frame again -
the offscreen quad pass that seemed to render nothing was an invalid
lens pipeline discarding the whole command buffer it was in.

**The trainer shares the viewport's device now** (CHANGELOG.md): one device,
falling back to its own only where the viewport's lacks subgroups. What
that was for is half built: interim snapshots now read the trainer's
buffers straight into splat data (`BrushEngine.readSplats`), no PLY
written or parsed; the first and final snapshots still go through a PLY.
On 10k gaussians the readback itself is no faster (about 0.26 s against
0.27 s for the PLY export, before its parse); the gain to measure is at a
million. Still to build - the viewport drawing those buffers with no
CPU copy at all. That wants the trainer's layout (packed transforms, SH coefficients, raw opacities)
turned into what the gsplat renderer reads, on the GPU. It is also the
prerequisite for conditioning 4D gaussians in the shader, which is what
would make scrubbing a TGH sequence cost the CPU nothing.

The engine also warns that `GSplatComponent#unified` is deprecated and
non-unified gsplat rendering is going away; that migration is still to do.

---

## Relighting — built, owing a real-GPU session

The ask: light a capture with lights placed in VoluLab - point, spot, sun,
area and volume lights, and ambient light - with soft shadows and
occlusion. Light the scene itself blocks, not a look painted over it.

**Where it stands.** Item 16 is built: light nodes for point, spot and sun
lights, the density grid, soft shadows and the splat shader's multiply,
with the traps written up in [CHANGELOG.md](CHANGELOG.md). It was verified
in headless Chromium on SwiftShader's software WebGPU, numerically and by
eye. What it still owes is a session on a real GPU with a real capture:
timing for a grid build and a relight at a million gaussians and more, and
a look at two-sided lighting on real surfaces.

Item 17 is built too: an ambient light kind - a flat colour, or an HDRI
or photo reduced to spherical harmonics and turned with a rotation - shaped
by occlusion traced through the same grid, with a range and a strength set
per object. Verified the same way, and owing the same real-GPU session.

Item 18 is built as well: de-light, which divides an estimate of the
capture's own light out before new light goes on - the capture's sky
through occlusion, automatically, and any light the user sets to "baked
in" where the capture's sun was. Verified the same way, on a test capture
with an analytic sky and sun baked into it, and owing the same session -
plus a look at how its guards sit on a real sunny capture.

Item 19 completes it: area lights - rectangle, disk and sphere, with exact
or near-exact irradiance - and volume lights, which turn selected glowing
gaussians, a lamp in the capture, into light. Verified the same way, against
exact form factors, and owing the same session - plus a lamp in a real
capture, to see how its emitters and its glow look.

Since then, two changes to how it is driven, both verified the same way and
owing the same session. The lighting settings - captured light, grid
resolution, occlusion and de-light - moved onto a relight node per object,
which the first light adds; an object without one is still lit, but lights
only add to its captured light, with no shadows, occlusion or de-light. And
a light node takes in what it shines from through a source input: an
object's gaussians, or those a select node picks, make it a gauss light -
the volume light under its new name - that follows them as they change; a
box, sphere or cylinder makes it a mesh light, shining from the primitive's
surface and following it as it moves.

That session is written up as a checklist in
[relighting-checklist.md](relighting-checklist.md): what to load, what to
look for at each step, and a console helper that times each pass on the
GPU with the engine's own profiler.

**For the record, how Octane does it.** Octane 2026 path traces gaussians
alongside meshes, so they cast and receive shadows and show up in
reflections. Its relighting is a lighting mode on the splat node that
scales each gaussian's captured colour by emitter power, distance falloff
and light colour. It does not remove the lighting baked into the capture,
and users report that light from a different direction than the capture
looks wrong - a stylistic effect more than relighting. VoluLab has no path
tracer and does not want one. What follows gets the same visibility
effects from a structure the viewport can afford, and goes a step further
on the baked lighting.

**The mechanism: a density grid, and lighting computed once per gaussian.**

- A compute pass splats every drawn gaussian's opacity into one 3D grid
  over the whole scene, with mip levels. One grid for all objects, so one
  capture shadows another; built from what the viewport draws, so deleting
  a floater removes its shadow too.
- A second compute pass lights each gaussian at its centre by tracing cones
  from it through the grid, and writes the result into two per-gaussian
  light textures laid out like `splatGrade` - one for each side of the
  gaussian's flat axis, see below.
- The splat vertex shader multiplies that in after `applyGrade` and before
  `camExposure`: the grades correct the capture, the light lights the
  corrected capture, the camera exposes the result. Both shader dialects
  get the multiply, behind a define, so a device without lighting compiles
  the old path.
- Lighting recomputes when a light, an edit, a transform or a frame
  changes - never for the camera, so orbiting costs nothing. The new light
  is diffuse only: it scales each gaussian's colour, view-dependent part
  included, and adds no highlights of its own.

**How each piece falls out of it.**

- **Soft shadows** — one cone per light per gaussian, as wide as the light
  appears from it. Shadows stay sharp at contact and soften with distance,
  and haze casts partial shadow, because the grid holds density rather
  than a surface.
- **Area lights** — analytic diffuse irradiance for rectangle, disk and
  sphere lights, with the cone for visibility. Built: a rectangle's form
  factor is exact, a disk is an octagon of its area through the same
  formula, a sphere is exact, and a sphere approximation clips each to the
  horizon.
- **Volume lights** — a selection-scoped node: select gaussians, such as a
  lamp in the capture, and they become the emitter, clustered into a few
  dozen point lights. *Select, then operate*, applied to light. Built as a
  light kind, now called gauss, rather than a node of its own: wire a select
  node or an object into a light node's source input, and the light glows
  with those gaussians and follows them. Unwired, a light can still take
  whatever is selected by hand. Sixteen emitters, one shared shadow cone,
  and the glowing gaussians glow with the light rather than being lit as
  surfaces. A box, sphere or cylinder wired in instead makes a mesh light:
  24 emitters spread over its surface, weighted by area, lighting what is
  round it without making anything glow.
- **Ambient light** — a flat colour or an HDRI reduced to spherical
  harmonics, dimmed by occlusion. Built: every ambient light is summed into
  one set of nine coefficients, evaluated along each side's bent normal.
- **Occlusion** — a handful of wide cones per gaussian through the same
  grid. It lives in world space, so it holds still as the camera moves,
  which screen-space occlusion does not. Built: six cones a side, near
  field by design, computed only while an ambient light is on and only
  when the grid or the range changes.

Normals come from each gaussian's shortest axis, and nothing decides which
side is outside - nothing can. The density around a single-layer wall is
the same on both sides, which is why the plan's grid-gradient orientation
was dropped while building it. Both sides are lit instead, and the splat
shader keeps the side facing the camera: a wall seen from the room gets
the room's light, and a sun behind it lands on the side nobody captured.
A gaussian too round for its shortest axis to mean anything is lit the
same from every side.

**Why a grid rather than shadow maps.** Shadow maps need a render per light
(six for a point light), opacity rather than depth for semi-transparent
gaussians, and filtering tricks for softness - and still say nothing about
occlusion or volume lights. The grid answers every visibility question
with one structure. It also runs in compute, so it needs no offscreen
render pass of the kind screen-space occlusion would.

**De-lighting, and why occlusion does most of it.** New light multiplied
onto a capture leaves the old shadows under the new ones, so the captured
lighting has to be divided out first. The light texture carries both at
once: new lighting over captured lighting, one factor per gaussian. Built
as described below, with what building it changed noted where it did.

- **Occlusion is the automatic half.** Captures are best shot in overcast
  or even light precisely so that what gets baked in is mostly sky light,
  and how much sky reaches a point is what occlusion measures. Dividing by
  it lifts the baked darkening in cavities and contact regions and leaves
  open surfaces exactly as captured. For a well-shot capture that is most
  of the de-light, with no input from the user.
- **A matched sun is the manual half.** Direct sun baked in as hard
  shadows is not occlusion. For a sunlit capture the user places a light
  matching the original sun; its shadows and falloff go through the same
  grid and are divided out too.
- **Division needs guarding.** A floor on the divisor, so deep baked
  shadows do not turn noise into colour, and a strength slider - bounce
  light makes real cavities brighter than occlusion predicts, so full
  strength over-brightens them.
- **De-light against the scene as captured, relight against the scene as
  edited.** A deleted car's shadow is baked into the road. Dividing by
  occlusion that still includes the car removes that shadow, and relighting
  without the car does not put it back. Cleanup's deleted floaters would
  count as occluders too, though, so which scene de-light sees wants to be
  a choice rather than a rule. Built as a choice, "de-light counts
  deleted", on by default. Building it showed "as captured" means per
  object: a second capture set beside this one was not there when this one
  was shot, so each object gets a captured grid of its own gaussians alone,
  where the capture put them.
- Learning true albedo during training is the proper fix. It means
  teaching the Brush fork a lighting model, and it waits on phase 0 - a
  training run seen end to end.

**The unknown, resolved.** The engine's shorthand WGSL declarations
reflect every storage texture as 2D, and its WebGPU texture creation gives
a volume texture a single layer, so the grid lives in storage buffers and
the trilinear interpolation is done by hand. Accumulation goes into a `u32`
buffer in fixed point, since WebGPU has no float atomics, and resolve,
pull-up and push-down passes turn it into the density pyramid. A 3D
texture with hardware filtering is still reachable through explicit bind
formats and texture views, and is the first thing to try if lighting
proves slow on real captures.

**Decisions, and what is still open.**

1. **WebGL2 - decided.** Relighting is WebGPU-only. On the fallback the
   lights are drawn and the light node says why they light nothing. SOG
   export and training already needed WebGPU, so it was not the first.
2. **Sharpness - built as proposed.** Lighting per gaussian means shadow
   edges are no sharper than the gaussians, and a big background gaussian
   gets one flat value. Shadow rays also skip the first stretch off the
   surface - along the ray, to two cells' height - so a contact shadow
   begins up to two cells late; any closer and every surface dims itself.
   The grid blurs occluders by a cell and a half as well, so shadows come
   out that much wider than the objects casting them - harmless when
   multiplied in, which is why only de-light takes it back out.
3. **Large scenes - partly answered.** The grid's box already trims half a
   percent of gaussians off each end of each axis, so a few floaters do not
   stretch it. For a big outdoor capture the cells still get coarse; a box
   the user places is the cheap answer, nested grids the thorough one. The
   grid goes to 1024 cells now, as fine as the GPU can hold (CHANGELOG.md).
4. **Sequences.** Every frame means a new grid and a new relight, and the
   gaussians are repacked on the CPU at every frame swap. The cost wants
   measuring on a real sequence before anything promises smooth scrubbing.
5. **Export.** Image and video renders go through the same material and get
   the light for free. Splat export would bake the factor into colour the
   way grades are baked today, through `applyDC` and `applySH` - whether
   that is the default is open.

**Left from item 16**, none of it blocking:

- The grid's box and the gaussian packing run on the CPU. Grid rebuilds
  during a drag are throttled to ten a second; on a large capture both
  want moving to the GPU once they show up in a profile.
- Lights are selected from the outliner or the graph. A click on a light's
  gizmo in the viewport does not pick it, which cameras and primitives
  cannot do either.
- Lights do not animate: no timeline track yet.
- Changing a light's settings is not an undo step, the same as a camera
  node's or a relight node's settings. Moving or aiming one with the gizmo
  is.

**Left from item 17**, none of it blocking:

- EXR environments are refused with a message; `.hdr` and ordinary images
  load. An EXR decoder is a dependency or a few hundred lines.
- Occlusion ignores bounce light, so a range long enough to see across a
  room makes the room dark. The range defaults short for that reason.
- The occlusion textures cost another 16 bytes per gaussian while an
  ambient light is on, on top of the light textures' 16.

**Left from item 18**, none of it blocking:

- A hard baked shadow's edge leaves a thin dark outline at full strength.
  The grid cannot place an edge to better than a cell or so, and de-light
  errs toward lit there on purpose (see CHANGELOG.md). Half strength, the
  default, hides it; a finer grid narrows it.
- A shadow narrower than about five cells is shrunk away entirely, and so
  is not de-lit - a pole's, a branch's. The same shrinking makes the
  outline above; neither goes without a sharper occluder than the grid.
- A soft matched light reads coarser levels, which blur more than de-light
  takes back out. The real sun is hard, so that is the usual case anyway.
- The capture's sky is white and even. A matched ambient light, an HDRI
  of the sky the capture was shot under, would let de-light take a sky's
  colour and gradient out too.
- Occlusion ignores bounce light, so full strength over-lifts cavities.
  The strength defaults to half for that.
- The captured grid lives in world space, so moving a whole object
  rebuilds it and its occlusion. In the object's own space it never would,
  at the price of carrying each matched light into that space.
- While de-light is on, each object costs another grid and 32 bytes per
  gaussian: its captured occlusion and the divisor, both sides.

**Left from item 19**, none of it blocking:

- Only a wired gauss light follows its gaussians. One that took the
  selection by hand, or whose source was unwired, keeps its emitters where
  the glowing gaussians were, round the light's own position, until "Use
  Selection" makes them over.
- A wired gauss light clusters again whenever history settles and its
  source has changed: up to 20,000 sampled gaussians, on the CPU. Quick at
  the sizes tested; a large capture wants it timed, and moved to a worker if
  it shows.
- A select node is not saved in a project, so a gauss light fed by one comes
  back unwired, with the emitters it last took. A primitive or an object
  feeding a light is saved and wired again.
- A mesh light's emitters each shine every way, and the primitive is not in
  the grid, so light from its far side passes through it: it lights like a
  glowing volume of its shape rather than a lit shell. A lobe per emitter,
  facing out along the surface, would make it one-sided.
- Wiring a light by hand aims it below its source, four of its spreads
  away, so its intensity means what it did for a light made from a
  selection. An aim set before wiring is replaced.
- One shadow cone per light. A large area light close to what it lights, or
  a long strip, gets the visibility of its middle; sampling across the
  emitter would fix it at a few traces a light.
- Which gaussians glow is decided by distance to the emitters, so a surface
  within a cluster's spread of the lamp glows with it too.
- A rectangle has no roll: its width lies level, or along the world's x axis
  when it is aimed straight up or down.
- No textured emitters - a screen showing a picture lights in one colour.
- The emitters of every volume light share a pool of 256; a light past it
  is skipped.

**Left from the finer grids**, none of it blocking:

- At 256 and below, a gaussian over about a cell and a half wide still
  shadows itself a little: a 3 cm round one at 256 gets 0.3 of its light
  where 0.5 is right. Finer grids clear each gaussian's own density; doing
  the same at 256 and below would change how every existing scene looks, so
  the real-GPU session should judge it first.
- What 512 and 1024 cost on a real GPU is unmeasured. Memory is up to eight
  bytes a cell plus a quarter spare, per grid, and de-light adds a grid per
  object: a cube-shaped scene at 512 is about 1.5 GB of grid.
- Running out of memory is found out a frame late, and that frame's
  relighting is broken before the grid is rebuilt coarser.
- A grid that ran out of memory never tries that many cells again in the
  session, even after memory frees up.

## GSV encoder: per-band SH palettes

GSV's compact encoding loses about 2 dB against the dataset's own images
on flame_salmon (30.07 against 32.07, 24 training views, the training
rasteriser), and taking one attribute at a time from the decoded file
puts nearly all of it on the SH palette: 65 536 centroids over all 45 rest
coefficients cannot hold this model's view dependence, which is worth some
8 dB here. Position, motion, time, rotation, scale and opacity together
cost 0.03 dB.

Measured with the same pipeline (4 views, only the rest coefficients
replaced): one 64k palette per SH band - 9, 15 and 21 coefficients -
recovers 1.2 dB of the 2.2 for 32 more raw bits per gaussian (48 against
16; roughly +17 after WebP, plus two centroid textures, ~37 MB for the
file instead of 31). Clustering on all points for 30 iterations instead
of a 262k sample for 10 is part of it. Storing band 1 directly adds
nothing on top; even every coefficient direct at 8 bits loses 0.4 dB.

To build: three palettes and three label textures in `gsv-webp.ts`, the
decoder reading them, and the spec's texture table (section 7.2) and
codebook block updated - an old single-palette file should still open.
The k-means wants its distance block kept to a few hundred megabytes:
one sized for 262k centroids overflowed a 24 GB card and crawled. Worth
trying in the same pass: a codebook per band for the centroids, and a
second, residual palette. The experiments and their numbers are in the
paper notes (`paper/notes.md` in the private VoluGym repo, E4b-E4d).

---

## Known limits

Everything below works. These are the places where one could work better, and
what each would take:

**Training is Chromium-only.** Brush's backward kernels need WebGPU
subgroups, which Firefox and Safari do not expose yet; the pane says so
rather than failing obscurely.

**Voxels have no export path.** They render and they are an element the scene
holds, but nothing writes them out. That wants a target format chosen first,
since the format decides what the writer looks like.

**Cleanup takes about a minute on a million points**, in a worker, with
the editor drawing throughout (CHANGELOG.md). Most of that minute is the
few hundred isolated floaters, whose exact search widens until it has
crossed the whole grid. A cap on that widening would make it quicker at
the price of exactness, for exactly the points the node exists to judge -
so it is not taken.

**Decimate ranks on a time-invariant score on TGH sequences** (CHANGELOG.md),
so the dropped set holds still between frames except where a hierarchy
segment begins or ends. A PLY sequence has no identity between frames and
still ranks each frame on its own. That an attribute-only score holds up
without rendering anything is what Camera-Agnostic Pruning (arXiv
2603.21933) and RAP (CVPR 2026, arXiv 2602.19753) show.

The budget can be spread too - "rank per region" (CHANGELOG.md). What is
left:

- **Merge instead of drop.** NanoGS (ECCV 2026, arXiv 2603.16103) builds a kNN
  graph, scores neighbouring pairs by the I-divergence between the pair and
  one moment-matched Gaussian, and greedily collapses the cheapest disjoint
  pairs, preserving mass, until the target count is reached. CPU-only, so it
  fits a worker, and it keeps quality better than dropping at aggressive
  ratios - a "merge" mode for the node.

**Replay after a change still winds through everything after it.** Only
what the change reaches is resolved again now (CHANGELOG.md), but every
later op is still undone and redone, because history is one line. That is
cheap - redoing a resolved op replays its stored set.

**Nodes move one step at a time**, up or down their chain from the context
menu. Dragging a node into a new place in its lane would be the direct
gesture; the history move underneath it already takes any distance.

**A select node's shape selects again when the primitive settles**, not live
while it is dragged: each re-selection is that replay, too slow to run per
pointer move on a large capture. The node keeps a copy of the shape for the
same reason - see SelectMesh in `src/edit-ops.ts`.

**A TGH model plays on the GPU, but the splat data holds each gaussian at
its temporal centre** (CHANGELOG.md, "TGH models play on the GPU"). What
reads the data rather than the shader - exporting the current frame,
selection by position, the centres overlay - sees that, not the frame on
screen. The CPU path (`TghFrameSource` with `gpu` off) is the frame-exact
fallback for those.

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
