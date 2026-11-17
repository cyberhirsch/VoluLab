# WebXR in VoluLab: integration plan

Status: November 2026. Scope: VR viewing on Meta Quest first, AR passthrough
later. Goal from the project brief: a mobile VR demonstrator on Quest that
plays volumetric video longer than 3 minutes, standalone in the browser.

Engine paths below are relative to `E = node_modules/playcanvas/build/playcanvas/src`
(PlayCanvas 2.21.1, `package.json:54`). Web facts were collected by search on
2026-11-16; items marked **(uncertain)** were not confirmed at a primary source
and must be checked on a device. Line numbers in `src/` are from the working
tree of that day, which had uncommitted changes.

## Summary

- Build one small **player core** (`src/player/`): direct rendering, GSV streaming around the playhead, WebXR. Ship it as a **standalone viewer** first; the editor gets an "Enter VR" button later that opens the same core.
- Start the XR session on **WebGL2**; add **WebGPU XR** once verified on Quest Browser 156. 4D playback works on both; relighting and training do not run in the WebGL2 session.
- Budget on Quest 3: about **150k to 400k gaussians drawn per frame**, SH 0 or 1, 72 Hz. Today the whole model sits in memory, so **streaming is required** for 3 minutes.
- Effort: about **60 working days** in 8 phases (section 8).

## 1. What PlayCanvas 2.21.1 offers

VoluLab does not load any of it today: `XrManager` is commented out in
`src/pc-app.ts:59` and `src/pc-app.ts:85`, and the device is created with
`xrCompatible: false` (`src/main.ts:144`).

| Feature | Where | Notes |
|---|---|---|
| Session start / end | `E/framework/xr/xr-manager.js:107`, `E/framework/components/camera/component.js:426` (`camera.startXr(type, spaceType, options)`) | Types `immersive-vr`, `immersive-ar`, `inline`; options include `framebufferScaleFactor`, `optionalFeatures`. `hand-tracking` is always requested as optional (`xr-manager.js:180`). |
| Frame loop | `E/framework/app-base.js:465-470`, `:102-103` | `app.tick` switches to `XRSession.requestAnimationFrame` by itself and calls `xr.update(frame)`. |
| Head pose, views | `xr-manager.js:354-393`, `E/framework/xr/xr-views.js` | Writes the viewer pose to the camera entity's local transform each frame; per-eye view / projection matrices and viewports in `camera.xrViews`. |
| Controllers, hands | `E/framework/xr/xr-input.js`, `xr-input-source.js`, `xr-hand.js`, `xr-joint.js`, `xr-finger.js` | Ray, grip, `gamepad`, select / squeeze events, `handedness`, 25 joints per hand. |
| Frame rate | `xr-manager.js:243` (`updateTargetFrameRate`), `:322` (`supportedFrameRates`) | 72 / 90 / 120 Hz selectable on Quest. |
| Fixed foveation | `xr-manager.js:442-449` | Sets `fixedFoveation` on the presentation layer when the layer has that field. |
| AR modules | `xr-hit-test.js`, `xr-anchors.js`, `xr-plane-detection.js`, `xr-mesh-detection.js`, `xr-light-estimation.js`, `xr-dom-overlay.js` | Requested for AR sessions only (`xr-manager.js:134-178`). |
| WebGL2 presentation | `E/platform/graphics/webgl/webgl-xr-bridge.js:52-66` | One `XRWebGLLayer` as `baseLayer`, `antialias: false`, `alpha: true`. Both eyes side by side in one framebuffer. |
| WebGPU presentation | `E/platform/graphics/webgpu/webgpu-xr-bridge.js:98-128` | `XRGPUBinding` projection layer, `texture-array` with fallback to `texture`. Adds `'webgpu'` as a required session feature (`xr-manager.js:131-133`). XR is reported unavailable on a WebGPU device when `XRGPUBinding` is missing (`xr-manager.js:98-100`). |
| Composition layers | none | No quad / cylinder / media layer API; only the one projection or base layer. |

Stereo rendering:

- WebGL2: one render pass, each draw call issued once per view with that
  view's viewport and uniforms (`E/scene/renderer/forward-renderer.js:431-490`).
  This is not the `OVR_multiview2` extension; draw calls double.
- WebGPU: "multiview" means the camera's passes are replayed once per eye
  into that eye's texture (`E/scene/renderer/frame-pass-multi-view.js:28-37`,
  `forward-renderer.js:660-663`). Vertex work doubles as well.
