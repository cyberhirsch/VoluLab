# Changelog

What is built, and why each piece works the way it does. Newest first.

This is the companion to [task.md](task.md), which holds what is next and
what is known to be rough. Entries here keep the reasoning and the traps, not
just the feature name - the point is that someone touching this code in six
months finds out why before they change it.

---

## Graph: named inputs

A node can take things in besides its chain, through named inputs on its
top edge, each with its name over it. The first is the train node's dataset,
which used to arrive on its left edge as though it were the chain.

- **An op declares its inputs** with a `ports` getter: a name, a label, the
  kinds it takes - an object, a selection, a primitive or a dataset - and
  what is wired in now. The graph only draws them; `graph.connect` and
  `graph.disconnect` in the editor say what a wire means for each kind of
  node.
- **Wiring by hand.** Drag out of a node's output and the inputs that take
  what it carries light up. Let go over one of those nodes and the wire goes
  into the input nearest the pointer, among those that take it. A select
  node's wire carries its selection and the object under it; any other
  object node's, the object. A wire let go anywhere else still offers the
  nodes to add, as before.
- **Cutting a wire** is in the node's context menu, "disconnect" plus the
  input's name.
- **An object wire comes from the end of its lane**, the object as its edits
  leave it, like a merge's inputs.
- Nodes that take nothing in - a light, a dataset, a camera - lost the input
  stud on their left edge that nothing could ever arrive at.

Checked headless with real pointer drags: the dataset input lights up for a
dataset's wire and not for an object's, a drop on the input or on the node's
body wires it, the menu cuts it, and a dataset wire let go over nothing still
makes a train node wired to it.

---

## Relighting: a relight node per object

The scene lighting settings - captured light, grid resolution, occlusion
range and strength, de-light, its floor, and whether deleted gaussians count
- moved off the light's panel onto a node of their own. The relight node
sits on an object's lane, and each object has at most one.

- **Adding a light adds relight nodes.** Every object without one gets a
  relight node with the defaults, just ahead of the light in history. Asking
  for another opens the one there is.
- **Without one, a light only adds.** An object whose relight node is
  deleted or bypassed is still lit: its captured light is kept whole and the
  lights are added to it, with no shadows, no occlusion and no de-light.
  Those three need the grid, and the grid is the relight node's.
- **Per object.** Each object's pipeline runs with its own node's settings.
  The one scene grid that everything's shadows are traced through is built
  only while some object has a relight node. It is as fine as the finest any
  node asks for, and its memory is given back when none asks. Every object
  still goes into it, so an object with no relight node still casts
  shadows on those that have one.
- **The panel** is the old scene section, with the note about a grid the GPU
  could not hold. It edits the node's settings in place, like the light's
  panel, and the relighter sees the change on its next frame.
- **Projects** save each object's relight settings by the object's place in
  the list, and reopen them on the same objects. A project from before this
  had one lighting for the whole scene, and its lights relit every object,
  so each object comes back with a relight node holding that lighting.

Checked headless: with the node's settings the same as the old global ones,
every relighting texture is bit for bit what the build before made, at 128
and 256. Bypassed, the floor under a sphere is lit evenly at its captured
light plus the light. Typing a value, saving and reopening, and opening a
project from before relight nodes all work.

**The trap: adds are queued.** Eight lights added in one go each found no
relight node yet - the first one's add had not landed - and each queued its
own, the last applied winning. The nodes on their way in are counted now.

**Fixed on the way: typing into the light and camera panels.** Each
keystroke's edit rebuilt the node pane, which took the panel out from under
the field and wrote the setting back over what was being typed - "1.5" came
out as 1, and "0." was read back as "0". The pane now leaves a panel that
edits its node in place alone while it shows the same node, and anything else
that rebuilds while a field is being typed in puts back its focus and text.

**Fixed on the way: a camera node's port offered object nodes.** Dragging out
of it offered select, colour, crop and the rest, for a lane that holds a
camera. Only an object's lane offers them now.

---

## Number fields: drag, wheel, right and middle click

Every number field in the app now behaves the same way: the light, camera
and training panels, the node panel, the transform panel, settings, tool
options, the export dialogs and the timeline.

- **Right click** sets it to 0, or to its minimum where 0 is not allowed:
  de-light floor goes to 0.02, scale to 0.001.
