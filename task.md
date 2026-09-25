# What's next

Everything outstanding, phased and ranked in the table below and then
described in full: the work in flight, then relighting - the first of
its four items built - then the places where something built works and
could work better. What is already built is in [CHANGELOG.md](CHANGELOG.md), with the
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
| 0 | 11 | Verify a training run end to end | Sonnet 5 |
| 1 | 4 | COLMAP bridge | Opus 5 |
| 1 | 14 | Seed training from an edited scene | Haiku 4.5 |
| 2 | 1 | WebGPU viewport | Fable 5 |
| 2 | 9 | Voxel renderer by instancing | Sonnet 5 |
| 2 | 8 | TGH frames off the main thread | Sonnet 5 |
| 3 | 5 | Precise replay invalidation | Opus 5 |
| 3 | 2 | Node reordering | Fable 5 |
| 4 | 3 | Colour beyond affine (gamma, contrast, curves) | Fable 5 |
| 4 | 7 | A real temperature model | Opus 5 |
| 4 | 15 | Rec.709 luma coefficients | Haiku 4.5 |
| 5 | 16 | Relighting: density grid, lights, soft shadows (built, needs a real-GPU run) | |
| 5 | 17 | Relighting: occlusion and ambient light | |
| 5 | 18 | Relighting: de-light by occlusion and a matched sun | |
| 5 | 19 | Relighting: area and volume lights | |
| — | 10 | Cleanup in a worker | Sonnet 5 |
| — | 12 | Merge by dragging output onto input | Sonnet 5 |
| — | 13 | A voxel export path | Sonnet 5 |
| — | 6 | Frame-stable decimate ranking | Opus 5 |

**Phase 0 gates everything else about training.** A training run has never
been watched from dataset to committed node. Building the COLMAP bridge on
top of a pipeline nobody has seen finish would mean debugging two unproven
things through each other.

**Phase 1 finishes the training story** - video in, poses found, gaussians
out, and a cleaned-up result usable as the seed for the next run. Seeding
comes after verification because it is the same pipeline pointed at its own
output; there is no sense building the loop before the line works.

**Phase 2 is the device move, and it must come before any new shader.** Voxel
instancing needs a shader written, and writing it against WebGL2 weeks before
the viewport moves to WebGPU means writing it twice. The TGH item is in this
phase for a different reason: WebGPU changes what the right answer *is*.
Today the fix is a worker and a frame cache; on one device the better fix is
conditioning the 4D gaussians in the shader, and the CPU stops being involved
at all. Doing the worker first is not wrong, but it is work that a later
decision may throw away - so decide the device first and then pick.

**Phase 3 is two changes to the same subsystem, in this order.** Precise
invalidation means walking a node's `inputs` backwards to find what actually
depends on it. Node reordering needs exactly that answer to know whether a
proposed reorder is even legal - you cannot move a node above something it
consumes. Building the dependency walk first as a small, testable change, and
only then letting the graph be rearranged, is much safer than discovering the
traversal was wrong while also having made history mutable.

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

**The last four have no dependencies at all** and can be picked up whenever
someone wants a clean, self-contained piece of work. Frame-stable decimate
sits there rather than in a phase because it only starts to matter once
someone is actually decimating sequences.

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
Rec.709 is one constant plus a decision someone else has to make; seeding
from an edited scene is a zip writer and some wiring. Padding that tier from
the one above would only move the surprise later.

---

## Training stops in Burn's autotuner, which cannot run on wasm

Training has been driven end to end for the first time, headless, with a
synthetic four-view nerfstudio dataset. Two blockers on our side were
found and fixed on the way - the zip the dataset was packed into, and the
missing `enable subgroups;` on the sort kernels, both in
[CHANGELOG.md](CHANGELOG.md). What remains is upstream, and the stack
names it exactly:

```
cubecl_environment::future::base::block_on
  cubecl_std::throughput::runners::compute_direct::build_kernel
  cubecl_runtime::throughput::benchmarker::ThroughputBenchmarker::measure
  cubecl_std::throughput::base::measure_peak_throughput
  burn_cubecl::kernel::autotune_bounds::with_bounds<ReduceDimAutotuneKey>
```

