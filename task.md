# What's next

Two pieces of work are decided and not started, and below them the places
where something built works and could work better. What is already built is
in [CHANGELOG.md](CHANGELOG.md), with the reasoning kept.

Terms used below:

- **op** — an `EditOp` in `src/edit-ops.ts`. Every node in the graph is one.
- **selection-scoped** — acts on the selected gaussians rather than the whole
  object. This is the property that makes a node belong in a graph whose
  premise is *select, then operate*.

---

## COLMAP bridge — decided, not started

Training needs posed images. Today a video is ingested to frames and VoluLab
writes a `run-colmap` script for the user to run - honest, but it leaves the
app, and dropping raw frames into the training pane just answers *format not
recognized*.

**A local bridge, not a port.** COLMAP will not compile to WASM in any form
worth having: it wants Ceres, SuiteSparse and CUDA SIFT, and a browser build
means CPU-only feature extraction plus threads, which means SharedArrayBuffer
and COOP/COEP headers - the exact requirement avoiding which is why Brush was
chosen as the trainer. So COLMAP stays native and fast, and a small local
helper process drives it, with the training pane talking to it over
localhost.

The shape: drop a video or a folder of frames, VoluLab extracts and posts
them, the bridge runs feature extraction, matching and mapping, and hands
back a dataset the pane starts training on. Progress streams back so the pane
can show which stage is running.

This is the one decision in this project that took the *cheaper* option
rather than the maximal one, and deliberately - a WASM COLMAP would be weeks
of work likely ending too slow to use. The cost, stated plainly: it is the
first piece of VoluLab that is not client-side. It has to stay strictly
optional. Everything already built must keep working with no bridge running,
and a posed dataset must still be loadable by hand.

---

## WebGPU viewport — assessed, not started

Move the viewport off WebGL2 so the app and the trainer share one device.
Estimated twice: the first estimate, in the training plan, called it *its own
project* and listed three blockers. All three checked out cheaper than that,
and the correction is the point of this entry.

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
