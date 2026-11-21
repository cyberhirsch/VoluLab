# Changelog

What is built, and why each piece works the way it does. Newest first.

This is the companion to [task.md](task.md), which holds what is next and
what is known to be rough. Entries here keep the reasoning and the traps, not
just the feature name - the point is that someone touching this code in six
months finds out why before they change it.

---

## Motion scale

A motion scale node multiplies how far a 4D model's gaussians travel from
where they are at their temporal centres: 0 freezes each there, 1 is as
recorded, 2 exaggerates. Keyable, so motion can fade in and out.

It is a uniform (`motionScale`) in the shader and a factor on the travel in
the sort worker's keys (`k` on the sort request), so what is drawn and what
is sorted agree. The fades are untouched: each gaussian still lives when it
lived. The spatial bins the worker built for the model assume the trained
travel; above 1 a gaussian can land outside its bin's range and is clamped
into the nearest, which costs a little order accuracy, not correctness of
what is shown. Bounds, picking and selection still use the trained
positions. Smoothing the motion over time to remove jitter, which the PRD
lists as an option, is not built.

---

## Time warp

A time warp node retimes a 4D model with a curve: its speed is a parameter,
and keying the speed makes a ramp. Frame f of the warped sequence shows the
model at the integral of the speed up to f (sampled eight times a frame,
trapezoids), so between frames the model is shown between frames - slow
motion, not held frames. The sequence is as long as the curve takes to get
through the model, cut off at ten times its length if the speed stalls.

The map (`WarpMap`) reads the speed's keys itself; the keyframe driver writing
the speed into the node per frame changes nothing, and a curve edited in the
curve editor is picked up by the node's frame hook, which retimes the object
so the timeline gets its new length.

---

## Ground plane