Burn picks a reduce kernel by benchmarking candidates, and the benchmark
measures peak throughput by *blocking* on the device. A browser cannot
block, so `read_sync` panics with "Failed to read tensor data
synchronously", the future driving `trainSteps` never settles, and the
run sits at "loading" forever with no error anyone can see.

This is not a dataset problem and not a plumbing problem: any reduce -
which means any loss - takes that path. `measure_peak_throughput` is a
plain `fn` all the way down, so making it work on wasm means making the
autotune-bounds path async through cubecl and burn. That is upstream
work in `Repos/brush`'s dependency tree, not app work.

Two smaller things fall out of it. There is a second panic just before,
in `WgpuServer::create_module`, where wgpu pops an error scope and gets
a `GPUError` that is neither validation nor out-of-memory and panics
with "Unexpected error" rather than reporting it - worth a look once
autotune runs. And note the trainer swallows panics: the wasm future
stops, the promise never resolves, and the UI shows "loading". A
watchdog on `trainSteps` that surfaces a stall as an error would have
saved most of this investigation.

How to reproduce, since it took some doing: run the training probe under
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

## WebGPU viewport — ported, now the default

Done: WebGPU is the default device, WebGL2 the `?device=webgl2` escape
hatch. The five breakages and their fixes are in the changelog; splat
rendering, bound calculation, histogram and selection were verified
numerically identical across both backends in headless Chrome (which,
unlike the embedded test pane, has a WebGPU adapter with subgroups -
driven over CDP, the debugging loop that made this port possible).

What remains on this front: the centers overlay draws one-pixel points
on WebGPU (WGSL has no point size; restoring splatSize wants a
quad-expansion pass); the engine loses one frame at startup to a
backbuffer-resize race (*Destroyed texture WebgpuFramebuffer*,
engine-side, cosmetic); a click-through in the user's real Chrome is
still owed; and the original payoff - sharing the device with the Brush
trainer so training renders in the viewport without the PLY round-trip -
is now actually reachable.

**One of our quad passes renders nothing into an offscreen target on
WebGPU.** Found while building the camera node's lens: a
`SimpleRenderPass` + `ShaderQuad` writing to a render target executes
(the pass runs, the draw is issued, no validation error) and the target
reads back empty, while the identical quad to the backbuffer works and
the engine's own `drawQuadWithShader` works to targets. Until this is
understood, in-frame post effects are not available - the lens had to
move into the final blit, which is why it warps the gizmos too. Worth
solving: it also blocks any future effect that must run before the
overlays.

**Sharing the device works untouched.** The question was whether PlayCanvas's
WebGPU device could carry what Brush needs. `createDevice` in the 2.21 engine
calls `requireFeature("subgroups")` and copies every adapter limit into
`requiredLimits` - the same device Brush asks for when it makes its own. So
`BrushApp.initExisting` can take PlayCanvas's adapter, device and queue as
they are. No engine patch, no second fork.

**The sixteen shaders do not need rewriting.** The engine transpiles GLSL
through glslang and twgsl; it is opt-in, via `glslangUrl` and `twgslUrl` at
device creation, which VoluLab does not pass today. Two wasm libraries to
serve out of `static/lib` in place of hand-porting `src/shaders` to WGSL.

**The readbacks are already right.** `src/data-processor` and `src/picker.ts`
call `texture.read()`, which is backend-agnostic and already awaited at every
call site. The sync-to-async ripple that was expected does not exist.

What is genuinely unknown is whether *our* GLSL survives that transpiler -
`splat-shader.ts` overrides the engine's gsplat chunks, and the grade palette
is RGBA32F, whose filtering and blending are optional WebGPU features an
adapter may not expose. That cannot be reasoned out from the source; it wants
a spike. Flip `deviceTypes` to `['webgpu', 'webgl2']`, wire the transpilers,
and write down what breaks. Keep the ordering rather than deleting the WebGL2
path, so the fallback survives.

There is a second reason to do it: the engine warns that
`GSplatComponent#unified` is deprecated and non-unified gsplat rendering is
going away. That migration is coming whether or not the device changes, and
doing both at once is cheaper than doing them a month apart.

The payoff is that training stops being a guest. One device means the
trainer's buffers are rendered by the viewport directly - real camera, real
gaussian rendering, no PLY round-trip on commit - and
`src/training/preview-renderer.ts` and its canvas are deleted rather than
maintained. It is also the prerequisite for conditioning 4D gaussians in the
shader, which is what would make scrubbing a TGH sequence cost the CPU
nothing.