- Custom `camera.framePasses` (which VoluLab uses) are supported in XR and
  wrapped the same way (`forward-renderer.js:612-617`).

Gaussian splats in XR (the non-unified `GSplatInstance` path VoluLab uses,
`src/splat.ts:228`):

- **One sort for both eyes.** The sort uses the camera node, which in XR is
  the head pose between the eyes (`E/scene/gsplat/gsplat-instance.js:114-139`).
  Order is by depth along the view direction, in a worker, asynchronous to
  rendering. Both eyes share forward direction, so one order is correct for
  both to within the eye offset.
- `viewport_size`, which sizes the splat footprint, is taken from the first
  XR view (`E/scene/renderer/renderer.js:268-277`), so per-eye projection is
  right as long as both eyes have equal viewports.
- The newer unified renderer also handles XR views
  (`E/scene/gsplat-unified/gsplat-hybrid-renderer.js:148-151`,
  `gsplat-projector.js:376`). VoluLab does not use it and its 4D shader
  overrides target the classic path; do not switch as part of this work.
- Not verified by running: VoluLab's shader overrides and MRT splat target in
  an XR session. That is the phase 0 spike.

## 2. WebXR with WebGPU: state and decision

| Browser | WebGL2 XR | WebGPU XR (`XRGPUBinding`) | Source |
|---|---|---|---|
| Quest Browser | yes, for years | Experimental from 146.0 (2026-04-21); foveation 150.1, composition layers 152.1 (both "experimental"); **156.0 (2026-11-13): "added WebGPU in WebXR"**. Whether 156 is on by default without a flag is **(uncertain)**. | [Meta browser release notes](https://developers.meta.com/horizon/documentation/web/browser-release-notes/) |
| Chrome desktop / Android | yes | Intent to Prototype from August 2024; working behind a flag per user reports in October 2026. No ship date found. **(uncertain)** | [blink-dev intent](https://groups.google.com/a/chromium.org/g/blink-dev/c/wOQs_vVnKRo), [Babylon forum thread](https://forum.babylonjs.com/t/webxr-webgpu-binding/63712) |
| Safari, visionOS | yes | Safari 26.2 (December 2025) lists WebGPU in WebXR on visionOS. No `immersive-ar` on visionOS. | [WebKit Safari 26.2 notes](https://webkit.org/?p=17640), [UploadVR](https://www.uploadvr.com/gracia-moving-volumetric-captures-now-streamable/) |
| Spec | | WebXR/WebGPU Binding, Editor's Draft, June 2026 (date from a secondary source). | [explainer](https://github.com/immersive-web/WebXR-WebGPU-Binding/blob/main/explainer.md) |

Related: Gracia streams 4D splats in WebXR on Quest 3 and names WebGPU as its
renderer (May 2026), so the path is usable in practice on Quest
([UploadVR](https://www.uploadvr.com/gracia-moving-volumetric-captures-now-streamable/)).
The SuperSplat viewer defaults to WebGPU and keeps a `webgl` switch
([README](https://github.com/playcanvas/supersplat-viewer)).

**Decision: WebGL2 first, WebGPU second, chosen at player start.**

- A WebXR session is bound to one graphics API and a PlayCanvas device
  cannot change backend without a reload. The player therefore picks the
  backend before creating the device: WebGPU when `XRGPUBinding` exists and
  the user did not force `?device=webgl2`, else WebGL2.
- WebGL2 is the baseline because it runs on every headset browser and in
  every emulator, and it has working fixed foveation on Quest.
- The device must be created with `xrCompatible: true` in both cases
  (`E/platform/graphics/webgpu/webgpu-graphics-device.js:187`,
  `webgl-xr-bridge.js:154` calls `makeXRCompatible` late otherwise, which can
  trigger a context loss).

What this means for features:

| Feature | WebGL2 XR | WebGPU XR | Reference |
|---|---|---|---|
| Static splats | yes | yes | |
| 4D playback (motion in the vertex shader) | yes | yes | GLSL `src/shaders/splat-shader.ts:135-138`, `:235-237`; WGSL `:677-680`, `:769-771` |
| Reading GSV, compact encoding included | yes | yes | decode is WASM WebP on the CPU (`src/tgh/gsv-webp.ts:456-478`) |
| Writing compact GSV | no | n/a in XR | needs a `GPUDevice` (`src/tgh/gsv.ts:191`); editor only |
| Relighting | **no** | possible, cost unknown on mobile | compute passes, WebGPU only (`src/relight/relighter.ts:63`) |
| Training | no | no | not a viewer feature |
| Lens pass | off in XR on both | | per-eye lens warp fights the headset's own distortion |

Relit content for the WebGL2 session has to be baked into the colours at
export. Live relighting in VR waits for the WebGPU backend.

## 3. What blocks XR in VoluLab today

Render loop

- Render on demand: `app.autoRender = false` (`src/scene.ts:135`), a frame is
  drawn only when state changed or `forceRender` was set
  (`src/scene.ts:372-379`). An XR compositor needs a frame every tick; a
  skipped frame shows as a judder or black flash. In XR, `autoRender` must be
  on.
- The switch to the XRSession frame loop itself is free (section 1).
- Canvas size comes from a `ResizeObserver` on the DOM container and is
  applied in `onPreRender` (`src/scene.ts:151-173`, `:382-386`), with
  `_allowResize = false` (`src/scene.ts:137`). In XR the engine sets the
  resolution from the XR framebuffer (`xr-manager.js:356-363`); the observer
  path must be suspended for the session.

Camera

- `Camera.onUpdate` writes the orbit / fly pose to `mainCamera` every frame
  (`src/camera.ts:726-728`, `:766-767`). It runs after `xr.update` and would
  overwrite the head pose. XR needs a rig: head pose on the camera entity,
  locomotion on its parent. `cameraRoot` is assumed to be identity
  (`src/camera.ts:758`).
- Aspect ratio is manual and derived from the offscreen target
  (`src/camera.ts:341-342`, `:721-722`); fov, near / far fitting, ortho mode
  and `poseOverride` all assume one mono view.
- `PointerController` listens to DOM pointer and keyboard events only
  (`src/controllers.ts:13`, `:444-471`).

Frame passes and targets

- Every frame goes clear, world, splats (MRT with a second RGBA8 work
  buffer), optional lens, gizmos, final blit (`src/camera.ts:556-568`), all
  through full-size offscreen targets, the colour one RGBA16F
  (`src/camera.ts:603-672`). On Quest that is two extra full-resolution
  surfaces, a float format and a blit per eye, for features a viewer does not
  need (picking, selection overlay, outline, underlay).
- Target size is `device.width / pixelScale` (`src/scene.ts:385-386`). On
  WebGL2 XR the device size is the double-wide framebuffer, so it may work by
  accident; on WebGPU XR each eye is its own texture layer. Neither is tested.
- The lens pass (`src/camera.ts:379-393`, `src/shaders/lens-shader.ts`) is a
  screen-space warp of the whole frame and is wrong per eye. Off in XR.
- Gizmo, tool-overlay and grid layers (`src/scene.ts:196-218`) and the view
  cube / DOM overlays are editor tools; not rendered in XR.

Sorting

- One sort for both eyes is what the engine does and what we want.
- 4D: done since this was written. The centres are worked out in the
  model's own sort worker (`src/motion-sort.ts`); a timeline frame costs
  the main thread one message, and nothing is allocated per frame.
- The sort is asynchronous, so the order lags the head by one or more
  frames. With fast head motion this shows as popping. Known for all CPU
  sorted viewers ([GaussianSplats3D README](https://github.com/mkkellogg/GaussianSplats3D)).

MSAA and render scale

- MSAA is already off (`src/main.ts:141`, `src/scene-config.ts:16`) and the
  WebGL XR layer is created with `antialias: false`. Keep it off: splats are
  blended and gain nothing ([Spark performance notes](https://sparkjs.dev/docs/performance/)).
- `pixelScale` (`src/scene-config.ts:15`) only scales the offscreen targets.
  In XR the lever is `framebufferScaleFactor`, fixed at session start
  (`xr-manager.js:124`, `:313`). `maxPixelRatio = devicePixelRatio`
  (`src/scene.ts:148`) feeds into it and must be set deliberately.

UI

- All UI is PCUI DOM (`@playcanvas/pcui` 6.1.4). The DOM is not shown in
  `immersive-vr`; `dom-overlay` exists for handheld AR only. The engine's
  Element / Screen / Button component systems are commented out
  (`src/pc-app.ts:13-27`). XR needs its own in-scene panel (section 6).

Data

- A 4D model is read whole from a `Blob` and held in memory
  (`src/tgh/gsv.ts:455-459`, `src/file-handler.ts:331-340`); the motion
  textures cover every gaussian of the sequence (`src/splat.ts:391-413`).
  That does not scale to minutes on a headset (section 7).
- The timeline steps in whole frames at the file's fps
  (`src/timeline.ts:114-116`). At 72 Hz display the motion would step at
  30 Hz although GSV can be evaluated at any `t` (`docs/format-gsv.md:500-502`).

## 4. Performance budget on Quest 3 class hardware

Hardware: Snapdragon XR2 Gen 2, 8 GB RAM, 2064 x 2208 per eye, 72 / 90 /
120 Hz. At 72 Hz a frame is 13.9 ms for both eyes, including the compositor.
Quest 3S has the same chip at lower panel resolution.

Reference numbers from other viewers:

| Viewer | Number | Source |
|---|---|---|
| Spark (three.js, WebXR) | "1 million splats or less" on Quest 3, not concentrated in a small area; `maxStdDev = sqrt(5)` for VR; no MSAA | [sparkjs.dev](https://sparkjs.dev/docs/performance/) |
| Gracia (WebXR, 4D, streamed) | about 120k splats per frame at 75 Mbps; 15k per frame at 17 Mbps; clips of 36 s, 39 s and 4 min | [UploadVR, 2026-05-19](https://www.uploadvr.com/gracia-moving-volumetric-captures-now-streamable/) |
| SplatXR (Unity, native) | 72 fps at 50k and 100k, 59 fps average at 200k, 36 fps in dense views | [radiancefields.com](https://radiancefields.com/splatxr-brings-interactive-gaussian-splats-to-quest-3) |
| Unity VR Gaussian Splatting (native) | about 72 fps up to roughly 400k, centre-eye sort as an option | [GitHub](https://github.com/ninjamode/Unity-VR-Gaussian-Splatting) |
| Scaniverse on Quest | 700k recommended, lag noticeable around 1.2M | [UploadVR](https://www.uploadvr.com/the-best-ways-to-view-gaussian-splats-on-quest/) |
| Babylon.js WebXR (user report) | unusable above about 100k; 400k at 10 to 18 fps | [Babylon forum](https://forum.babylonjs.com/t/the-future-of-gs-in-bbl/60666?page=2) |
| SuperSplat viewer on Quest 3 (user reports) | mixed: a 1.7M scene fine, a 0.7M scan not; no official figures found | [PlayCanvas forum](https://forum.playcanvas.com/t/confetti-like-noise-rendering-gaussian-splats-in-vr/38649) |

The spread (100k to 1M) is mostly fill rate: what matters is overdraw, the
number of screen pixels blended, not the count alone. A person filmed in a
volume fills less of the view than a room scan, which helps.

Proposed budget (to be confirmed in phase 0 and tuned in phase 4):

| Item | Target at 72 Hz |
|---|---|
| Gaussians drawn per frame | 150k to 400k; start at 200k |
| SH bands | 0 by default, 1 as "high"; never 3 |
| Framebuffer scale | 0.8 to 1.0 of the browser default; drop when frames are missed |
| Fixed foveation | 1.0 (maximum) on WebGL2; on WebGPU when the layer exposes it |
| Splat size cap | clamp the footprint in the vertex shader (`maxStdDev` about `sqrt(5)`, and a pixel cap for gaussians close to the eye) |
| Alpha cull | skip gaussians whose faded opacity is below about 1/255 before they reach the rasteriser |
| Frame rate | 72 Hz; 90 Hz only for small content |
| GPU + CPU memory for splat data | under about 1.5 GB **(uncertain: the tab limit on Quest is not documented)** |

What to cut, in order of effect: overdraw (size cap, alpha cull, render
scale, foveation), SH bands (texture fetches and memory), offscreen passes
(section 3), draw count.

4D playback cost per frame:

- GPU: two extra texture fetches and one `exp` per vertex
  (`src/shaders/splat-shader.ts:235-237`). Small next to fill cost.
- CPU: centre evaluation plus a counting sort of the active set
  (`E/scene/gsplat/gsplat-sort-worker.js`), linear in the active count.
  Estimate for 300k on Quest: 5 to 10 ms in the worker **(uncertain, measure)**.
  That fits one sort per content frame (30 Hz) but not per display frame;
  sort at most every second display frame and let `motionTime` advance every
  frame.
- Upload: the order texture (4 bytes per gaussian) after each sort.
- Memory in the current path: roughly 60 to 70 bytes per gaussian on the GPU
  without SH, more than double with 3 bands, plus CPU copies of centres and
  velocities **(estimate)**. 1M resident gaussians at SH 0 is near 100 MB,
  which is fine; the full model of a 3 minute clip is not.

## 5. Architecture

Options:

A. **XR mode inside the editor.** Add XR to `Scene` / `Camera`. Every item
   in section 3 has to be bypassed inside classes built around one mono
   camera and offscreen targets. The editor loads PCUI, training, relight,
   tools and the whole model; too heavy for a headset. It also cannot switch
   backend without a reload.

B. **Exported standalone viewer.** Today the export is the PlayCanvas
   SuperSplat viewer bundled by splat-transform
   (`src/splat-serialize.ts:767-790`, `src/ui/export-popup.ts:100-106`;
   `@playcanvas/splat-transform` 3.10.3 pins `@playcanvas/supersplat-viewer`
   1.39.0). It shows static splats only and knows nothing about GSV, so a 4D
   export needs a viewer of our own in any case.

C. **Both, from one core.**

**Recommendation: C, with B first.** One player core in `src/player/`:

- its own small `AppBase` setup with `XrManager`, one camera rendering
  directly to the backbuffer, no offscreen targets;
- reuses the splat shader's motion code, the GSV reader and the TGH active
  set logic; these get split so they do not import editor modules;
- owns streaming (section 7), the XR rig, input and the in-scene panel;
- built as a second rollup entry, so the bundle carries no PCUI, training or
  relight code.

Shells around the core:

1. **Standalone player page** (phase 1 to 4, 7): `player.html?content=<url>`.
   Static files only, so it satisfies "no helper". It is the Quest
   demonstrator and also works on desktop and phones without XR.
2. **Export** (phase 5): a new export type writes the player plus the GSV
   (as a folder of pages) next to the existing SuperSplat viewer export.
3. **Editor "Enter VR"** (phase 5): opens the player on the current scene.
   On a PC with a tethered headset that is the preview loop for authors.
   Hand-over is by serialising the scene to a blob URL, not by sharing the
   editor's device.

Why: the demonstrator's hard problems (streaming, mobile budget, XR input)
are viewer problems; the editor's are not. Keeping them apart keeps the
editor stable (it is the public MIT product) and lets the player be tuned
for a headset without regard to editing features.

## 6. Interaction in XR

Placement and scale

- Reference space `local-floor`: y = 0 is the user's floor.
- File space to scene space is already defined: `meta.transform` and
  `meta.space.up` (`docs/format-gsv.md:396-401`, read at
  `src/tgh/gsv.ts:661`). Missing is the link to the real world: which height
  is the floor and how many metres a unit is. Calibrated capture rigs are
  usually metric; SfM reconstructions are not.
- Proposal: an optional GSV extension (`docs/format-gsv.md:504`) with
  `floor` (height in scene space) and `metersPerUnit`, authored in the
  editor with the existing measure and orient tools. Fallback: lowest point
  of the scene bound as floor, scale 1.
- A "reset view" action puts the content centre 1.5 m in front of the user.

Locomotion (controllers first, hands as a subset)

| Action | Controller | Hands |
|---|---|---|
| Teleport | left stick forward, arc to the floor plane, release | pinch and hold, release |
| Snap turn | left stick left / right, 30 degrees | none in v1 |
| Move / scale / rotate the scene | both grips: translate, uniform scale, yaw only | two-hand pinch |
| Reset | long press on a face button | panel button |

Smooth locomotion is left out (comfort). Roll and pitch are never applied to
the scene. Scale is clamped (0.1 to 10) and shown while grabbing.

Timeline

- Play / pause: right trigger or A.
- Scrub: right stick left / right while held, with the rate growing over
  time; or drag the bar on the panel with the ray.
- Panel: a quad 0.6 m wide attached to the left controller or floating at
  waist height, drawn from a 2D canvas into a texture, hit-tested with the
  controller ray. Shows time, duration, buffer state, quality preset,
  exit. This avoids enabling the engine's Element / Screen systems and font
  assets. Scrubbing needs streaming to answer seeks (section 7).

AR passthrough (later)

- `immersive-ar` on Quest; the WebGL layer already has alpha
  (`webgl-xr-bridge.js:54-59`). Clear to transparent, premultiplied output.
- Only content without a captured background makes sense: the editor needs
  an export option that drops the static / background set or crops to a box.
- Placement by hit test or by grabbing; an anchor keeps it in place
  (`xr-hit-test.js`, `xr-anchors.js`).
- visionOS Safari has no `immersive-ar`.

## 7. Streaming long sequences

What the format already gives (`docs/format-gsv.md`):

- a zip of stored entries, readable by HTTP Range, `meta.json` first
  (`:49-69`);
- pages as the transport unit, each with a time window `tMin` / `tMax`
  (`:46-47`, `:433`); blocks map hierarchy segments to rows of a page
  (`:455-460`);
- a playback model that fetches pages ahead of the playhead and evicts
  expired ones (`:487-498`);
- optional prefix-ordered tiers for level of detail without extra data
  (`:335-382`).

What the reader does today: opens the whole `Blob`, decodes every page,
builds one model in memory (`src/tgh/gsv.ts:455-459`) and refuses tiered
blocks (`src/tgh/gsv.ts:518-519`).

Design for the player:

1. **Transport.** Two forms, same content: the `.gsv` zip over Range
   requests (read the central directory from the tail once, then one Range
   per entry), and an unpacked folder where each page file has its own URL.
   The folder form needs nothing from the host and caches well; the exporter
   writes it. WebXR needs HTTPS, so the files sit on a static host either
   way.
2. **Resident set.** Always resident: the static page and the global level.
   Windowed: every page whose `[tMin, tMax]` meets
   `[t - 1 s, t + 4 s]` (tunable; wider on fast networks).
3. **Decode off the main thread.** A worker fetches and decodes WebP pages
   (the WASM codec used now, or `createImageBitmap` with premultiplication
   off) and transfers typed arrays.
4. **GPU slots.** Fixed-capacity textures (for example 1024 x 1024 = 1M
   rows). A slot allocator maps page rows to free row ranges; pages are
   written with partial texture updates, not whole-texture uploads. The
   active set sent to the sorter is in slot indices. PlayCanvas uploads
   whole mip levels, so partial updates need a small backend-specific helper
   for WebGL2 and WebGPU.
5. **Eviction.** Free the slots of pages with `tMax < t - 1 s` during
   playback; on a seek, keep what overlaps the new window and drop the rest.
6. **Level of detail.** Read prefix-ordered pages and fetch only the tiers
   the device budget allows. This is how one file serves desktop and Quest.
7. **Clock.** Playback time is continuous in seconds. If the next page is
   not ready, playback pauses and the panel shows buffering. If the content
   has audio, the audio element is the master clock (see open questions).
8. **Compact rows on the GPU (optional, phase 4).** Keep the quantised page
   texels as the GPU format and dequantise in the vertex shader, as SOG
   does. Cuts GPU memory per gaussian by more than half and removes the CPU
   expand step, at the cost of a second shader path.

Sizing example: 30 Mbps for 180 s is about 675 MB over the network, never
resident at once; a 5 s window is about 19 MB of compressed pages. Gracia's
published rates (17 and 75 Mbps) bracket this.

Encoder side, for the demonstrator content: pages no longer than 1 to 2 s,
blocks with overlapping lifetimes grouped (`docs/format-gsv.md:476-478`),
prefix order on, and a per-page gaussian cap that matches the Quest budget.

## 8. Roadmap

| Phase | Content | Days | Needs a Quest |
|---|---|---|---|
| 0 | Spike on a branch: enable `XrManager`, `xrCompatible`, direct-to-backbuffer camera, one static splat and one short GSV on WebGL2. Measure fps against count on the device. Decide the budget. | 3 | yes, for the numbers |
| 1 | Player core and standalone page: second build entry, shared modules split from editor code, XR start / end, rig, `local-floor` placement, continuous time, quality presets. Whole-file GSV. | 10 | no, except checks |
| 2 | Interaction: controllers, teleport, snap turn, two-hand grab, in-scene panel, scrubbing, basic hands. | 8 | partly |
| 3 | Streaming: Range / folder reader, page window, worker decode, slot allocator with partial uploads, eviction, seek, tier reading, buffering state. | 12 | no |
| 4 | Quest performance: centre evaluation in the sort worker, sort throttling, size cap, alpha cull, SH presets, foveation, dynamic framebuffer scale, optional compact GPU rows. | 8 | yes |
| 5 | Export type "VoluLab player" in the export popup, floor / scale extension and its editor UI, "Enter VR" in the editor. | 5 | no |
| 6 | WebGPU XR backend (5 d) and AR passthrough with background removal and placement (4 d). | 9 | yes |
| 7 | Demonstrator hardening: clip longer than 3 minutes end to end, memory soak, thermal behaviour over 10 minutes, network drop handling, audio if required. | 5 | yes |
| | **Total** | **60** | |

Phases 0 to 4 plus 7 are the Quest demonstrator: 46 days.

Risks

| Risk | Effect | Mitigation |
|---|---|---|
| Fill rate on Quest is lower than the budget assumes | content must shrink to a point where quality is not convincing | phase 0 measures before anything is built; foveation, size cap, render scale; author content for the budget |
| Streaming with partial texture updates fights the engine's texture abstraction | phase 3 overruns | backend helper kept small and isolated; fallback is several smaller textures swapped whole |
| Sort lag and popping in VR, worse with a changing active set | visible artefacts on head motion and at segment changes | sort in worker at fixed cadence, keep the existing wait-for-new-set logic (`src/splat.ts:479-497`), test early |
| Memory limit of a Quest browser tab is unknown | tab reload in the middle of a long clip | fixed-capacity buffers, no per-frame allocation, soak test in phase 7 |
| WebGPU XR on Quest 156 is days old | backend not usable or slower than WebGL2 | WebGL2 is the baseline; WebGPU is phase 6 and optional |
| VoluLab's shader overrides or MRT misbehave per eye | spike takes longer | the player renders to one target without MRT |
| Engine upgrades change XR internals touched here | merge cost | use public API only (`camera.startXr`, `app.xr.*`); no engine patches |
| Heat and throttling over minutes | frame rate drops after a few minutes | dynamic framebuffer scale, 72 Hz, measure in phase 7 |

Testing without a headset

- [Immersive Web Emulator](https://github.com/meta-quest/immersive-web-emulator)
  (Chrome extension) and [IWER](https://github.com/meta-quest/immersive-web-emulation-runtime)
  (in-page runtime, usable in automated tests): session flow, stereo
  layout, rig, controller input, teleport, panel, timeline. WebGL2 only;
  emulation of `XRGPUBinding` is **(uncertain)**, assume none.
- The embedded test pane has no WebGPU and no cross-port fetch; use desktop
  Chrome for anything with XR or Range requests.
- Desktop without XR: streaming, eviction, seek, memory growth, tiers, the
  budget presets, with CPU throttling in DevTools as a rough stand-in.
- Desktop Chrome with a tethered headset: real stereo and tracking, but
  desktop GPU speed, so no performance conclusions.

Needs a Quest

- Every performance number, foveation, frame rate selection, thermal runs.
- Comfort: scale, floor height, snap turn, popping.
- Hand tracking, passthrough, WebGPU XR.
- Tools: `chrome://inspect` over USB for the console and profiler, OVR
  Metrics Tool for frame time and thermal level, `adb reverse` for a local
  dev server ([Meta WebXR performance workflow](https://developers.meta.com/vr/documentation/web/webxr-perf-workflow/)).

## 9. Open questions for the project lead

1. Headsets: Quest 3 only, or also 3S, Quest 2 / Pro (much weaker), Vision Pro, Pico?
2. Is a Quest available from phase 0, and who runs the device tests?
3. Content: one person in a volume or a full scene with background? Active gaussians per frame and total for 3 minutes? Can it be retrained or pruned to a headset budget?
4. Audio: does the video have sound? VoluLab and GSV have none today; it needs a GSV extension and a master clock.
5. Hosting: GitHub Pages, lab server or CDN? Is offline playback from headset storage required (service worker cache or OPFS)?
6. Quality bar: is SH 0 with baked lighting acceptable? Is 72 Hz enough?
7. Is live relighting in VR a goal? Then the WebGPU backend moves from phase 6 to the critical path.
8. AR passthrough: part of the demonstrator or later?
9. Are the captures metric and is the floor known? Is a GSV extension for floor and scale acceptable in format 1.x?
10. Does the player live in this public MIT repository, or does the streaming part belong to VoluGym?
11. Is the editor's "Enter VR" (phase 5) needed for the funded goal?
12. Target network: lab Wi-Fi only, or public internet at given bitrates?