A ground plane node turns an object so its floor is level and puts the
floor at a height: from three points picked on it in the viewport, or from
the plane most of its still gaussians lie on (RANSAC with a tolerance as a
share of the object's size, then the least-squares plane of the inliers).
The floor's normal is taken to point towards the object's centre, with a
flip for when that is wrong. A capture that came in on its side is put
right by the same turn. The floor height can be keyed.

It is a transform node whose values are worked out (`GroundPlaneOp extends
TransformNodeOp`), so it composes in the chain as one and a project keeps it
as one, with what it was worked out from. It is fitted once when added;
fitting again is a button, not something it does whenever anything above it
changes.

Points are picked by a one-shot viewport click (`motion.pickPoint`), using
the same surface pick as the orient tool, and stored in the object's own
space.

---

## Align

An align node moves one object onto another, wired into its "reference"
input or picked in the node pane (an object with exactly one other in the
scene gets that one). By overlap: ICP, point to point, on the still
gaussians of both, with a radius for how far apart two gaussians may be and
still be the same place, which pulls in towards a few times the residual as
it settles; it can start from the objects' centres. Or by point pairs picked
on both, three or more for a full fit (Horn's quaternion method), fewer for
a move.

What it comes to is a transform: the node is a transform node holding it
(`AlignOp extends TransformNodeOp`), which a project keeps with the reference
and the pairs. A merge after it sees two objects in one place.

ICP finds a nearest fit, which on a shape with a symmetry is one of several:
the test helix (`cloud.ply`) slides along its own screw and still overlaps
to 0.3 % of its size.

---

## Stabilise

A stabilise node takes the rigid motion of what the select nodes above it
leave selected out of the whole object, so the selection holds still where
it is at the reference frame: a shaking rig held by a wall or a floor.
Strength 0 to 1, keyable. Taking it out of the rest only, the PRD's
alternative, is a split and a stabilise, and is not built as an option.

On the alley sample the fastest gaussians live about a frame each, so the
fit there is chained frame to frame rather than straight from the
reference; a test cannot hold such a selection still, only steadier (the
drift of what was fitted to over two frames halves).

---

## Track and attach

A track node fits a rigid transform per frame to what the select nodes
above it leave selected (everything, with nothing selected). An object
wired into its "attach" input, or picked in the node pane, follows it as if
carried, from where it stands at the reference frame: a hat on a moving
head. Attaching a camera is not built.

The fit (`motion-fit.ts`) works on up to 20 000 of the selected gaussians at
their positions per model frame - the stored centre moved along the velocity
and weighted by the temporal falloff, as the shader draws them - with
Horn's quaternion method. Each frame is fitted straight from the reference
frame while a fifth of the gaussians there are still there, so their centre
is held exactly; further out, where they have faded and others carry the
motion, it is fitted from the frame before and chained on. Between frames
the track is interpolated (lerp and slerp). The fit is kept while the
selection, the reference frame and the model stay the same: 1.1 s for 9 331
gaussians over 100 frames.

The keyframe driver asks the node to place the attached object each frame
(`FrameDriven.animate`); with a node after it that places either object
again, the node is replayed instead. A project stores the attached object
where the node found it, and the node puts the motion back on top.

All the nodes that transform over time are in `motion-nodes.ts`, their faces
in `ui/motion-node-panel.ts`; they are added from the graph's menus like the
others (`graph.addNodeFor` in `editor.ts`), stored in a project's
`motionNodes` (or `transforms`, for align and ground plane) and come back
through `motion.addNode`.

---

## Keyframes on node parameters

Any numeric parameter of a node can now be keyed over time: a key button
beside the field (a diamond: dim when not keyed, outlined when keyed, filled
on a key), and a curve under the row with linear, ease and step between keys.
Transform (position, rotation, scale per axis), crop (centre, size) and both
colour nodes (temperature, saturation, exposure, brightness, black and white
point, transparency) are keyed this way.

Keys are not a node. The PRD's first open question - a property of every
parameter, or a node in the chain - is settled as a property: a keyed node is
still one node, it bypasses, undoes and stores as before, and its keys go
with it. They live on the op (`op.keys`, by parameter id), so undoing the node
takes them and redoing brings them back.

A node does not know it is keyed. What knows is the parameter's description
(`ParamSpec` in `keyframes.ts`): how to read the value from the op and write
it back. A node class opts in once with `keyable(Class, [...specs])`
(`keyframe-params.ts` for the nodes that were there before), and its fields
in the node pane name the parameter (`replayNumber(..., { op, param })`).
The driver (`keyframe-driver.ts`) does the rest: as the timeline moves it
writes each keyed value into its node and replays the node through the
history (`edit.refresh`), so everything after it follows. Replaying a
transform node with nothing after it that places the object would be all
cost and no use, so a class can also say how to show new values in place
(`keyableLive`): the transform node moves the object, the colour nodes write
their palette slots or the object's grade. A crop has no such shortcut; it
re-resolves, which is the price of a moving crop.

A value typed into a keyed field becomes a key on the frame shown, without
the field knowing: the driver remembers what it put into each node and takes
anything else it finds there as an edit. The keys are timeline frames, and
evaluated between frames too - the video export steps the time between
frames, and a keyed move follows it smoothly.

Projects store the keys with the node: transform nodes in `transforms`, the
nodes that select and delete (crop among them) in `nodes`, as
`keys: { id: [[frame, value, interp], ...] }`. A colour node with a selection
is still baked into the object's grades in a project rather than stored as a
node, so its keys are not kept; that is how colour nodes were stored before.

---

## Time nodes and a split node

The graph can now edit time. Five nodes for a 4D model - trim, retime,
loop, freeze frame, time offset - and a split node, the counterpart to
merge, are in the canvas menu ("add ... node") and in the menu shown when
a wire is dropped on nothing.

How time gets to the picture decides how the nodes are built. A 4D model
played on the GPU is one set of gaussians at their temporal centres, with
a velocity and a lifetime each. The timeline's frame reaches the sequence
(`sequence.ts`), which hands it to the model's frame source, which calls
the object; the object passes a normalised time to its sort worker
(`motion-sort.ts`), and the time of the order that comes back is the
`motionTime` the shader moves and fades the gaussians by. So there is one
number per object, and everything that draws or measures the model -
bounds, picking, selection, relighting - already reads it.

A time node therefore changes that number and nothing else. Each is a map
(`time-map.ts`) from a frame of the sequence it leaves to a frame of the
sequence it was given, plus the length of the sequence it leaves. An
object keeps the maps of its applied time nodes in the order of its chain
(`Splat.timeMaps`), and `Splat.showFrame` - the one place the mapping is
applied - sends a timeline frame through them from the last to the first
and shows the model frame that comes out. A node (`TimeOp`) puts its map
on the object when it is applied and takes it off when it is undone or
bypassed, so the mapping without a node is simply the list without its
map, and two nodes compose in graph order because the list is in graph
order. The model's data is never touched: a retimed gaussian is still
drawn where it was trained to be at the model frame shown, and fades as
it did, so there is no second copy of a velocity or a lifetime that could
disagree with the first. A mapped frame may fall between two of the
model's frames (half speed); the model is continuous in time and is drawn
there.

- **Trim** keeps frames in..out. The frames are counted in the sequence
  the node is given, so under a retime they are frames of the retimed
  sequence.
- **Retime** is a speed factor and a reverse switch; the length follows.
- **Loop** repeats the sequence, or plays it there and back that many
  times (ping-pong shows neither end twice in a row, so it joins up with
  itself). "none" passes the sequence through.
- **Freeze frame** shows one frame for the whole timeline: a 4D model
  drawn as a still, its data left as it is. It starts on the frame the
  object is showing.
- **Time offset** starts the sequence later or earlier. Where the
  timeline is outside the sequence the object is hidden or holds its
  nearest frame, as a setting. Hidden is a flag of its own
  (`Splat.timeHidden`), not the object's visibility, which stays the
  user's.

The timeline takes the length of the longest 4D object as its time nodes
leave it, once the history has settled (a replay takes the nodes off and
puts them back, and following every step would strand the playhead). A
shorter object holds its last frame, or is hidden there if a time offset
node on it says so.

All five leave a 3D model untouched and say so in their face: the node is
carried on the chain and does nothing.

The split node (`SplitOp`) makes what the select nodes above it leave
selected into a new object in its own lane. Set to move, the source loses
those gaussians (they are marked deleted, as a delete node would); set to
copy, the source keeps everything. It reads the selection when it
applies, so changing a select node above it changes the split - the new
object stays the same object, for the nodes after it to stand on, and its
data is made again (`Splat.replaceData`). Undo and bypass take the object
out of the scene and give the source its gaussians back. With nothing
selected there is no new object.

The part split off a 4D model is a 4D model: its rows are copied as they
are, each with its velocity, its lifetime and its place in the hierarchy
(`split.ts`), it gets a sort worker of its own, and it starts with the
time nodes its source had at the split. Only the object the sequence
plays was told the frame until now, so every 4D object is now told by the
editor as well (`timeline.frame`, and `timeline.time` for the video
export, which moves the time without moving the frame). A 3D object's
part goes the way a duplicate's does - written out and read back - which
bakes in what the nodes above did to single gaussians.

Traps:

- The 4D export (`.gsv`) writes the sequence's model as it was loaded. It
  ignores time nodes, and it writes the whole source of a split, not the
  parts. To follow them the writer would need the frame range and
  direction applied to each gaussian's temporal centre and velocity
  (trim, retime, offset), a still written for a freeze frame, and a
  model per object; a loop cannot be held by a file that stores one
  lifetime per gaussian and would have to be a flag for the player.
- The video export follows time nodes on the model the sequence plays.
  It waits for the sort of that model only, so a part split off a 4D
  model can be drawn one sort late in an exported frame.
- A project does not store these nodes yet. Each time node says what
  there is to keep (`TimeOp.settings`) and `time.addNode` puts one back
  from that; a split needs its mode and, for a 4D part, which rows of the
  source it holds.
- Two objects are each sorted on their own and drawn one after the other.
  Where the two parts of a split overlap in depth the picture of both is
  not exactly the picture of the whole: on the alley model, 77 dB against
  the whole with a quarter split off at one side, 33 dB with a band out
  of the middle. The rows, their motion and their active sets are the
  model's to the bit either way.
- The part split off a 4D model does not carry colour or transform
  changes made to single gaussians above the split; those live outside
  the rows.
- The graph draws the split's wire from the end of the source's lane,
  like merge's, also when nodes were added to the source after it.

## A project keeps select, crop, cleanup, decimate and delete nodes

Saving a project baked these in: the deleted gaussians were left out of
the object's file and no node came back, so a crop could not be widened
or a cleanup switched off once the project had been closed. Now every
`StateOp` is stored as a node - select (all, none, invert and the select
node with its steps and its mesh input), hide and unhide, the Delete
key's node, the delete node, reset, crop, cleanup and decimate - with its
settings, whether it is bypassed, its place in the chain and, where it
was dragged somewhere in the graph, that place. The object's file holds
every gaussian it came with, each in its row, and the nodes delete.

Each node is stored twice over (`doc-nodes.ts`): as its settings, and as
the set of gaussians it applied to, as `IndexRanges` words in
`nodes_<i>.bin`. Opened, it applies that set again without asking
(`StateOp.restore`) and asks - resolves from its settings - only once
something invalidates it: its own settings edited, or a node ahead of it
changed, bypassed or removed. It is not simply run again, for two
reasons:

- Some nodes have nothing to run. A brush stroke, a flood fill, a
  ring-mode pick and a selection handed in as a mask are frozen hit sets;
  their result is all there is, and it is what is stored. These are the
  nodes that cannot be replayed from settings. Their rows hold now that
  the file keeps every gaussian; before, a frozen set would have pointed
  at other gaussians after a save.
- The rest would be asking different data, or take too long. The file
  holds the gaussians as the whole chain left them, so a sphere select
  from before a move of selected gaussians would catch others now. And a
  cleanup of 1.87M gaussians takes minutes; the project with it opens in
  the time it takes to read the model.

So what opens is exactly what was saved - selection, hidden and deleted
gaussians, bit for bit - and the settings are there for the next edit.
Measured after a reload: bypassing the delete node, and setting the
decimate node to another fraction, give the same gaussians as the same
edit gave before the save.

The nodes go back in in the order they were in. Transform, relight and
debug view nodes used to go in kind by kind, which was their order only
as long as there was one kind; now each stored node carries its place in
the history (`at`) and they are added in that order, state nodes among
them. A debug view node that was switched off is stored too; it was
dropped.

An object keeps its nodes only if they account for its state: applied in
order to an object with nothing selected, hidden or deleted, the stored
sets have to give exactly the state it is in. Where they do not - a node
of a kind `doc-nodes.ts` does not know, one that did not apply - the
object is stored as before: a PLY without its deleted gaussians and
without the nodes, a 4D model with its state file.

Traps:

- Undo still stops at the loaded project (`edit.markLoaded`). A loaded
  node is taken back by bypassing or removing it; what is added after
  opening undoes as usual.
- A project no longer shrinks when gaussians are deleted. The deleted
  ones stay in the file for as long as a node holds them; removing them
  for good is an export.
- A new kind of `StateOp` has to be added to `packSettings` and
  `restoreStateNode`. Until it is, an object with such a node saves the
  old way, silently: its nodes do not come back.
- A node in the redo tail - undone when the project was saved - is not
  stored.
- A node inside a group (a separate's delete, an unhide over several
  objects) comes back as a node of its own.
- A select node feeding a light comes back, but the light is not wired
  to it again: it keeps the emitters it last took, as before.
- Colour nodes are still baked: the object's grade into the object, a
  scoped grade into the colours.

## A project keeps a 4D model as a 4D model

A project stored a 4D model as a PLY of the frame shown. Opened again it
was a still: no motion, every frame the same picture, a dead timeline.
Now the model is stored whole and comes back playing - the same
gaussians in the same rows, the same frame count and frame rate, standing
on the same turn onto the engine's up axis, at the frame it was saved on.

What is stored is the file the model was read from, unchanged:
`splat_<i>.npz` or `splat_<i>.gsv` in the place of `splat_<i>.ply`
(`TghFrameSource.origin` keeps the blob; `doc.ts` copies it into the zip
piece by piece). The lossless GSV writer was the other candidate and
loses on three counts:

- It cannot write every model. One read from a compact GSV is in the
  motion form and holds no 4D rotations, so the f32 writer refuses it,
  and the compact writer would quantise it a second time.
- It puts the rows in another order - block by block, and the static set
  first when that is on. Everything a project keeps per gaussian is by
  row: what is deleted and hidden, the grades on a debug view's false
  colour, a frozen selection. All of it would have to go through that
  permutation, and nothing would say so if one of them did not.
- It has to build the file. The compact encoding clusters on the GPU,
  which is where an earlier save of the 3.3M model lost the device, and
  either encoding holds a second copy of the model while it writes. The
  source file is already there and already the right bytes.

So saving a 4D model encodes nothing and touches no GPU, and the reload
is exact: the 1.87M-gaussian alley checkpoint and the 3.3M-gaussian
compact GSV both render pixel for pixel the same at two frames after a
save and a load (the still came back at 31-35 dB).

Beside the file, in the object's `motion` entry of `document.json`:

- The frame count, because a checkpoint without a timeline has only the
  one the user typed in.
- `splat_<i>.state`, a byte per row: what the model has deleted or
  hidden. The model's file holds every gaussian.
- `splat_<i>.grades`, a palette entry per row: the grades that colour
  nodes scoped to a selection left on the gaussians. A PLY has those
  baked into its colours; the model's file is not rewritten.

Old projects load as they did: an object without `motion` is read from
its PLY. The format's version is 2 now.

Traps:

- The project is as large as the model's file, whatever was deleted from
  it: 299 MB for the alley checkpoint, 60 MB for the compact two-layer
  GSV.
- Opening reads that file out of the zip into memory before the model is
  built from it, so for a moment the model is there twice over.
- A 4D model whose source file is not at hand is stored as before, a
  still of the frame shown. That is a model conditioned per frame on the
  CPU, and a PLY sequence - which is still stored as the one frame.
- Only one 4D model plays at a time (sequence.ts), so a project holds at
  most one.
- A scoped colour node on a 4D model comes back as its colours, not as a
  node, and not at all while a debug view node is applied: that node has
  set the model's own grades aside. A move of selected gaussians is not
  kept on a 4D model either; it too was only ever baked into the PLY.
- A build from before this cannot open a project with a 4D model in it:
  it looks for `splat_<i>.ply`.

## A turning camera no longer waits for the still rows

Orbiting while a 4D model plays gave 17 to 19 fresh orders a second on a
30 fps timeline, where a still camera gave 30. A turn changes the view
direction, and for a new direction the sort worker sorted the still rows
again before it answered: 31 ms of keys and radix passes for the alley's
1.29M on top of the 29 ms a request costs anyway.

The worker does not wait for that any more. A second worker, the helper
(the same code in its other role, joined by a `MessageChannel`), sorts
the still rows for a direction and hands the result over. Until it has,
the worker answers with the still order it holds: the moving rows are
keyed by that order's direction too, so every answer is still one sort
of the whole active set at its own time by one key - by a direction a
little behind the camera's. Such an answer says `exact: false`. When the
camera rests the next answer is by its direction and exact, as before.

The helper is asked for where the camera is turning to, not where it
is: the direction the measured turn reaches in the time one helper sort
and one request take. Without that the order drawn was 3.1 degrees
behind a camera orbiting at 34 degrees a second; with it 1.1.

The merge went from two fingers to a scatter. The helper sends with the
order a table of how many still rows have a key up to k; the worker
counts the moving keys below k. Still row i goes to i + moving keys
below its key, moving row j to j + still rows up to its key. The order
is the same one, ties included; there is no branch to mispredict and
the merge takes 9 ms where it took 14.

Why this and not the others. Sharing the centres between workers by
`SharedArrayBuffer` needs a cross-origin isolated page, and GitHub
Pages cannot send the headers; the buffers here change hands by
transfer instead, each in turn. Fewer key bits or a larger radix gain
nothing: the key arithmetic is the cost, not the passes (measured on
its own: packing the data did not help, fused passes were slower). A
sort on the GPU is not needed to reach the playhead's rate.

Measured in headless Chrome with WebGPU on the RTX 3090 (2017
Threadripper, Chrome at idle priority, other sessions using the GPU at
30 to 60 %), 30 fps timeline, before and after:

| | alley .gsv, 3.30M rows | alley_s2_100.npz, 1.87M rows |
|---|---|---|
| sort results per second, camera still | 29.5 -> 29.8 | 29.9 -> 29.9 |
| the same, camera orbiting | 17.2 -> 35.1 | 18.2 -> 53.3 |
| the same, paused and orbiting | 15.8 -> 21.5 | 18.6 -> 28.0 |
| frames the picture is behind the playhead | 1.2 -> 1.07 | 1.0 -> 0.55 |
| the same, camera orbiting | 2.84 -> 1.46 | 2.72 -> 0.92 |
| one sort in the worker | 29 ms, 57 ms after a turn -> 25 ms, 27 ms | 21 ms, 54 ms -> 13 ms, 16 ms |
| one helper sort (keys + radix) | 46 ms | 34 ms |
| sort direction behind the orbiting camera, mean / max | 1.9 / 2.3 -> 1.1 / 4.5 degrees | 1.9 / 2.8 -> 1.7 / 6.8 degrees |
| main thread per frame asked for | 0.03 -> 0.05 ms | 0.06 -> 0.04 ms |
| requestAnimationFrame rate | 60 -> 60 | 60 -> 60 |

Orders checked at fixed poses, after play and pause, after a delete and
its undo: every one holds exactly the active undeleted rows; no
gaussian that is not faded out comes more than 0.00088 units (alley
.gsv) or 0.00028 (npz) before one it should follow, the figures from
before. A 30-frame video shows frames 0 to 29. The same on WebGL2
(37 results a second orbiting).

To read the rate in the browser: `motionSort.rate` in the console is
the number of orders that arrived in the last second,
`motionSort.exactRate` those by the camera's own direction.

Traps:

- **While the camera turns, almost no order is exact.** The worst
  direction error measured is 6.8 degrees for one result, at 34 degrees
  a second. The old worker's was 2.8, at half the rate. A faster turn
  is further behind; the prediction is capped at 0.15 rad.
- **`'updated'` fires only for an exact order of the newest request.**
  The export waits on it, so a frame with a moved camera takes a
  provisional and an exact answer. Under `1 << 17` still rows there is
  no helper round trip: the worker sorts them itself, as before.
- **Paused and turning is bound by the helper**, not by the worker: a
  new order needs a new still order, one per 34 to 46 ms.
- **Two workers per 4D model**, and the still rows twice: about 55 MB
  more for the alley.
- **The messages of the worker changed, the class did not.** New in a
  result: `exact`, `direction`, `times`, `stillTimes`, `posted`. New
  from the worker: `{id, t, same: true, exact: false}` (the order
  would be the one already sent; none comes) and `{again: id}` (the
  still order owed is in; ask again). New to the worker: `helper` (a
  port, with the model), `serve` (a port, makes it the helper), `at`
  in a request (when it was sent, for the turn). `MotionSorter` has
  the constructor and methods it had.

## 360 exports are no longer empty on WebGPU

A 360 image or video came out black - fully transparent, in fact, alpha 0
in every pixel - on WebGPU, which is the default, in headless and in
windowed Chrome alike. The camera was not inside anything and the sort was
waited for: read back one by one, all six cube faces were rendered and lit
(4.5 to 14.3 % of their pixels on the test model). What never ran was the
pass that projects them to the panorama.

Its fragment shader sampled each face inside `if (w > 0.0) { ... }` with
`texture2D`. WGSL forbids implicit-derivative sampling in non-uniform
control flow; the GLSL transpiles without complaint, pipeline creation
then fails without a word, and the quad is not drawn. It is the trap
`lens-shader.ts` already describes, and the cure is the same:
`texture2DLod(..., 0.0)`, which needs no derivatives. The faces have no
mips, so nothing else changes, and WebGL2 takes the same source.

Measured on every 40th gaussian of `mira_alley_2layer.npz`, 1024 x 512,
frame 120: the 360 still went from 2,112 bytes of nothing to 8.6 % lit
pixels, the 360 video (12 frames, h264) from 3,385 bytes to 72,102 with
8.4 % lit; the same numbers in headless and in a windowed, minimised
Chrome. On WebGL2 (`?device=webgl2`) the still has 8.4 % lit, as it should:
that path never failed.

---

## Compact GSV: a gaussian at rest is stored at rest

The compact encoding stores a velocity as a 16-bit code between the page's
`velMins` and `velMaxs`, and zero fell between two codes: a gaussian with a
velocity of exactly zero read back with about 2.5e-5 per axis. Small, but
it is the difference between "stands still" and "moves slowly", and three
things ask exactly that. The debug view's static channel showed the
background as dynamic, the writer's static rule found no static rows in a
file written all-dynamic and read back, and the 4D sort needed a tolerance.

The writer now widens each axis's range until zero is one of its codes
(`zeroOnCode` in `gsv-webp.ts`). Zero moves to the code above by lowering
the minimum or to the code below by raising the maximum, whichever grows
the step less; that is never more than one step of range in all. Keeping
to one end, the obvious rule, is not: with zero near the other end it
widened the range by thousands of steps in a test of two million ranges.
The reader computes `min + (max - min) * q / 65535` and was not to change,
so the last rounding error is taken out against exactly that expression -
`e^x - 1` of a last-place error is not zero. A range with zero at an end,
to one side of zero or of no width is left alone.

The format and the reader are unchanged; files written before this still
read as they did, with the half step at rest. The rule is in the spec
(`docs/format-gsv.md`, 7.2) as a SHOULD for writers.

Measured on every 40th gaussian of `mira_alley_2layer.npz` (82,391, in
headless Chrome): the file written all-dynamic and read back has 32,334
rows with a velocity of exactly zero, where it had none; written again
with the static set on, its static page holds 32,334 rows, the same as
when the set is picked from the source. Other velocities are off by at
most 0.5 step, as before. Two million random ranges in a node script: zero
exact in all of them, the range never more than one step wider.

---

## Transform and delete nodes

Two nodes that only ever appeared as the trace of something done in the
viewport can now be put in from the graph: "add transform node" and "add
delete node" in the canvas menu, "transform" and "delete" when a wire is
dropped on nothing.

The transform node (`TransformNodeOp`) is not the one a gizmo drag leaves.
That one, `EntityTransformOp`, says where the object ends up, which is all
a drag knows. Added empty it would have to hold the placement the object
already had, and two of them would not add up: the later one wins. The
new node says what is done to the object instead - a move, a turn and a
scale about the scene's origin, in the scene's axes - and applies it on
top of wherever the object stands. So it starts as nothing, several of
them compose in the order of the chain, and bypassing or removing one
leaves the object where the others put it. It also keeps what the object
came with: a 4D model stands on a turn of its own (-90 about X for a z-up
capture, 180 about Z otherwise), and that turn is the object's rotation
like any other.

The node's face is the one the gizmo's node already had - position,
rotation in degrees, scale - with a reset. The angles are kept as typed;
read back out of the quaternion, 200 would come back as -160. While a
field is dragged or typed in the object follows at once, and the replay
that everything after the node needs comes when the number settles. That
shortcut is only taken while nothing later in the chain places the object
too.

The delete node (`DeleteNodeOp`) removes the gaussians the select nodes
above it leave selected, or, set to "unselected", all the others. It takes
its selection the way a colour node scoped to a selection does: it reads
the selected bit when it applies, not when it was made, so changing a
select node above it changes what is deleted. It is a `StateOp` like crop
and cleanup, which is what gives it undo, bypass and, on a 4D model, the
message to the sort worker. Its face shows how many it removed.

A project keeps transform nodes as nodes. The object is stored where it
stands without them (`TransformNodeOp.baseOf`) and they go back on top
when it is opened. A delete node is stored the way crop, cleanup and the
Delete key are: the gaussians are gone from the saved data and no node
comes back.

Fixed on the way: undoing a gizmo move of an object did nothing.
`EntityTransformOp.do` read where the object stood as the place to go back
to, and on the first application the gizmo had already moved it there.

Traps:

- An uneven scale in a transform node, over an object turned by something
  other than quarter turns, would shear it. An object's placement cannot
  hold a shear; the nearest placement without one is used. For the same
  reason a project cannot always store such an object under its nodes -
  then it is stored as it stands and its transform nodes are not kept.
- A gizmo drag after a transform node still says where the object ends up.
  Changing or bypassing the transform node above it then changes nothing
  that shows, until the gizmo's node is bypassed or removed.
- With nothing selected the delete node removes nothing, also when set to
  "unselected": the rest of nothing is the whole object, and a node just
  added should not empty it.
- Hidden gaussians are neither selected nor unselected. Neither setting
  removes them.
- "Unselected" on a 4D model removes every unselected gaussian of the
  whole sequence, not only those alive at the frame shown.
- The move gizmo is not put back where the object went when a transform
  node's numbers change. Picking the tool again places it.

## A debug view's colour is the object's colour from its node on

A colour node after a debug view node did nothing to the false colours,
and no output wrote them: the view skipped the grades in the shader and
the writers never heard of it. Now the node has a place in the object's
colour chain. From it on the false colour is the object's colour. Colour
nodes after it grade it - the object's grade and a grade on a selection
alike - and an output node after it writes it. Colour nodes and outputs
before it grade and write the object's own colour, as before.

How the order is kept. An object has two places a colour node writes to:
its own grade (eight numbers, the last node to set them wins) and a grade
slot per gaussian, which nodes on a selection compose into. Neither says
where in the chain a grade was put on. So the debug view node, when it
applies, sets both aside (`view.stash`: the eight numbers and a copy of
the slots) and leaves the object with none, and hands them back when it
is undone or bypassed (`Splat.addDebugView`, `removeDebugView`). History
applies and reverses in order, so what is on the object while the node is
applied is exactly what was put on after it. The shader then grades the
false colour with `applyGrade` like any colour, and the writers read the
same two places they always read; there is no second chain. A node on a
channel the object does not have takes nothing, and the object goes on
drawing its own colour with its own grades.

What is on the false colour: the grades after the node, then the camera
node's exposure, then the tone map. Not the grades before the node, their
transparency included - the opacity under a debug view is the stored one,
as it was. Not the relit light: the relighter works from the object's own
colour.

Written out. `SingleSplat` puts the false colour in the DC term and
writes no bands above it (a false colour is the same from every side),
then applies the grades and their alpha the way it does for any colour.
That one path is PLY, compressed PLY, .splat, SOG, SPZ, the viewer
export, publish, merge and duplicate/separate - so an object merged or
separated after a debug view node carries the false colours as its own.
An image or video render shows the view because it is the viewport's
shader. The project file and a training seed ask for the object's own
colour (`ownColor`, implied by `keepColorTint`) and get it with the
grades the node set aside; the histogram and select-by-range count it
too (`Splat.ownGrade`).

4D. A GSV is written from the model, not from the object, and so far saw
no node at all. With a debug view on the model it now takes the false
colours, with the grades on them, in the place of the model's DC, and no
rest coefficients (`writeGsv`'s `colour`, from `bakeDebugColor`). Every
channel but one is of the gaussian and holds for the whole sequence. The
fade is of the time shown: a file that plays cannot hold it, so a GSV
export on that channel is refused with a message, and a 3D file gets it
as of the frame shown.

One mapping. The channel -> colour function was written inline in both
shader dialects; it is now `debugColor` in `splat-debug.ts`, as GLSL and
WGSL text and as `debugColorSource` for the CPU, the three side by side
with the mode numbers and ramp stops shared. The ramp stops go into the
shader with nine figures instead of four, so both sides work with the
same numbers. The writers resolve the channel again (`resolveDebugView`),
which gives the same range and the same bytes as the texture got.

In a project. The object's file and properties hold its own colour and
grade. The grades on the false colour are stored with the last debug
view node of the object: the eight numbers, and per gaussian an entry
into a short list of grades (`debug_grade_<i>.bin`, a row per row of the
object's file). They go back on once the node is applied. A project
keeps no colour nodes, so after loading no node holds these grades; the
debug view node keeps them itself while it is bypassed (`view.kept`).

Measured in headless Chrome, WebGPU, RTX 3090, 640x360, the viewport
with the debug view and a colour node after it (exposure 0.7, saturation
1.26, temperature 0.17, brightness 0.03, black 0.02, white 0.9, a tint)
against the written file read back and drawn from the same camera:

| | PSNR | largest difference of a channel, of 255 |
|---|---|---|
| 3D, 702k gaussians, PLY: opacity / size / anisotropy / SH | 66.4 / 66.9 / 65.3 / 66.7 dB | 1 |
| 4D, 702k rows, lossless GSV, frame 40: velocity / speed / time / lifetime / level / static / size | 75.6 / 68.9 / 69.2 / 70.0 / 67.0 / 68.6 / 70.6 dB | 1 |
| WebGL2: 3D size, 4D velocity, 4D lifetime | 67.1 / 75.6 / 69.1 dB | 1 |

(Velocity was graded with three stops of exposure alone; ungraded it is
mostly black.) The
fade written into a PLY at frame 40 agreed with exp(-dt^2 falloff)
through the ramp to 2e-8 over the first 20,000 rows, and the GSV export
on that channel wrote nothing. An output node before the debug view
wrote the same bytes with the debug view and colour node applied after
it as without them. Undoing the nodes, and bypassing the debug view,
gave back the first picture exactly, and so did a colour node before the
debug view changed under it: the own colour moved, the false colour did
not. A project with a colour node before the debug view, one after it
and one on a selection after it drew the same picture after loading,
pixel for pixel, and its own colour again with the node bypassed.

Not measured: the compact (webp) GSV with false colours. The full-size
compact export loses the WebGPU device in headless Chrome, as it did
before this change.

Traps:

- The legend shows the ramp before any colour node. Graded, the colours
  on screen are no longer the legend's.
- An object's own grade is one setting, and the last colour node to set
  it wins. A colour node added after a debug view starts from none, not
  from the grade the object had.
- The colour panel shows the object's grade as it stands, which under a
  debug view is the false colour's. A change made with a colour node
  from before the debug view open goes to that node - only what was
  changed, the rest of the node stays (`edit.addColour`).
- A node that showed nothing and is switched to a channel the object has
  (or the other way) takes or gives up its place in the chain, so that
  switch replays the history from the node; any other channel switch is
  still a uniform.
- With two debug view nodes on one object, a project keeps the grades
  put on after the last. Those between the two are lost on saving.
- A project holds a 4D model as its rest frame, so a motion channel
  shows nothing after loading and the grades stored with the node are
  not applied.

## 4D models are sorted in a worker of their own

Playing a large 4D model updated the picture five to eight times a
second. Each frame the main thread rebuilt the centres of every active
gaussian (34 ms at 1.9M, more than a frame has) and handed them to the
engine's sort worker, which sorted all of them again - the background
included, which is two thirds of the alley capture and never moves.

The model's splat now has its own sort worker (`src/motion-sort.ts`) in
the place of the engine's. It holds the model: centres at the temporal
centres, velocities, and the hierarchy's blocks. A request is a time and
a camera; the worker works out the active set and the centres itself, so
a frame costs the main thread one message. It splits the set in two. The
rows that stand still and are in every active set (global level) are
sorted once per view direction and kept. The rows that move are sorted
per request. Both runs are sorted by the same key, and merged by it, so
the order drawn is what one sort of everything by that key gives - not a
background layer with the moving part on top.

For that the key function has to be the same at every time, which the
engine's is not: it spreads its buckets by where this frame's centres
are dense. Here the density comes from the rows at their temporal
centres, the depth range from everywhere a row can be while it is drawn
(the ends of its segment and of its fade), and an eighth of the buckets
is spread evenly. A row outside that range is one the shader has faded
out; its key is clamped.

The sort itself is two passes over 1024 buckets instead of the engine's
one pass over a million. That one misses the cache on every row, which
was most of its time: with every row moving the new worker still sorts
1.93M rows in 54 ms where the old round trip took 135.

Each result carries the time it was sorted at. The shader gets that
time when the order arrives (`Splat.shaderTime`), which keeps the rule
that an order is only drawn at its own time, and replaces the check
that guessed from the rows in an order whether it was the awaited one
(`checkMotionSort`, its four-result backstop, the queue). One request
is out at a time; a newer time or camera replaces the one waiting.

Measured in headless Chrome with WebGPU on the RTX 3090 (the CPU is a
2017 Threadripper, Chrome at idle priority), 30 fps timeline, before
and after:

| | alley .gsv, 3.30M rows | alley_s2_100.npz, 1.87M rows |
|---|---|---|
| still / moving rows of the active set | 1.29M / 0.63M | 1.31M / 0.22M |
| main thread per frame asked for | 3.7 ms, 34 ms when a sort went out -> 0.02 ms | 2.8 ms, 30 ms -> 0.03 ms |
| sort results per second, camera still | 7.4 -> 29.9 | 8.6 -> 29.8 |
| the same, camera orbiting | 11.6 -> 20 | 11.4 -> 23 |
| frames the picture is behind the playhead | 6.3 -> 1.0 | 5.6 -> 0.6 |
| the same, camera orbiting | 8.0 -> 2.5 | 8.1 -> 2.2 |
| requestAnimationFrame rate | 51 -> 60 | 51 -> 60 |
| one sort in the worker | 22 ms, 48 ms after a turn | 18 ms, 42 ms after a turn |

Traps:

- **Still is not zero velocity.** The alley's background has a speed of
  2.5e-5 on every row: the nearest value to zero its file's quantiser
  has. Asking for zero found no still row at all. A global row counts as
  still when everywhere it is drawn it stays within one key of where it
  is at its temporal centre, a key being a 2^20th of the scene's box
  diagonal (0.00017 of the alley's 175 units). It is sorted where its
  temporal centre is. So the order is not exactly a sort of the true
  centres: it can differ between rows closer than that in depth. With
  every velocity exactly zero or above the threshold it is exact.
- **The picture is not pixel-identical to the old sort's**, and cannot
  be: both sorts are bucket sorts and the buckets differ. At six fixed
  times and cameras, 960x540: 0.15 to 0.3 % of the pixels differ, by 28
  of 255 at most, 67 to 75 dB. Against the true centres the new order
  is the closer one: on the alley no gaussian that is not faded out
  comes more than 0.0009 units before one it should follow, where the
  engine's order had 0.011.
- **An order is as large as the order texture, not as the row count.**
  WebGL2 uploads it as the whole texture; one entry per row drew
  nothing there. WebGPU did not mind.
- **The sorter's `updated` fires only for the newest request.** A
  result overtaken by a newer request still draws, but the video export
  waits on `updated` for the sort of the frame it just set, and must
  not get an older one arriving late.
- **The sorter learns the camera from the instance, which tells it only
  while the model is drawn.** No camera, no sort; no sort, no frame.
  Replacing the sorter therefore forces a frame.
- `Splat.motionTime` is the time asked for. `Splat.motionActive` is
  worked out when read - playback never reads it - and `activeAt` must
  hand back the same array while the set is the same: the relighter and
  `MotionCenters` tell a change of set by it.
- The worker has its own copy of the model, 36 bytes a row, and of the
  state bytes once something is deleted.

Checked on both files: every order holds exactly the active, undeleted
rows, and draws exactly those in front of the camera, at six times and
cameras, after play and pause, after deleting a fifth, after playing
with them deleted and after undo. Play, pause, scrub and the loop's
wrap end on the playhead's frame. A 30-frame export has 30 frames
(ffprobe), each rendered at its own time. On the .gsv alone: the order
after a transform's centre update, relighting following the frame, the
debug view, the worker ending with its splat, a plain PLY and its
deletions on the engine's sorter, and WebGL2, which gives the same
numbers.

Not done: with the camera turning, the still rows are sorted again for
every result, and that is where the 20 per second comes from. The
360 export of this model is black in headless Chrome, before this
change as after; not looked into. A relit 4D model still rebuilds its
grid on the main thread at every frame change (250 ms at 3.3M rows).

## Playback of 4D models no longer fades out

Pressing play on a GPU-played 4D model made it fade away, and pausing
brought it back. The shader's time only moves once a depth sort of the
new active set has arrived (`Splat.checkMotionSort`), so that no gaussian
is drawn outside the segment it was trained in. During playback the set
changes every frame and a sort of a large model takes several, so the
sorts arriving were always of an older set than the one being waited
for: the time never moved, while the sets drawn moved on and faded
against it.

One set is in flight at a time now. A frame asked for while a sort is
awaited is queued, the latest one winning, and goes out when that sort
is in (`Splat.releaseMotion`). What is drawn is always one set at its
own time. It runs behind the playhead by the sort time - five to seven
frames at 30 fps on a 1.9M-gaussian model in a throttled headless
browser - and frames in between are skipped.

## GSV static pages

The reader and writer handle the static set of the format (plain 3D
gaussians, `kind: "static"`, both encodings).

A TGH model has no static set, only global gaussians that happen to
stand still. The writer moves a global gaussian to the static page when
it drifts by less than a thousandth of its thinnest extent over the
sequence and its lifetime falloff stays above `1 - 1/510`
(`standsStill` in `tgh/gsv.ts`); the falloff there is, averaged over the
sequence, is folded into its opacity. What is written is its conditional
3D covariance, which is what was drawn all along. `staticSet: false`
keeps everything dynamic.

The reader brings a static page back as global gaussians with zero
velocity, temporal centre 0.5 and a temporal std of 1e4, first in the
model: the falloff is 1 to float precision, so the model code needs no
static case. For the f32 form the 3D rotation `(w, x, y, z)` becomes the
pair `l = (w, z, -y, x)`, `r = (w, z, -y, -x)`, whose 4D rotation leaves
the time axis alone. Read back and written again, the static set
survives unchanged.

Measured on the two-layer alley capture (2.0M dynamic + 1.29M static):
the writer picks out exactly the 1,293,354 background gaussians; after
an f32 round trip positions and colours are identical, covariances agree
to 8e-8 and alpha to 0.0008 (the folded falloff). The webp form was
checked on a 1/40 subsample only (51.5 dB against the source, the usual
palette loss): the full-size compact export lost the WebGPU device in
headless Chrome, with or without a static set.

The k-means dispatch budget went from 2e10 to 4e9 multiply-adds: at the
measured 2.5e10 per second a dispatch took 0.8 s, near the 2 s driver
timeout. That did not cure the device loss.

## Debug view node

A node on an object's chain that draws its gaussians false-coloured by one
channel of their data instead of by their colour (`DebugViewOp`, added
from the graph's add menu or by dragging out of a node: "debug view"). It
is a way of looking, not an edit: the node hands the object its view while
it is applied and takes it back when undone or bypassed, and nothing in
the data changes - so exports, the splat data saved in a project,
training and relighting are as if it were not there. The node itself is
saved with the project, the way relight nodes are.

Channels. On a 4D model played on the GPU: velocity per axis (|xyz| as rgb,
black at rest), speed (heat, log), temporal centre (0..1), lifetime (the
temporal std, log), the fade at the time shown, hierarchy level, and
static against dynamic. On any object: opacity, size (largest scale,
log), anisotropy (largest over smallest scale, log) and SH view
dependence (energy of the rest coefficients against the DC colour). A
channel the object does not have is not offered.

Where the value comes from decides what a switch costs. Velocity,
temporal centre and falloff are already in the motion textures the vertex
shader plays from, and opacity is in the splat's own, so those are worked
out in the shader and a uniform (`debugMode`) names the channel: no
upload. Level, the static flag, the scale ratios and the SH energy are
only on the CPU; they go up as one byte per gaussian, already normalised,
when a node asks for one (`splatDebug`, R8), and the texture goes when the
node does. `SPLAT_DEBUG` is a define, so an object without a debug node
compiles none of it.

The ramps and the category colours are defined once, in
`splat-debug.ts`. The GLSL and WGSL are generated from them and the
legend's CSS gradient is drawn from them, both interpolating in sRGB, so
the legend is the ramp on screen and cannot drift from it.

Ranges are measured once, when the channel or the data changes, not per
frame. They are the values with half a percent trimmed off each end,
from a sample: a few floaters would otherwise set the range and leave
the rest of the object one colour. The legend shows those ends; values
beyond them clamp. Lifetime is capped at ten sequence lengths, past
which nothing reads differently.

Static uses the GSV writer's rule and not a copy of it: `standsStill` in
`tgh/gsv.ts`, over the same `STATIC_MAX_DRIFT` and `STATIC_MIN_FALLOFF`,
asked of global gaussians only, as the writer does. What the view calls
static is what an export would move to the static page.

The colour replaces the splat's before the tone map. The grades, relit
light and camera exposure are skipped, since each would change what a
legend colour means; alpha, the fade and the shape are kept, so the view
still shows where things are, and the selection tint and outlines land on
top as before. Several debug nodes on one object: the last applied wins,
and the others' faces say so.

Traps:

- A tone mapping other than linear bends the debug colours like any
  others. Set it to linear to read them against the legend.
- Velocity direction is in the model's own axes, before the object's
  transform.
- The view is what the viewport draws, so an image or video render shows
  it too. Bypass the node first.
- A PLY sequence swaps its data every frame, so a texture channel is
  measured and uploaded again per frame there. A 4D model is not: its
  data does not change with time.
- Changing the channel is not an undo step, like a relight node's
  settings. Adding, removing and bypassing the node are.

## Camera poses in the browser

Photos or a video dropped into VoluLab get their camera poses without
any helper now. COLMAP itself runs in the page: the colmap-wasm package
(BSD-3, COLMAP 4.2.1 compiled to WebAssembly - SIFT, geometric
verification, view-graph calibration and the global mapper, with SIFT
matching on WebGPU). The stages stream onto the import node as before,
and the result is a COLMAP binary model (`sparse/0/*.bin`) packed with
the images, which the dataset reader already accepts.

The order is browser, then the bridge, then the COLMAP kit for a manual
run. The browser path needs WebGPU; when it fails and the bridge is
running, the bridge gets a go (`training/bridge-ingest.ts`).

Like Brush, the package is not bundled. Rollup copies it to
`static/colmap-wasm` and it is imported from a computed URL, so its
worker and wasm resolve beside it through `import.meta.url`. About 7 MB
(2 MB gzipped), loaded only when poses are needed. No cross-origin
isolation is needed.

Measured on Mira (20 synthetic views at 1024 px, known poses), in
headless Chrome: 19 of 20 cameras registered in 53 s (features 36 s,
matching 0.7 s, mapping 16 s). After a similarity alignment, positions
are within 6 mm on average (13 mm worst) at 3.2 m, rotations within
0.15 degrees, and the focal length within 0.3 %. Through the import path
the whole run, packing included, took 39 s.

Traps:

- **One shared camera.** The package fits a single SIMPLE_PINHOLE camera
  to all images, so photos of different sizes or from different lenses
  fail or come out wrong; they fall back to the bridge when it runs.
- **No WebGPU, no browser path.** Matching runs on WebGPU only; such
  browsers keep the bridge or the kit.
- **Embedded browser panes may lack WebGPU**; test in
  real Chrome.

---

## TGH models play on the GPU

A TGH model (`.npz` or `.gsv`) used to play by conditioning every frame on
the CPU and rebuilding the whole splat from it - about a second per frame
at a million gaussians, on the main thread, so playback stuttered at one
or two frames a second. Now the model is uploaded once, each gaussian at
its own temporal centre in motion form, with two extra textures: velocity
and temporal centre (RGBA32F), and the falloff 1 / (2 sigma_t^2) (R32F).
The vertex shader (`SPLAT_MOTION`) moves each gaussian by
velocity * (t - centre) and fades it by exp(-falloff * dt^2); a frame
change only sets `motionTime`.

The CPU still owes the depth sort its centres. Per frame `Splat.sortMotion`
computes the active gaussians' centres at t and posts them, with a mapping,
straight to the engine's sort worker - the mapping both orders and limits
what is drawn, which is how TGH's active segments are honoured. The engine's
own `setMapping` cannot be used: it takes centres from its private copy,
which here are the temporal centres. The mapping is kept until the active
set (a segment boundary) or the deletions change. On flame_salmon a frame
step costs ~22 ms on the main thread (was ~1 s), and the frames match the
CPU-conditioned ones to 58-63 dB (the difference is sort order).

`TghFrameSource` takes a `gpu` flag (default on); off, it is the old
per-frame path. Known gaps: anything that reads the splat data rather than
the shader - exporting the current frame, selection by position, the
centres overlay - sees the gaussians at their temporal centres, not at the
shown time.

## GSV's compact encoding

The export menu's "Gaussian Splat Video" now writes the compact WebP
encoding; "lossless" keeps f32. A compact `.gsv` opens like any other.

The primitives are stored in motion form, not as 4D gaussians. A
conditioned 4D gaussian is a 3D gaussian of fixed shape moving at constant
velocity - the conditional covariance does not depend on t - so each is
written as that: SOG's layout for the 3D part (16-bit log-transformed
positions, 256-entry scale codebook, smallest-three rotation, SH palette),
plus 16-bit time and velocity and a temporal-scale codebook of its own.

The first version quantised the 4D form, and it failed in a way worth
remembering. On flame_salmon a few dozen visible gaussians jumped by up to
109 units in a scene some 300 across: they were strongly elongated (log
scales 4.3 against -20.7), and an 8-bit rotation error of under a degree
tipped the long spatial axis into time, which conditioning reads as a
velocity. In motion form the same capture's visible gaussians move by
0.00075 on average and 0.14 at most, none by more than one unit.

Measured on flame_salmon (1.47M primitives, 300 frames): 32 MB, against
383 MB in f32 and 256 MB for the checkpoint's `.npz`; 165 s to encode,
nearly all of it k-means. The SH palette (65 536 centroids over 45
dimensions) is clustered on the GPU, so the compact export needs WebGPU,
as SOG's does. Open: a handful of primitives change opacity a lot at some
instants, from the 8-bit temporal scale (docs/format-gsv.md, section 13).

`TghModel` holds either form now; conditioning the 4D form is unchanged
and still passes the parity check against the training code.

---

## A TGH model written out as a Gaussian Splat Video

A loaded TGH model can now be exported whole, as a `.gsv` in the lossless
f32 encoding of the draft format (docs/format-gsv.md), and a `.gsv` opens
like an `.npz`. Export is in the export menu, enabled while a TGH sequence
is playing; it writes the model, not the frame on screen.

The rows go out block by block in the order `activeIndices` concatenates
them - the global set, then each level's segments ascending - so a model
read back conditions every frame into the same gaussians in the same
order. Blocks are grouped into pages by windows of the coarsest level.

Verified headless: the parity fixture and flame_salmon (1.47M primitives,
300 frames) round-trip with every column of every conditioned frame
bit-identical, at six times including 0 and 1. flame_salmon writes in
about 2 s. The f32 file is larger than the `.npz` (383 MB against 256 MB),
since numpy's archive is deflated and f32 is stored raw on purpose; the
compact WebP encoding is the one meant for delivery, and is still to come.

The hand-written zip writer moved out of the dataset packer into
`io/write/stored-zip.ts`, which both now use.

---

## SuperSplat fixes taken over

Five upstream changes were looked at; three came over, adapted where
VoluLab has diverged.

- playcanvas/supersplat#1027 - picks that land after another click, a data
  panel querying a removed splat, tooltips on destroyed targets.
- playcanvas/supersplat#1032 - selection left on a deleted splat, pointer
  capture errors and cancelled touches in the drag tools, rect picks past
  the canvas edge, a gzip write that stalled instead of failing. The
  queued paint select and the eyedropper got the same guards.
- playcanvas/supersplat#1063 - the export dialog's band count is now the
  count written, missing bands padded with zeros, defaulting to the
  scene's own. A new `shBands` setting does it; `maxSHBands` stays, since
  export nodes and saved projects store it.

Left out: #1038 and #1053. Both fix SuperSplat's lazy, streamed loading,
which VoluLab does not have - it reads a file whole, so nothing is left
reading from it.

splat-transform went from 3.1.7 to 3.10.1 (3.10.2 was two days old). Its
chunk metadata now needs a `model`, and the WebP decoder's wasm must
match the JS bundled from it: the copy in static/lib was stale and
differed, so the build now takes the wasm from the installed package.
Verified headless: a PLY and a SOG written by the new CLI load, and
merging them gives 6000 gaussians.

---

## Training snapshots read the trainer's buffers

An interim snapshot of a run used to ask the trainer for a PLY and parse
it back. It now copies the trainer's buffers - packed transforms, raw
opacities, SH coefficients - to the CPU and builds splat data from them
directly (`BrushEngine.readSplats`). The first snapshot still goes through
a PLY, since it creates the object and fixes its transform; the final one
too, since it takes the morton reorder.

Two traps. The packed rotation is wxyz, whatever the package's typings
say. And training leaves quaternions unnormalised while the PLY export
normalises them, so the readback does too. Checked against the trainer's
own export: every column within 0.05, where two reads a moment apart
already drift by 0.018.

Fixed alongside: the final snapshot was dropped when an interim one was
still in flight, leaving the run's output stale and unsorted. It waits for
it now. Verified headless: a 300-step run reaches done with 12 direct
snapshots and both PLY ones.

---

## One GPU device for the viewport and the trainer

The trainer asked the adapter for a device of its own, beside the
viewport's. It takes the viewport's now, when the viewport runs on WebGPU
and its device has subgroups - which it does wherever training could run,
since the engine asks for subgroups and every adapter limit when it makes
one. A browser where it does not falls back to a device of the trainer's
own, as before; the run's log says which it got.

One device is the prerequisite for drawing the trainer's buffers in the
viewport without a copy, and it stops the two holding GPU memory apart.
The trainer's host-side patches - the subgroups directive, a clean error
scope read as absent - now see the engine's work too; both only touch what
they were written for. Verified headless: a run and a seeded run on the
shared device both train to "done", and the viewport draws throughout.

## Decimate per region

The decimate node ranks overall by default: keep the most important 20%,
wherever they are. Opacity times volume runs high on large blobs, so the
budget piles up where they are and thins everything else out - on
flame_salmon at 20%, regions kept anywhere from 5% to 65% of what they had.

"Rank per region" splits the object into blocks - sixteen along its
longest side, over a box trimmed of its outer half percent - and each
block keeps its own share, ranked within itself. Shares are rounded by
largest remainder, so the total kept is still exactly the fraction asked
for. The same capture then keeps between 14% and 24% everywhere. It is the
quota half of SplatQ (arXiv 2610.13503); its annealed selection is not
needed for this. Off by default, so existing nodes keep their results.

On a TGH sequence, the blocks follow where the gaussians are on each
frame, so a gaussian crossing a block border can change sides near it;
overall ranking is the steadier choice for sequences.

## Voxels as one surface, in their colours

Voxels were drawn as a box entity per filled cell - and, it turned out, all
of them black. The cells were unlit standard materials coloured through
`diffuse`, and unlit, the standard material shows only its emissive. A
reference box built the old way next to the new mesh came out black too.

They are one mesh now: only the faces of filled cells that border an empty
one, since a face between two filled cells can never be seen, each with its
cell's colour as a vertex colour, through `emissive`. One draw call, the
engine's own material, no shader of ours, the same on both backends. An
8x8x8 block builds its 384 outer faces and none of the 2,688 inside it;
cloud.ply voxelised at 32 keeps 1,990 of its cells' 2,760 faces. The
colours land exactly: a cell of (0.5, 0.25, 0.75) reads back as
(128, 64, 191).

Instancing was the plan, and turned out to be the longer way: it needs a
vertex format and a shader of ours, and still draws every hidden face.
The surface is also what a mesh export of voxels would write.

## Nodes reorder

A node's context menu moves it up or down its object's chain - a cleanup
before a decimate rather than after, say. The chain is history order, so
this moves the op in the history: wound back to the earlier of the two
places, the line reordered, and forward again, with everything the moved
ops reach resolving again in the new order. History stops being
append-only here, and goes through the same wind-back as every other
structural change for that reason - each op is reversed while it still
remembers what it did.

A node cannot move above the node that makes its input, nor below one that
takes its output: a decimate on a merge's result stays below the merge.
That test is the footprints from the change below, which is why the two
came in this order. Verified headless: cleanup moved above decimate gives
byte for byte what the same two built in that order give, the move past a
merge is refused, and winding the history to the start and back again
lands on the same state.

## Replay asks again only what a change reaches

Changing a node - its parameters, bypassing it, removing it - winds the
history back to it and forward again, and every resolving node after it
used to forget its answer and resolve again. A grade tweaked on one object
re-ran a cleanup on another: a minute, on a million gaussians.

Now the history works out what the change reaches. Each node has a
footprint: what it reads - its object, what is wired into it - and what it
writes - its object, what it makes, the objects it consumes. Walking
forward from the change, a node that touches anything reached is reached
itself, and adds what it writes, so a select node feeding a light, or an
object feeding a merge or a seed, carries the change on. Nodes it does not
reach keep their answers: they would ask the same question of the same
data.

- **Doubt goes toward asking again.** A node whose footprint is unknown
  is taken to reach everything after it, since a wrong answer here corrupts
  state quietly instead of throwing.
- **Still wound through.** Every later node is still undone and redone,
  because history is one line; redoing a resolved node replays its stored
  set, which is cheap.
- **Verified** headless: two objects, decimate and cleanup on one,
  decimate twice on the other; changing the other's first decimate
  resolved only its own two nodes, and the result was identical, byte for
  byte, to winding everything back, forgetting every answer and applying
  it all again.
- A frame swap still resolves everything (`reapplyAll`): the data under
  every node has changed.

## Cleanup off the main thread

The cleanup node's outlier search ran inside its resolver, on the main
thread: at a million gaussians, the editor stopped for as long as the
search took. It runs in a worker now. While flame_salmon's million were
judged, the longest gap between two frames was 29 ms.

The worker is built from the search function's own source, turned into a
blob URL, so it needs no second bundle and no change to the build - which
is why `findOutliers` in `cleanup-worker.ts` must stay self-contained,
reading nothing from its module. Positions and the live mask are copied
across, so the splat's arrays stay free for drawing. If a worker cannot be
made, or dies, the same function runs on the main thread as before.

The search itself changed too, in two ways, and the second changes
results.

- **The grid fits the capture.** Its cell was sized from the bounding box,
  which the floaters stretch - flame_salmon's runs from -775 to 1002 -
  and a capture is surfaces in mostly empty space anyway, so the cells
  holding anything held hundreds of points and the search went
  quadratic. The box is now trimmed half a percent off each end of each
  axis, and the cell refined against how full the cells really are as a
  point sees them (the sum of each cell's count squared, over the
  points), down to the finest the arrays can hold. Buckets are a counting
  sort into typed arrays, and the k nearest are kept sorted as they
  arrive instead of sorting every candidate.
- **The k nearest are exact.** The old search took what lay in a block of
  up to four cells round a point, so its answer moved with the cell size
  - which is how it showed: four sizings of the same frame deleted
  anywhere from 904 to 3,593. It now widens a shell at a time until
  nothing outside could be nearer than the k-th found, and on 20,000
  points of a real frame it matches a brute-force search exactly. On a
  capture whose old blocks held enough candidates, results barely move;
  where they did not, they now say what the node's description always
  said.

flame_salmon's frame of 1,059,844: over 396 seconds with the old search,
63 with this one, 581 floaters removed. Most of those seconds are the
floaters themselves, whose search crosses the whole grid.

## Merge by dropping one object on another

Drag an object's wire out and let go over another object's node, and the
two merge - the same merge the context menu offers by name, which stays.
While the wire is held, the nodes it would merge into are outlined.

A node with an input that takes an object - a train node's seed, a light's
source - takes the wire there instead, so dropping on one never merges.
Merge did not get a port of its own after all: it makes a new object out
of two, and every node in the other object's lane already stands for that
object, so the whole node is the target.

## Bounds on an adapter at WebGPU's minimum

The bound pass wrote four RGBA32F targets at once - 64 bytes of colour per
sample, where WebGPU guarantees 32. Real GPUs offer more (128 on the one
tested), but an adapter at the minimum rejects the pass: SwiftShader does,
which is how relighting's headless tests found it. Every splat was then
left with an empty bound, culled out of sight, and camera framing broke.

Where the adapter reports less than 64 bytes, the pass now runs twice,
the selection's min and max one time and the visible min and max the
other, two targets each. Everywhere else it stays one pass. RGBA16F would
have fit in one, but positions want the precision. Forced to split on a
real GPU, both ways give identical bounds on flame_salmon's million
gaussians.

## A run that finishes, finishes

No training run had ever reached "done". The trainer's last batch comes
back with "training complete" in it, and the pump asked for another, as
it would after any batch: an empty answer was meant to say the stream
had ended. It never came. The wasm stream is not fused, so polling it
once more after its end panics - "`async fn` resumed after completion" -
and every run that trained to the last iteration ended as an error, with
its result never committed. The pump now stops at the trainer's own
sign-off. Verified headless on a synthetic four-view dataset: sixty
iterations, "done", the final snapshot in the scene and the numbers on
the node. Fusing the stream in the fork would make the extra poll
harmless too; it is not needed while the host stops first.

## Training from an edited scene

A train node has a second input, seed, beside its dataset. Wire an object
into it - a cleaned-up earlier result, say - and the run starts from that
object's gaussians instead of the dataset's points.

- **How it gets there.** At Start the object's live gaussians are written
  as a PLY and added to the dataset zip as `init.ply`, which Brush takes
  as its starting point cloud in place of anything else. Deleted gaussians
  stay out, so a cleanup or a crop carries into the run. A packed dataset
  gets the file added to its zip without being unpacked: the new entry goes
  in before the central directory, so the entries already there keep
  their offsets and their compression. A picked folder is packed first,
  and is not written to.
- **The data frame, not the scene.** The seed is written where the
  gaussians sit in the object's own data, ignoring where the object has
  been moved to: for an object trained from this dataset, that is the
  frame its cameras are in. An object from another capture would have to
  be in that frame already.
- **Verified** headless: a run seeded from an earlier result decimated to
  5,000 gaussians starts at 5,000; unseeded, the same dataset starts at
  Brush's random 10,000.
- A dataset with its own `init.ply` inside a folder may have that one
  chosen over the seed: Brush takes the first `init.ply` in path order.

## Decimate holds still on a TGH sequence

A decimated sequence no longer shimmers. The decimate node ranked by
opacity times volume, and on a TGH sequence both are the gaussian as
conditioned at that frame's time - so the ranking, and with it the set
dropped, changed with every frame.

- **Ranked once per 4D primitive.** Each TGH frame now carries an
  `importance` column: the primitive's peak opacity times its spatial
  volume, read straight from the checkpoint before conditioning. It is the
  same measure as on a still, taken at the primitive's temporal centre,
  and it does not depend on t. The decimate node ranks on it when it is
  there and as before when it is not - a still, a PLY sequence.
- **Measured** on flame_salmon at keep 40%: of the gaussians alive in two
  frames, the share dropped in one and kept in the other fell from 0.4%
  between neighbouring frames, and 11% across a second, to at most 0.1%.
  What remains happens where a segment of the hierarchy begins or ends:
  the frame's gaussians change, and with them where the cut falls.
- **PLY sequences are not helped.** Their frames are separate files with no
  identity running between them, so there is nothing that holds still to
  rank on.
- The column rides along in the frame data and the data panel lists it,
  but export writes a fixed set of columns and leaves it out.

---

## Lights: a source input, mesh and gauss lights

A light node takes in what it shines from, through a source input on its
top edge, and "add light from selection" is gone from the graph's menu.

- **A primitive makes a mesh light.** Its surface is sampled evenly - 24
  points on a sphere, four on each face of a box, rings and caps on a
  cylinder - each weighted by the area of its patch as the primitive is
  sized, and the light shines from those. The light's colour tints them.
  The primitive is followed live: drag it, and the light comes along.
- **Gaussians make a gauss light**, the volume light under its new name:
  an object's live gaussians, or those a select node picks. A select node
  now keeps what it selected, a new set each time it runs, so the light
  can tell the pick has changed. Gaussians are followed whenever history
  settles - read once it is at rest, like the select nodes' shapes.
- **The kind is the input's** while something is wired in: the light's face
  shows mesh or gauss and does not let it be changed, and hides Use
  Selection. Unwired, a light keeps the emitters it last took, and every
  kind is back on offer.
- **Aimed on wiring.** Wired by hand, a light aims below what feeds it,
  four of its spreads away or half the scene, as a light made from a
  selection always did - its intensity is measured there. After that, the
  aim point moves with the light.
- **Mesh lights do not glow.** The gaussians round a volume light's emitters
  are the lamp itself and glow with its light; round a mesh light's they
  are only near a shape. The light record carries which, and the lighting
  kernel counts the glow only for gauss lights, which come out
  bit-identical to before.
- **Projects** keep what feeds each light - a primitive or an object, by
  their places in the lists - and wire it again, keeping the aim it was
  saved with. A select node is not kept, so a light fed by one comes back
  with the emitters it last took.

Checked headless: a light node's source input takes a primitive, a
selection or an object; a sphere wired in makes a mesh light of 24
emitters where the sphere is, aimed below it, that lights the floor under it
far more than elsewhere; moved, the light follows and the floor it left
goes back to what it was; a box gives 24 samples of its faces; the face
fixes the kind; a select node picking the top of the ball makes a gauss
light at their middle, and moving the node's box moves the light; an object
makes a gauss light of 16 emitters; unwired, the light keeps them; the menu
has no "add light from selection"; a saved project reopens the light wired
to its primitive, aimed as saved. The area and volume light report is
identical to the build before this change.

---

## Select: a mesh input

A select node takes a box, sphere or cylinder in, through a mesh input on
its top edge, and selects the gaussians inside it. When the primitive moves,
the node selects again, and so does everything downstream of it: a delete
after it deletes what is inside the shape where it is now.

- **Wiring** is the graph's: drag a primitive node's output onto the select
  node. The node pane's mesh row sets how it combines - set, add, remove or
  keep - and cuts it loose again, as does the node's menu.
- **Ahead of the steps.** The mesh input is taken first, so the node's own
  gestures refine what the shape caught: a lasso drawn with shift adds to
  the sphere.
- **A copy, not the live shape.** A primitive is moved by edits later in the
  history than the node that uses it, and replaying the node winds those
  back first, so the node cannot read the primitive as it is mid-replay.
  It keeps a copy of the shape - its kind and matrix - taken when the
  primitive settles. Whenever history settles, each applied select node
  whose primitive is no longer where its copy says gets a new copy and is
  replayed, all of them in one replay from the earliest. Settling means a
  drag ending, a size typed in, an undo or redo, or the shape's kind
  changing; nothing re-runs while a primitive is being dragged or typed
  into.
- **Gone is skipped.** With the primitive's node undone or bypassed, the
  input is skipped, as if nothing were wired in, and it comes back with it.
- **Cylinders** are a fourth volume test in the intersection shader: within
  half a unit of the axis, and no further than half a unit along it.
- **The sphere and box tools** now place primitives. Picking one up takes
  the primitive the open select node already takes in, if it is the tool's
  kind, so the tool goes on editing it; otherwise it makes one, quietly -
  the object stays selected and its node stays open. Set, add, remove and
  intersect wire it into that node with that mode, or into a new node when
  the open one takes another shape in. Put down without having been wired
  into anything, the tool's new shape is taken out of history again. The
  tools' own fields and gizmo move the primitive, a step at a time.
- **New lights and primitives are selected once, when made.** They used to
  be selected whenever they entered the scene, which a replay does too - so
  re-running a select node took the selection off the object being worked
  on.

Checked headless, counting on the CPU what each shape holds: wired, the node
selects what is inside the sphere; moved by the pivot, what is inside where
it is now, and undo and redo move the selection with it; a delete after the
node follows the sphere; the four modes over everything selected give the
shape, everything, everything but the shape, and the shape; a cylinder
selects its own; bypassing the primitive skips the input and turning it back
on restores it; disconnecting passes the selection through. The sphere tool
makes a sphere without taking the selection, "set" wires it into a select
node, its radius field re-selects, and picking the tool up again edits the
same sphere; the box tool tried and put down leaves nothing in history.

---

## Primitives: box, sphere and cylinder

Shapes placed in the scene for other nodes to take in: a select node's
volume, a light's surface. Each is an object and a node at once, the way a
light is - a primitive node in the graph with the shape in its lane, and the
shape in the scene and the outliner.

- **The shape** is the unit box, sphere or cylinder (side, diameter and
  height 1, the cylinder standing along its own y) under a position, a
  rotation and a size along each of its own axes. So a box can be any
  cuboid, a sphere can be drawn out into an ellipsoid, and the same matrix
  is what a volume test runs on: what is drawn is what is caught.
- **Adding one**: "add box node", "add sphere node" and "add cylinder node"
  in the graph's menu, or Edit > Add Primitive for the same thing from the
  viewport's side. It lands on the view's focus, a quarter as big as the
  view is deep, and is named by its kind with the first free number.
- **Placing it**: it shares the one selection with objects, cameras and
  lights. Selected - from the outliner, or by clicking its node - it takes
  the move, rotate and scale gizmo and the transform pane. The pivot's
  single scale carries the size along x, and scaling scales all three
  together, so a box keeps its proportions. Each drag is one undo step,
  which the graph does not draw, like aiming a light.
- **Its node's face** sets the shape and the width, height and depth. A size
  moves the shape live while it is typed or dragged, and becomes one undo
  step when it settles.
- **Drawn** as a wireframe, the selected one bright. It is drawn twice, as
  the measure tool's lines are: in the world, where gaussians in front
  cover it, and faintly after them, so a shape placed in among them still
  shows.
- **Projects** save each primitive's name, kind, pose, size and visibility,
  and reopen them as primitive nodes.

Picking a light or a primitive that was already picked let go of any
camera first, which popped the gizmo's handler and left nothing to move.
Both now let go of a camera only when one is held.

Checked headless: a box node puts a selected box in the scene, listed and
drawn as its twelve edges; the pivot moves, turns and scales it keeping its
proportions, as one undo step that undo reverses with the pivot following;
the face turns it into a sphere and types a width without losing the typing,
one undo step when it settles; picking it again keeps the gizmo on it; the
Edit menu adds a cylinder; the eye hides a wireframe; undoing a node takes
its shape out; a saved project reopens with the same three shapes.

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
