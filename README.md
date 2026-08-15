# VoluLab

VoluLab is a browser-based studio for volumetric scenes — spaces captured from
the real world as **3D Gaussian Splats** rather than modelled as polygons. You
open a capture, clean it up, place it in a usable coordinate system, move a
camera through it and render the result.

It runs entirely client-side. No install, no account, no upload: the scene is
read straight off your disk and never leaves the machine. That matters when a
single capture is a couple of gigabytes and belongs to a client.

The problem it exists to solve: a fresh splat capture is technically correct and
practically unusable. It arrives full of floaters and haze, carries whatever
happened to be standing behind your subject, sits at an arbitrary scale, and is
tilted at whatever angle the camera rig felt like. None of that is fixable in a
viewer, and reaching for a general-purpose 3D package means fighting a data type
it was never built for. VoluLab is the room where a raw capture becomes a shot
you can actually use.

## What You Can Do Today

**Bring scenes in.** Load captures in the common splat formats, merge several
into one scene, and keep the result as a project file that remembers your
edits, camera work and view settings.

**Select exactly what you mean.** Rectangle, lasso, polygon, brush and sphere
or box volumes, plus a flood select that grows through connected regions and an
eyedropper that picks by colour. Selections combine — add, subtract, intersect —
so you can carve out an awkward region in a few passes instead of one perfect
one.

**Clean up.** Delete floaters and unwanted background outright, or lock parts of
the scene so a later selection cannot touch them. Everything is undoable, and
the splat data panel shows you the distributions behind the scene so you can
find the outliers rather than hunt for them.

**Place it properly.** Move, rotate and scale, with a measure tool for real
distances and an orient tool for putting the ground plane where the ground
actually is. A capture that arrives tilted and at arbitrary scale can be made
metric and level.

**Grade it.** Tint, temperature, saturation, brightness, black and white point,
and transparency, applied to the scene rather than baked in afterwards.

**Move the camera.** Store camera poses, lay them out on a timeline and let
VoluLab interpolate between them along a spline. Orbit and fly navigation for
setting shots up.

**Play sequences.** Frame sequences load as an animated scene and scrub on the
timeline, so a capture that changes over time can be reviewed in motion instead
of frame by frame.

**Get it out.** Export to the standard splat formats, including compressed
variants for delivery, or render straight to an image or a video.

## Where It's Going

The direction is **volumetric video** — not just viewing something that moves,
but authoring with it.

**Volumetric video as a first-class citizen.** Today time is a thin layer over
a stack of independent frames. The aim is for a moving scene to be one object
with a real temporal dimension: edits that apply across time rather than
per-frame, selections that persist as a subject moves, and playback that stays
efficient over minutes rather than seconds.

**A node-based workflow.** Cleanup and grading are currently a sequence of
destructive operations with undo as the only way back. The plan is a graph:
each operation a node, inputs and parameters editable after the fact, the whole
recipe re-runnable on a new capture of the same setup. Reorder a cleanup pass or
change a threshold without redoing everything downstream.

**Deeper camera animation.** Poses and spline interpolation are the foundation.
Beyond that: easing and timing you can actually shape, multiple cameras, lens
and depth-of-field controls, and motion that can be matched to a real camera
move.

**Voxels and other volumetric formats.** Gaussian splats are one way to
represent captured volume, not the only one. Voxel grids, and other volumetric
representations alongside them, so the tool follows the work rather than the
file format — including converting between them where it makes sense.

## Interface

The layout is a Blender-style tree of resizable panes. Each pane's function is
switchable from its own header dropdown, and every pane can be split side by
side, split stacked, or closed. The layout persists across reloads.

Pane kinds: **viewport**, **outliner**, **transform**, **timeline**, **splat
data**, **settings** and **color**.

Because there is a single WebGL canvas, `viewport` is a singleton: assigning it
to another pane swaps kinds with whichever pane currently holds it, and closing
the viewport pane hands the viewport to the surviving sibling rather than
losing the canvas. The layout model lives in
[`src/workspace.ts`](src/workspace.ts); the DOM rendering in
[`src/ui/workspace-view.ts`](src/ui/workspace-view.ts).

The visual language is a greyscale terminal aesthetic: one monospace family
throughout, an eight-step grey ladder, no corner radius, and no colour accents —
the 3D viewport is the only thing on screen carrying colour. Errors are the sole
exception. Design tokens live in
[`src/ui/scss/colors.scss`](src/ui/scss/colors.scss); active states invert to a
solid fill rather than taking a hue.

## Local Development

Requires [Node.js](https://nodejs.org/) 20.19 or later.

1. Install dependencies:

   ```sh
   npm install
   ```

2. Build VoluLab and start a local web server:

   ```sh
   npm run develop
   ```

3. Open a browser tab and make sure network caching is disabled on the network
   tab and the other application caches are clear:

   - On Safari use `Cmd+Option+e` or Develop → Empty Caches.
   - On Chrome ensure "Update on reload" and "Bypass for network" are enabled
     in the Application → Service workers tab.

4. Navigate to `http://localhost:3000`

When changes to the source are detected, VoluLab is rebuilt automatically.
Refresh your browser to see your changes.

## Supported Formats

| Direction | Formats |
|---|---|
| Import | `.ply`, `.splat`, `.ksplat`, `.spz`, `.sog`, `.lcc`/`.lcc2`, `.ssproj` |
| Export | `.ply`, compressed `.ply`, `.splat`, `.sog`, `.spz` |

Project files use the `.ssproj` extension, unchanged from upstream, so existing
SuperSplat projects load without conversion.

## Localization

Supported languages live in [`static/locales`](static/locales).

### Adding a New Language

1. Add a new `<locale>.json` file in the `static/locales` directory.
2. Add the locale to the list in [`src/ui/localization.ts`](src/ui/localization.ts).

### Testing Translations

Run the development server and navigate to `http://localhost:3000/?lng=<locale>`,
replacing `<locale>` with your language code (e.g. `fr`, `de`, `es`).

## Known Gaps

- Scene publishing ([`src/publish.ts`](src/publish.ts)) still uploads to the
  PlayCanvas backend and needs a PlayCanvas account, so the menu item is
  present but not useful here.
- The PWA icon is a single non-square image rather than the conventional 192
  and 512 pixel pair, pending a square master.
- Project files keep the `.ssproj` extension and MIME type from upstream, so
  existing projects load without conversion.

## Credits

- **[SuperSplat Editor](https://github.com/playcanvas/supersplat) by PlayCanvas
  — MIT.** The editor this is forked from, and the origin of nearly all the
  functionality here. If you want the original, well-supported tool rather than
  this reskin, go there: <https://superspl.at/editor>
- Pane-header icons are [Material Symbols](https://fonts.google.com/icons)
  (Outlined) by Google — Apache 2.0 — vendored as path data in
  [`src/ui/workspace-view.ts`](src/ui/workspace-view.ts).
- The workspace model and visual language follow Aerialist2.

## License

MIT — see [LICENSE](LICENSE).