- **Middle click** puts its default back:
  - a light's or a camera's from the node's defaults;
  - scene lighting's from the relighter's;
  - a settings slider's from the preference behind it, through a new
    `preferences.default` lookup, so it matches what a preferences reset
    gives;
  - a training field's by blanking it, which means the trainer's own
    default;
  - a dialog's or a tool's is the value it opens with.
- **The wheel** steps it, one step a notch. A trackpad's small deltas add up
  to a notch.
- **Dragging** across it scrubs it, as in Adobe's apps, one step every four
  pixels. A press that does not drag selects the number to type over, so
  the field is not focused under a drag and no text gets selected.
- **Modifiers:** Shift makes a step ten times as big, Ctrl or Cmd a tenth.
  Alt stays PCUI's: dragging one axis of an x/y/z field with it held moves
  all three.
- The browser's spin arrows and PCUI's little drag handle are gone. The
  whole field is the handle now, with a left-right cursor until it is typed
  in.

It all lives in one place, `src/ui/value-fields.ts`, on document-level
listeners, so a field built later (a node's panel, a dialog) is covered
without registering. Only a default has to be given, since nothing in a
field says what that is. The measure tool's length opts out of resets: the
scene is scaled to it, and a stray right click would shrink the whole
scene.

A drag, a burst of wheel notches and a reset are each one undo step. Each is
bracketed by PCUI's `slider:mousedown` and `slider:mouseup`, which the
transform panel already treats as one edit. Plain fields get `input` while
the number moves and one `change` when it settles, so the node panel's
fields replay once per gesture, not per pixel.

Steps were chosen for dragging. The node panel's rotation moves a degree
where it moved a hundredth. The position and size vectors move a
centimetre, where PCUI's default for a vector is 1: a metre a step.

**The trap: PCUI's vector input reads Alt off the event.** Its own
`slider:mousedown` handler reads `evt.altKey`, and emitting the event with
no event object threw inside it. PCUI catches handler errors and only logs
them, so nothing failed outright. The real mouse event goes through now,
which is also what keeps Alt-drag working.

---

## Relighting: grids up to 1024

Grid resolution goes to 512, 768 and 1024 now, each the number of finest
cells along the scene's longest side. At 256 and below every result is bit
for bit what it was: every texture the relighter writes was hashed on the old
build and the new, with every kind of light and de-light on, at 128 and 256.

- **Fitted to the GPU.** A grid is two buffers of four bytes a cell, and each
  has to fit the device's limit on one buffer. WebGPU only guarantees 128 MiB:
  a grid of any shape fits that at 256, while a cube-shaped one at 1024 needs
  over thirty times it. So the grid is made as fine as the device's own limit
  allows before anything is allocated, and the spare room kept for a drag
  never pushes a buffer past it.
- **Out of memory is found out late.** A grid within the limit can still not
  fit in the memory that is left, and WebGPU only reports that
  asynchronously. The grid is used broken for a frame, then rebuilt with half
  the cells that failed. SwiftShader allows 1 GiB buffers; asked for 1024, it
  got 952 within that, failed to allocate it, and settled at 754.
- **The panel says so.** When a grid came out coarser than asked, a note
  under the setting says what it is using.
- **Traces scale with the grid.** A trace's step budget, and the level it
  skips empty space at, were counted in finest cells, so at 1024 a hard
  shadow ray gave up a quarter as far out as at 256. Both now scale with how
  much finer than 256 the grid is, and the pyramid gets a level per doubling,
  so the coarsest level stays as coarse as it was.

**The trap: a fine grid lets a floor shadow itself.** At 512 the test floor,
open to a sun, came out with a third to two thirds of its light. A gaussian
too wide for the deposit's footprint goes into a coarser level and fills
whole cells of it, so its own density reaches a cell and a half of that
level off its surface. A shadow ray starting two finest cells out starts
inside it. At 256 the floor's 12 mm gaussians fit the finest level; at 512
they go one up. On a grid finer than 256, a ray now starts two cells of the
level its gaussian was deposited in, and a round gaussian's starts past its
own three sigma. De-light's shadow shrinking counts in the same cells. The
floor came back to exactly its unshadowed value at every size, and round
gaussians with nothing above them to within 7% of theirs. De-light at 512
lifts the matched sun's baked shadow to 0.67 against 0.71 open ground, where
128 overshoots to 0.79.

**The trap: a rounding error broke "unchanged at 256".** Scaling the offset
by the deposit level's cell over the finest cell is not exact even when the
two are equal, and every texture differed from the old build. The scale is
a power of two now, and multiplying by one is exact.

At 256 and below, a gaussian wide enough to go into a coarser level still
shadows itself a little, as it always has: a 3 cm round gaussian at 256 gets
0.3 of its light where 0.5 is right.

---

## Relighting: area and volume lights

The last relighting item. Two new families of light, both built on what
the first item already does: a light's irradiance per side of each
gaussian, and one cone through the density grid for its shadow.

- **Area lights: rectangle, disk and sphere.** Each sits where a point
  light would and faces its aim point. Its size is a share of the distance
  to that point, like a point light's softness, and its softness follows
  from its size. Irradiance is the emitter's vector form factor:
  - A rectangle is exact: Lambert's formula over its four edges, with the
    edge angles taken by `atan2` because `acos` loses a distant light's
    tiny edges.
  - A sphere is exact.
  - The horizon is handled by treating any emitter as the sphere with the
    same form factor and direction (the Frostbite formula), which is exact
    for spheres and close for the rest.
  - Rectangles and disks light their front only.
  - Each is scaled so a surface at its aim point, facing it, gets exactly
    its intensity - the same promise every other light makes.
- **Volume lights: what glows in the capture, made into light.** Select
  the gaussians of a lamp, a window or a screen and add a light from the
  selection (or turn any light into a volume light while they are
  selected):
  - Each gaussian is weighed by what it shows: its luminance times its
    opacity times its footprint.
  - Weighted k-means groups them into 16 emitters, with the brightest
    gaussian as the first seed and farthest-point seeding after it, so the
    same selection always gives the same emitters.
  - Each emitter keeps its share of the light, its colour and its spread.
    Each has its own falloff and Lambert term, but they share one shadow
    cone, toward their middle and as wide as they spread - so a lamp of
    thousands of gaussians costs one trace.
  - The emitters are placed relative to the light, so moving the light
    moves them.
- Both can be set to "baked in" and go through de-light like any other
  light.

**The trap: a disk's closed form only holds head-on.** The usual formula
for a disk is exact for a point on its axis and off by up to 6% across the
floor beside it. A disk is now an octagon of the same area, run through the
rectangle's exact edge sum: within 0.08% of the exact formula everywhere
the test looked.

**The trap: a volume light shadowed its own light.** Its emitters are
inside the glowing gaussians, so its shadow ray has to stop short of them.
But the cone is wide by the time it arrives, reads coarse levels, and a
coarse level's blur reached into the glowing object anyway: the floor a
little way from a glowing sphere got 59% of its light. Two changes:
- The ray now stops at the emitters' reach: each cluster's offset plus
  twice its spread, since a cluster's radius is its members' root-mean-square
  distance.
- Every cone now caps its level by how far it has left to go, the same way
  it already capped it by its height above the surface it left - so no
  coarse level near either end blurs into the surface at that end.

The floor then got its full light at every distance, while a light made
from the sphere's top cap alone is still fully shadowed by the rest of the
sphere. The cap changed item 16's soft point light by 1% (a little less
spurious blur) and its hard shadows not at all.