---

## Relighting — first item built, three to go

The ask: light a capture with lights placed in VoluLab - point, spot, sun,
area and volume lights, and ambient light - with soft shadows and
occlusion. Light the scene itself blocks, not a look painted over it.

**Where it stands.** Item 16 is built: light nodes for point, spot and sun
lights, the density grid, soft shadows and the splat shader's multiply,
with the traps written up in [CHANGELOG.md](CHANGELOG.md). It was verified
in headless Chromium on SwiftShader's software WebGPU, numerically and by
eye. What it still owes is a session on a real GPU with a real capture:
timing for a grid build and a relight at a million gaussians and more, and
a look at two-sided lighting on real surfaces. Items 17 to 19 are not
started.

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
  sphere lights, with the cone for visibility.
- **Volume lights** — a selection-scoped node: select gaussians, such as a
  lamp in the capture, and they become the emitter, clustered into a few
  dozen point lights. *Select, then operate*, applied to light.
- **Ambient light** — a flat colour or an HDRI reduced to spherical
  harmonics, dimmed by occlusion.
- **Occlusion** — a handful of wide cones per gaussian through the same
  grid. It lives in world space, so it holds still as the camera moves,
  which screen-space occlusion does not.

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
with one structure. It also runs in compute, which sidesteps the WebGPU
bug above where our offscreen quad passes render nothing; screen-space
occlusion would need exactly such a pass.

**De-lighting, and why occlusion does most of it.** New light multiplied
onto a capture leaves the old shadows under the new ones, so the captured
lighting has to be divided out first. The light texture carries both at
once: new lighting over captured lighting, one factor per gaussian.

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
  a choice rather than a rule.
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
   gets one flat value. Shadow rays also start two cells off the surface,
   so a contact shadow begins up to two cells late - any closer and every
   surface dims itself.
3. **Large scenes - partly answered.** The grid's box already trims half a
   percent of gaussians off each end of each axis, so a few floaters do not
   stretch it. For a big outdoor capture the cells still get coarse; a box
   the user places is the cheap answer, nested grids the thorough one.
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
  gizmo in the viewport does not pick it, which cameras cannot do either.
- Lights do not animate: no timeline track yet.
- Changing a light's settings is not an undo step, the same as a camera
  node's settings. Moving or aiming one with the gizmo is.

---

## Known limits

Everything below works. These are the places where one could work better, and
what each would take:

**Training is Chromium-only, and unproven end to end.** Brush's backward
kernels need WebGPU subgroups, which Firefox and Safari do not expose yet;
the pane says so rather than failing obscurely. And no full run has been
watched from dataset to committed node - the pieces typecheck, build and
load, but a real training run is the next thing to sit down and verify.

**The voxel renderer is a box entity per cell.** Certainly correct, no custom
shader, and slow once the count runs to thousands. Fast means instancing with
a per-instance colour stream - a vertex format and a shader.

**Voxels have no export path.** They render and they are an element the scene
holds, but nothing writes them out. That wants a target format chosen first,
since the format decides what the writer looks like.

**Merging is offered by name**, in the context menu, rather than by dragging
one node's output onto another's input. The dataset wire proved the drop
gesture out - an import node's output drags onto a train node - but merge
still goes through the menu; it wants the same treatment.

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

**The bound pass needs 64 bytes of colour targets per sample.**
`src/data-processor/calc-bound.ts` renders into four RGBA32F targets.
WebGPU only guarantees 32 bytes per sample. The engine asks for whatever
the adapter offers and real GPUs offer more, but an adapter at the minimum
rejects the pass - SwiftShader is one, found while testing relighting
headless - and every splat is left with an empty bound, so culling hides
it and camera framing breaks. Splitting the pass in two, or RGBA16F where
the precision allows, would fit the minimum.

**TGH frames are evaluated on the main thread.** A million active gaussians
per frame costs seconds of CPU per scrub. A worker and a small frame cache
are the next step; conditioning in the shader, which the WebGPU viewport
would unlock, is the one after.

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
- **Nothing seeds training from an edited scene.** Brush accepts an
  `init.ply` in the dataset, so retraining from a cleaned-up result is
  reachable - it needs a zip writer on the JS side, which VoluLab has not
  got.
