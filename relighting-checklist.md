# Relighting on a real GPU

Items 16 to 19 are built: the grid and its shadows, ambient light and
occlusion, de-light, area and volume lights. They have only ever run on
SwiftShader, a software GPU, where correctness was measured and speed and
looks were not. This is the session that measures those: one sitting on
real hardware with real captures, filling in the blanks below. The results
go back into [task.md](task.md) and [CHANGELOG.md](CHANGELOG.md).

Each step says what to look for. Anything that fails goes into the notes at
the bottom, with what was seen and a screenshot.

---

## Setup

- [ ] **Machine.** GPU: ____ Driver: ____ OS: ____ Browser and version: ____
  A laptop on mains power, with its fast GPU chosen for the browser.
- [ ] **Build.** A production build, not `npm run develop`, whose debug
  build distorts timings:
  ```sh
  npm install
  npm run build
  npm run serve
  ```
  Then open http://localhost:3000. The viewport's header should say
  `webgpu`.
- [ ] **Two limits**, in the DevTools console:
  - `scene.graphicsDevice.wgpu.limits.maxColorAttachmentBytesPerSample`
    → ____. Below 64, the bounds pass fails as it does on SwiftShader (see
    Known limits in task.md): the view breaks after a selection. Note it and
    carry on; framing by hand still works.
  - `scene.graphicsDevice.supportsTimestampQuery` → ____. It must be true
    for the timings below.
- [ ] **Captures**, each with its gaussian count from the status bar:
  1. indoors or a tabletop, about a million gaussians: ____
  2. a large outdoor scene, three million or more: ____
  3. a sunny scene with hard shadows: ____
  4. a scene with something that glows - a lamp, a window, a screen: ____
  5. optional, a sequence of a few frames: ____
- [ ] **The timing helper.** Paste this into the console once per page load:

```js
// Relighting's GPU passes, timed by the engine's own profiler. Paste once per
// page load, then: await relightTime(() => { /* a change that relights */ })
window.relightTime = async (change, frames = 60) => {
    const profiler = scene.graphicsDevice.gpuProfiler;
    const tick = () => new Promise(r => requestAnimationFrame(r));
    profiler.enabled = true;
    for (let i = 0; i < 10; i++) { scene.forceRender = true; await tick(); }
    const before = { ...scene.events.invoke('relight.debug').stats };
    await change();
    const gpu = {};
    for (let i = 0; i < frames; i++) {
        scene.forceRender = true;
        await tick();
        for (const [name, ms] of profiler.passTimings) {
            if (name.startsWith('Relight')) gpu[name] = Math.max(gpu[name] ?? 0, ms);
        }
    }
    const after = scene.events.invoke('relight.debug').stats;
    if (!Object.keys(gpu).length) console.warn('No GPU timings: no timestamp queries in this browser, or nothing relit');
    return {
        gpuMs: Object.fromEntries(Object.entries(gpu).map(([k, v]) => [k, +v.toFixed(2)])),
        ran: Object.fromEntries(Object.keys(after).filter(k => !k.startsWith('last') && after[k] !== before[k]).map(k => [k, after[k] - before[k]])),
        cpuMs: { grid: +after.lastGridMs.toFixed(1), captured: +after.lastCapturedMs.toFixed(1) }
    };
};

// From nothing to the first lit frame: packing every gaussian, the first grid,
// the first light. Run on a fresh page load, before any light exists.
window.firstLight = async (kind = 'sun') => {
    const t0 = performance.now();
    scene.events.invoke('light.addNode', kind);
    while (scene.events.invoke('relight.debug').stats.lightingPasses === 0) {
        await new Promise(r => requestAnimationFrame(r));
    }
    await scene.graphicsDevice.wgpu.queue.onSubmittedWorkDone();
    return Math.round(performance.now() - t0);
};
```

What `relightTime` reports:

- `gpuMs`: each pass's time on the GPU, by the names the relighter gives its
  dispatches. The scene's grid and each captured grid share `RelightResolve`,
  `RelightPull` and `RelightPush`, so time the two kinds of grid separately,
  as below.