**The other trap: the lamp itself went dark.** Its emitters sit just
inside it, behind the side a camera sees, and relighting treats its colour
as a surface's. But a glowing gaussian's colour is its own light, so it now
glows with the light instead: the light's intensity added, unshadowed. At
the usual intensity it looks as captured, turned up it brightens, and turned
off it goes dark (1.05, and 0.25 with the light at zero, on the test
sphere). Which gaussians glow is decided by distance to the emitters.
Testing only the nearest one left seams where clusters meet; reaching
further spilled glow onto the floor under the lamp. Summing a short falloff
over all of them does neither.

Verified on the floor and sphere scene:
- Rectangle, disk and sphere lights over the open floor each matched the
  exact form factor at over 3,000 gaussians, to 0.02% on average.
- A rectangle facing away lit nothing behind it, and a sphere light beside
  the sphere, partly below its gaussians' horizons, gave no NaN.
- The sphere made into a volume light gave 16 red emitters at its centre.
  The floor under it and further away got exactly the unshadowed light, and
  moving the light moved the pool of light with it.
- A baked-in rectangle ran through de-light.
- Kinds, sizes and emitters survived a project round trip.
- The face showed each kind's own settings.
- The earlier items' shadow, ambient and de-light numbers came out
  unchanged, apart from the 1% above.

