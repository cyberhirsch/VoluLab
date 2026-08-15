# VoluLab

VoluLab is a browser-based editor for inspecting, editing, optimizing and
publishing 3D Gaussian Splats and splat sequences. It runs entirely in the
browser — nothing to download or install.

VoluLab is a fork of the **[SuperSplat Editor](https://github.com/playcanvas/supersplat)**
by PlayCanvas, used under the MIT licence and rebranded and extended for
volumetric video work. Essentially all of the splat engineering — loading,
rendering, editing, serialising and publishing Gaussian Splats — is their work;
this fork changes the interface, not the core. See [LICENSE](LICENSE) for the
upstream copyright, and [Credits](#credits) below.

## Context

VoluLab is the intended front end for
[VolumetricVideo](https://github.com/cyberhirsch/VolumetricVideo), a
reproduction of *Representing Long Volumetric Video with Temporal Gaussian
Hierarchy* (Xu et al., SIGGRAPH Asia 2024). That project trains 4D Gaussian
representations; this one views and edits them.

Note that the editor currently handles **3D** Gaussian Splats, with temporal
playback supported only as PLY frame sequences (`frame0001.ply`,
`frame0002.ply`, …) — see [`src/sequence.ts`](src/sequence.ts). Native support
for the 4D primitive and its temporal hierarchy is not yet implemented.

## Interface

The layout is a Blender-style tree of resizable panes, after
[Aerialist2](https://github.com/cyberhirsch/aerialist2). Each pane's function
is switchable from its own header dropdown, and every pane can be split side by
side, split stacked, or closed. The layout persists across reloads.

Pane kinds: **viewport**, **outliner**, **transform**, **timeline**, **splat
data**, **settings** and **color**.

Because there is a single WebGL canvas, `viewport` is a singleton: assigning it
to another pane swaps kinds with whichever pane currently holds it, and closing
the viewport pane hands the viewport to the surviving sibling rather than
losing the canvas. The layout model lives in
[`src/workspace.ts`](src/workspace.ts); the DOM rendering in
[`src/ui/workspace-view.ts`](src/ui/workspace-view.ts).

The visual language is a greyscale terminal aesthetic, also after Aerialist2:
one monospace family throughout, an eight-step grey ladder, no corner radius,
and no colour accents — the 3D viewport is the only thing on screen carrying
colour. Errors are the sole exception. Design tokens live in
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

## Known Rebranding Gaps

- The wordmark in the menu bar is VoluLab's, but the application logo in
  [`src/ui/about-popup.ts`](src/ui/about-popup.ts) is still the upstream
  SuperSplat mark, as are the PWA icons in [`static/icons`](static/icons).
- Scene publishing ([`src/publish.ts`](src/publish.ts)) uploads to the
  PlayCanvas backend and requires a PlayCanvas account.
- Help and About links point at upstream PlayCanvas resources.
- Project files keep the upstream `.ssproj` extension and MIME type so existing
  SuperSplat projects still load.

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