- `ran`: which passes ran, as counts.
- `cpuMs`: the CPU side of the last grid and captured-grid builds - mostly the
  box, which is still worked out on the CPU.

Changes that each rerun one part:

```js
const light = scene.events.invoke('light.list')[0];
// lighting alone: nudge a light
await relightTime(() => { light.position.x += 1e-3; light.changed(); });
// the scene's grid, and everything after it - with de-light at 0, so no
// captured grid rebuilds alongside
await relightTime(() => scene.events.fire('relight.setSettings', { resolution: 192 }));
await relightTime(() => scene.events.fire('relight.setSettings', { resolution: 128 }));
// occlusion, with an ambient light on: nudge the range
await relightTime(() => scene.events.fire('relight.setSettings', { occlusionRange: 0.11 }));
// every captured grid, its occlusion and de-light: turn de-light on from 0
await relightTime(() => scene.events.fire('relight.setSettings', { delight: 0.5 }));
// de-light's own pass alone: nudge its strength
await relightTime(() => scene.events.fire('relight.setSettings', { delight: 0.55 }));
```

---

## 1. Shadows (item 16) - capture 1

- [ ] On a fresh page load, `await firstLight()`: ____ ms from adding a sun
  to its first lit frame.
- [ ] The shadows look right: dark where things meet the ground, and no
  speckle over open, flat surfaces - which would be surfaces shadowing
  themselves.
- [ ] Lighting alone, one sun: ____ ms. Grid build, `RelightDeposit` +
  `Resolve` + `Pull` + `Push`: ____ ms GPU, ____ ms `cpuMs.grid`.
- [ ] Drag the sun with the gizmo: smooth?
- [ ] Orbit round a wall or a table top and look at both sides. Each side is
  lit as it should be, with no speckle where a thin surface's gaussians face
  different ways.
- [ ] Softness 0, 0.3 and 1: the penumbras widen, and nothing turns blotchy.
- [ ] Grid resolution 64, 128 and 256: grid builds of ____ / ____ / ____ ms.
  Is the sharper shadow at 256 worth the time?
- [ ] Grid resolution 512, 768 and 1024: grid builds of ____ / ____ / ____ ms.
  Does the panel say "Using …" under the setting at any of them? That is the
  GPU not holding the grid: note the number. Open, flat surfaces and fuzzy
  areas should look as they do at 256, not darker; shadow edges sharper.
- [ ] Delete something that casts a shadow: the shadow goes. Undo: it comes
  back.

## 2. Large scenes - capture 2

- [ ] `await firstLight()`: ____ ms. Lighting alone: ____ ms. Grid build:
  ____ ms GPU, ____ ms `cpuMs.grid`.
- [ ] The grid's cell size, `scene.events.invoke('relight.debug').grid.cell`:
  ____. Are shadows blocky or smeared at that size?
- [ ] **Stress:** a sun, a spot, a point light, a rectangle, an ambient light,
  and de-light at 1, all at once. Lighting: ____ ms. Check that the GPU
  survives: no "device lost" in the console, and the viewport keeps drawing.

## 3. Ambient light and occlusion (item 17) - capture 1

- [ ] Add an ambient light and load an `.hdr` sky into it. Occlusion: ____ ms.
- [ ] Surfaces darken where things meet, open ones stay as they were, and the
  room is not black at the default range, 0.1.
- [ ] Range 0.05, 0.1 and 0.3: which suits this capture? An interior going dark
  at 0.3 is expected, since there is no bounce light.

## 4. De-light (item 18)

- [ ] **The identity** (capture 1): de-light at 1, captured light at 0,
  occlusion strength at 1, and a flat white ambient light at intensity 1 as
  the only light. The capture should look exactly as loaded. Any difference
  is a bug; screenshot it.
- [ ] With a sun added, de-light at 0, 0.5 and 1: do baked contact shadows
  lift? Do cavities come out too bright at 1? Is 0.5 the right default?