---

## Relighting: de-light by occlusion and a matched sun

The third relighting item. New light used to be multiplied onto the
capture, so it landed on top of the capture's own shadows. De-light divides
an estimate of the capture's light back out first: new light over old light,
still one factor per gaussian.

- **Occlusion is the automatic half.** The capture's sky is taken to be
  white and as bright as the open sky, dimmed by how open each gaussian
  was. That openness is traced through the same kind of grid as the
  ambient light's occlusion, with the same kernel and the same range. On
  an unedited capture the two are the same number, so a flat white ambient
  light with de-light at full strength gives the capture back exactly - the
  test checks every gaussian and finds no difference at all.
- **A matched light is the manual half.** Any point, spot or sun light can
  be set to "baked in": it no longer adds light, it stands for one the
  capture was shot under. Its light and shadow are added to the estimate.
  Its intensity is relative to the sky, and the estimate is scaled per
  channel so an open surface squarely facing every matched light is 1. That
  leaves such a surface exactly as captured, and a warm sun's cast comes out
  of the shadows too. The gizmo frames a matched light in a square.
- **De-light sees the object as captured, not the scene as edited.** Each
  object gets a grid of its own: its own gaussians and nothing else, where
  the capture put them - no palette transform - and the deleted ones too by
  default. A deleted car's baked shadow comes out of the road, while
  relighting, which sees the scene as edited, puts nothing back. A second
  capture set beside this one was not there when this one was shot, so it
  shadows it without being taken for part of its baked light - which one
  shared grid would get wrong. "De-light counts deleted" can be turned off
  for cleaned-up floaters, which otherwise count as occluders too.
- **Guards.** A floor on the divisor bounds how far a deep baked shadow is
  lifted, and a strength fades the whole estimate toward 1, because bounce
  light makes a real cavity brighter than occlusion predicts. Strength
  defaults to half.
- **Its own pass, rarely run.** The captured grid depends only on the object
  and its transform, and its occlusion only on that and the range. They are
  built once and kept. The divisor itself is a pass of its own, stored per
  side, which reruns only when a matched light or the de-light settings
  change. Moving a light that adds light never reruns it.

**The trap: dividing by a shadow shows every error in it.** Multiplied in,
a shadow a cell off reads as a soft shadow. Divided out, the same error
lifts a white ring round the baked one. Two causes, found by comparing the
traced shadow against the analytic one baked into a test capture:

- Shadow rays left along the surface normal, a couple of cells up, which
  moves every shadow toward the light by the height over the slope - about
  1.3 cells for a sun at 56 degrees. They now leave along the ray itself,
  as far as it takes to reach the same height, so the ray is the one from
  the gaussian. It applies to every light; item 16's measured shadows came
  out identical.
- The grid blurs every occluder by about a cell and a half, at 128 cells
  and at 256 alike, so a traced shadow is that much wider than the real
  one. De-light takes it back out: a point counts as lit if the best of six
  rays from around it, off to the side, gets through - the shadow shrunk
  from its edges. It shrinks by 2.5 cells, deliberately more than the
  blur, because the division is lopsided. Calling a half-lit point shadowed
  lifts it nearly twice too bright; calling a half-shadowed point lit
  leaves it a little dark. So an edge the grid cannot place exactly ends
  as a thin dark outline, which reads as a trace of the old shadow, rather
  than a white line, which reads as a fault.

Softening the matched light does not help: a wider cone reads coarser,
blurrier levels, and its shadow grows.

**The other trap: an undo brings a gaussian back without changing the
captured grid.** Deleted gaussians are in the captured grid by default, so
deleting or restoring one changes nothing there, and nothing would trace
it again. The captured occlusion and the divisor are therefore worked out
for every gaussian, deleted or not.

Verified on a test capture with its lighting baked in - an analytic sky
occlusion and a sun twice as bright as the sky, whose shadow falls on the
floor:

- De-light by occlusion alone matched the formula at every gaussian, to
  0.09%.
- The ambient identity held exactly.
- The matched sun, placed where the baked one was, lifted the baked
  shadow's inside from 0.20 to 0.79 against 0.70 for the open floor.
- Deleting the sphere with de-light counting it lifted the floor under it
  to 0.73 against 0.72 open; not counting it left the baked shadow in place,
  as it should.
- Moving the matched sun reran de-light and lighting and no grid; moving
  the other sun reran lighting alone.
- The undo rebuilt what it had to.
- The role survived a project round trip, and an older project's lights
  load as lights that add.
- The shadow and ambient numbers of items 16 and 17 came out unchanged.

---

## Relighting: ambient light and occlusion

The second relighting item. A light node can now be an ambient light:
light from every direction, a flat colour or an environment, shaped by
occlusion traced through the same density grid as the shadows.

- **An environment is nine numbers per channel by the time it lights
  anything.** A loaded HDRI or photo is decoded straight into a 32 x 16
  map - scanline by scanline for `.hdr`, so an 8K image never exists as
  floats - normalised to a mean luminance of 1, and projected onto three
  bands of spherical harmonics convolved with the cosine lobe. Every
  ambient light is summed into one set of coefficients after the light
  records, so ten ambient lights cost what one does. The small map, not
  the image, is what the project stores; rotating the environment later
  re-projects from it.
- **Occlusion is near-field on purpose.** Six cones a side, 60 degrees
  wide, cosine weighted, out to a range that is a share of the scene. Traced
  to infinity, the inside of any room would see no sky and ambient light
  would do nothing indoors - there is no bounce light to make up for it.
  Each side also gets a bent normal, the direction its open sky lies in,
  which is where the ambient coefficients are evaluated.
- **Occlusion runs only when it can matter.** Its textures exist only
  while an ambient light is on. It reruns when the grid or the range
  changes; moving or changing a light, or the occlusion strength, only
  relights.

**The trap: wide cones occlude the surface they leave.** The first run
said an open floor saw five percent of the sky. A wide cone reads coarse
levels early, a coarse cell near a surface contains that surface, and a
trilinear sample reaches a whole coarse cell further - so the cone reads
the floor it started from. Moving the start further out cannot fix it,
because the cone widens as fast as it climbs. The fix caps the level a
sample may read by its height above the surface: the cell may be at most
half the height, which keeps the surface's own coarse cell out of reach,
and the cap is applied in whole levels, because blending toward a
fractional level reads the next coarser cell - the one being kept out.
Near the surface the cone is sampled narrower than it is. The same cap now
applies to shadow cones, where a very soft or grazing light had the same
problem more quietly. The floor went from 0.05 open to 1.00.

Verified on the floor and sphere scene: the open floor and the sphere's
top and sides fully open, the floor under the sphere at 0.57 and its
underside at 0.36 at the default range, both darker at a longer one;
strength 0 removing the effect without touching the occlusion; an HDRI
sky, loaded through the node's own file button, lighting the sphere's top
about eight times as brightly as its underside; a half-bright
environment swapping sides when turned 180 degrees; moving a sun
relighting without rerunning occlusion; the environment surviving a
project round trip; the earlier shadow numbers unchanged.

---

## Relighting: light nodes, soft shadows, a density grid

A light node puts a point, spot or sun light in the scene, and the scene
casts its shadows onto itself. The first of the four relighting items in
[task.md](task.md); the design and what is still to come are there.

How it works, in one pass: a compute kernel splats every drawn gaussian's
extinction into a pyramid of grid levels, a second kernel lights every
gaussian once by tracing a cone from it toward each light through that
pyramid, and the splat shader multiplies the result in after the grade and
before exposure. The grid is rebuilt when the gaussians change - an edit, a
transform, a new frame - and the lighting when a light or the grid does.
Never for the camera. It is WebGPU only; on the WebGL2 fallback the lights
are drawn, the node says why they light nothing, and the shader's lighting
branch is simply never compiled in.

What building it settled, and the traps on the way:

- **The grid lives in storage buffers, not a 3D texture.** The question the
  plan left open. The engine's shorthand WGSL declarations reflect every
  storage texture as 2D, and its WebGPU texture creation gives a volume
  texture one layer. Buffers are portable and fully under our control: a
  `u32` accumulator, because WebGPU has atomics on integers and nothing
  else, written in fixed point with stochastic rounding so faint gaussians
  still add up, then resolved to float levels by hand. Trilinear sampling
  is done in the kernel. Every kernel declares its bindings explicitly, the
  way the engine's own sort does, and reads the RGBA32F transform palette as
  unfilterable so it binds on adapters without float filtering.