- [ ] **A matched sun** (capture 3): add a sun and set its role to "baked in".
  Set captured light to 1, hide the other lights, and aim the sun until the
  baked shadows fade. Do they? How visible is the dark outline left at their
  edges at de-light 1, and at 0.5?
- [ ] De-light floor at 0.2, then 0.5: is the noise in deep shadows calmer?
- [ ] **A deleted object's shadow:** delete something that cast a baked shadow.
  With "de-light counts deleted" on yes, its shadow fades from the ground;
  with no, it stays.
- [ ] Times per object, turning de-light on from 0: captured grid ____ ms,
  captured occlusion ____ ms, de-light ____ ms, `cpuMs.captured` ____ ms. A
  strength nudge alone: ____ ms.

## 5. Area lights (item 19) - capture 1

- [ ] A rectangle off to one side, aimed at the subject like a softbox: broad,
  soft shadows. At its aim point it should be about as bright as a point light
  of the same intensity.
- [ ] A disk, and a sphere close to a surface: no black or white speckle, and
  no seam where the sphere meets the surface's horizon.
- [ ] Lighting with one rectangle: ____ ms, against one point light: ____ ms.
  They should be close, since each is one trace.

## 6. Volume lights (item 19) - capture 4

- [ ] Select the glowing gaussians, then use "add light from selection" in the
  graph's menu. Time it with
  `console.time('v'); scene.events.invoke('light.addFromSelection'); console.timeEnd('v')`:
  ____ ms.
- [ ] Check three things:
  - the surroundings light up from where the lamp is;
  - the lamp itself still looks as captured;
  - intensity 0 turns the lamp dark, as if switched off.
- [ ] Does glow spill onto what touches the lamp, like a table or a shade? How
  far?
- [ ] Set its role to "baked in" with de-light on. Does the light the lamp
  baked into its surroundings fade, as if it had been switched off?
- [ ] Lighting with the volume light: ____ ms.

## 7. Sequences (optional) - capture 5

- [ ] With a sun on, scrub through the frames. Smooth? Each frame rebuilds
  the grid and relights: ____ ms a frame. With de-light on, the captured grid
  rebuilds too: ____ ms.

## 8. Memory and saving

- [ ] The tab's GPU memory on capture 1, in the browser's task manager
  (Shift+Esc in Chrome, with the GPU memory column shown):
  - no lights: ____
  - one sun: ____
  - plus an ambient light: ____
  - plus de-light: ____
  - plus grid resolution 1024: ____
- [ ] Save a project holding one light of every kind, including an ambient
  light with an HDRI and a volume light. Reload it: every light comes back
  the same.
- [ ] Load with `?device=webgl2`: the lights are drawn and the light node
  says why they light nothing.

---

## Results

| Capture | Gaussians | First light | Grid build | Occlusion | Captured grid + occlusion | De-light | Lighting, one sun | Lighting, stress | GPU memory |
|---|---|---|---|---|---|---|---|---|---|
| 1 | | | | | | | | | |
| 2 | | | | | | | | | |
| 3 | | | | | | | | | |
| 4 | | | | | | | | | |

Targets to judge the numbers against. They are guesses until this session
replaces them:

- lighting alone with one light at a million gaussians: 8 ms or less, so a
  light drags at 60 frames a second;
- a grid build: 30 ms or less (rebuilds are throttled to ten a second during
  a drag);
- occlusion: 150 ms or less (it runs once per grid while an ambient light is
  on);
- a captured grid and its occlusion: 300 ms or less, once per object;
- the de-light pass with one matched sun: 50 ms or less;
- no lost device at three million gaussians under the stress setup.

## Notes

Anything that failed or looked wrong, with a screenshot:

-

## Afterwards

- Put the numbers into task.md's relighting section in place of "owing a
  real-GPU session", and move anything that failed into the "Left from
  item" lists.
- For a pass far over its target, task.md already names the first things to
  try: the grid as a 3D texture with hardware filtering (under "The unknown,
  resolved"), and moving the box and the gaussian packing to the GPU (left
  from item 16).