- **A gaussian too big to sample well deposits into a coarser level**, and
  a push-down pass hands that to the finer cells. Without it a sky-sized
  gaussian lands as a few dense clumps and casts black spots.
- **The grid covers the gaussians, not their worst floater.** Its box is
  the drawn centres with half a percent trimmed off each end of each axis,
  so one stray gaussian far away does not stretch the cells over nothing.
- **Every gaussian is lit on both sides of its flat axis.** A captured
  gaussian has no outside - the density around a single-layer wall is the
  same on both sides - so orienting normals from the grid cannot work. Both
  sides are lit into two textures and the splat shader keeps the one facing
  the camera. A wall seen from the room gets the room's light; a sun behind
  it lands on the side nobody captured. The case that settles it is a room
  lit through a window, where every one-sided scheme leaks sun onto the
  inside of the walls.
- **Shadow rays start two cells off the surface.** A surface deposits into
  the two cells around it and a trilinear sample reaches one further, so at
  one cell every surface dimmed itself by about a fifth, by an amount that
  depended on where it sat inside its cell. The cost is a contact gap of
  up to two cells before a shadow starts.
- **Intensity and softness are relative.** Intensity is how bright a light
  is at its aim point, softness is its size as a share of that distance, so
  a lighting setup means the same on a capture of any scale.
- **Nothing listens to history.** The relighter compares what is there
  frame to frame - lights, deletions, transforms, data - so undo, bypass, a
  gizmo drag and a sequence frame all reach it the same way.
- **Two engine behaviours to know.** Compute uniforms and storage-buffer
  writes land before the frame's commands run, so a kernel dispatched twice
  in a frame with different uniforms needs two `Compute` objects - each grid
  level has its own pull. And the light state is compared in doubles:
  compared through a float copy, a captured-light value of 0.2 never equals
  itself and the lighting reran every frame.

Verified in headless Chromium on SwiftShader's WebGPU, against a synthetic
capture of a floor and a floating sphere: the floor under a hard sun holds
only the captured light while the open floor gets all of it, the sphere's
far side stays dark, deleting the sphere removes its shadow and undo brings
it back, a soft point light gives a penumbra and falloff, and hiding or
undoing every light switches relighting off. The flags that work there are
`--enable-unsafe-webgpu --enable-features=Vulkan --use-vulkan=swiftshader
--use-angle=swiftshader`; `--use-webgpu-adapter=swiftshader` crashed the
renderer mid-load. SwiftShader also rejects the bound pass's four RGBA32F
targets, which leaves splats with an empty bound, so screenshots there need
the bound set by hand - see Known limits in task.md.

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

## The refine that asked the wrong device

Training reached its first refine and died there, with a panic that
named a service and no reason: "Service WgpuServer<AutoCompiler> not
initialized". Two bugs stood between a dataset and a second iteration,
and the first hid the second.

Autotune measures peak throughput before choosing a kernel, and every
throughput runner timed its sample with a blocking sync. Wasm cannot
block, so the probe panicked out of cubecl's reader about a second in -
"Failed to read tensor data synchronously". The runners now skip the
wait but keep the launch, so the device services a kernel touches still
come up in the order they do on native; the measurement is reported as
unknown rather than invented. Autotune on the web now picks kernels
without a measured rate, which is a real cost and the right trade.

Under that sat the actual bug, in brush's own `refine`. It needs a wgpu
client, because `memory_cleanup` lives there rather than on `Device`,
and it took one from `WgpuDevice::default()` - with the device the
splats are on sitting one line above. On desktop that is invisible:
brush runs on the default device, so the default and the real device
are the same server. On the web the device arrives through
`initExisting`, nothing is registered against the default, and the miss
cannot heal itself, because creating a server needs a blocking call
wasm does not have. A line that is correct everywhere else is fatal
here.

Finding it took making the panic say which device it wanted and which
devices existed. Two ids came back, one holding no services at all, and
the caller was one grep away. The lesson is the one the sort kernels
already taught: a panic that names only its own location costs more
than the fix it hides.

## Training, actually training

Two bugs, one hiding the other, and between them a run that died about a
second after Start on every dataset.

The loud one was wgpu. `popErrorScope()` resolves with `null` when
nothing went wrong, and wgpu reads that through wasm-bindgen's
`JsOption`, which counts only `undefined` as absent. So a clean scope
arrived as a present error, fell through `Error::from_js` - which knows
`GPUValidationError` and `GPUOutOfMemoryError` and nothing else - and hit
its `panic!("Unexpected error")`. wgpu pops a scope after ordinary work,
so this fired on the first clean one, and the panic named a line with
nothing to do with the cause.

Handing back `undefined` instead is the whole fix, and it lives in the
host: `reportCleanErrorScopeAsAbsent` in the engine, the same shape of
workaround as the subgroups directive beside it - a property of the JS
side the Rust cannot see. A real error is an object and passes through
untouched.

Underneath it was cubecl. Autotune measures peak throughput before
choosing a kernel, and every throughput runner times its sample with
`block_on(client.sync())`. Wasm cannot block, so the probe panicked from
cubecl-environment's reader: "Failed to read tensor data synchronously."
The cubecl family now points at a fork branch that returns, on wasm, the
no-operations no-duration value an unsupported feature already returns -
a rate that is unknown rather than wrong. The rebuilt wasm is committed,
as the trainer's artifacts always are.

Neither bug could be seen past the other. The wgpu panic fired seventy-odd
times and drowned everything; silencing it revealed the cubecl one, and
only fixing both gets a first iteration. What found them was a local
build with its name section kept, driven from a bare page against a zip
served over http - the app's own picker being a native dialog, and the
viewport's own device being loud enough to bury the trainer's.

## What a training run says while it works

Training could sit on "loading dataset" indefinitely with nothing to
read: no progress, no error, and no way to tell a big dataset from a
dead run. Two things made that silence.

The first is the trainer's own API. `trainSteps(n)` returns only once
`n` training steps have been taken, and the whole loading phase - every
message the loader produces along the way - arrives inside that first
call. Until the dataset is loaded *and* a step is done, the host has
nothing to show.

The second is what happens when the wasm dies. A Rust panic inside the
training future does not reject that promise: the task is dropped, the
await never settles, and the phase stays "loading" for as long as the
tab is open. The panic text goes to `console.error` from the panic hook,
and the trap behind it surfaces as an unhandled rejection - both outside
anything the run was listening to.

So the run listens to both now. A panic ends the run and puts its own
message on the node, instead of a wait with no end in it. The first
batch also asks for a single step rather than five, so a run leaves
"loading" as soon as one has actually been taken.

And because the trainer says nothing during a load, the load is measured
from outside: the clock, the trainer's wasm heap - which grows as the
dataset decodes, and is the only sign of life a zip source gives - and,
for a picked directory, the files it has opened against the files there
are, counted by wrapping `getFile` for the length of the load.

Each train node keeps a log of its run: the GPU it got, the dataset it
was handed, view counts, warnings, the error that ended it, and a line
every 30 seconds while a load is still going. The log belongs to the
node rather than the engine, so it outlives the run that wrote it and a
failure is still readable afterwards.

What is still not visible is per-image loading progress. It exists - the
loader emits a message per view - but those messages are buffered until
the first batch returns, so reaching them means changing the trainer's
API, not the host.

## The trainer's sort kernels, compiling at last

Training never got past "loading", and the reason was three layers down.
Brush's radix sort uses subgroup builtins, and WGSL requires `enable
subgroups;` at the top of any module that calls one - having the feature
on the device is not enough. The kernel generator omits the directive
because it asks wgpu what the device supports, and a device handed to
wgpu as a raw JS handle - which is how ours goes in, so the trainer and
the viewport can share buffers - reports no features back.

So every sort kernel failed to compile, every pipeline built from one
was invalid, and what surfaced was a wasm panic about reading tensor
data synchronously: three steps removed from the cause, and unreadable.

The directive is now prepended when the trainer's device compiles a
module that uses subgroups and lacks the line. It is scoped to that one
device, which belongs to the trainer alone.

Getting there needed the browser's own compilation messages: wgpu only
reports "invalid due to a previous error", which names nothing. Hooking
`createShaderModule` and reading `getCompilationInfo()` gave the actual
line - worth remembering the next time a pipeline is mysteriously
invalid.

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
