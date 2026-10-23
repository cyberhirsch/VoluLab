# GSV: Gaussian Splat Video

Draft 0.1. A file format for 4D Gaussian splats; extension `.gsv`.

## 1. Purpose

GSV stores a dynamic Gaussian splat scene as **4D gaussians**: primitives
with extent in space and time, from which the 3D gaussians of any moment are
derived by conditioning. This is the representation of real-time 4DGS
(Yang et al.) and of the Temporal Gaussian Hierarchy (TGH, Xu et al.,
SIGGRAPH Asia 2024), which VoluLab already evaluates.

The format is designed for the gap the current landscape leaves (October
2026): glTF `KHR_gaussian_splatting` and OpenUSD's ParticleField cover
static splats only, MPEG's dynamic Gaussian splat coding is still at the
call-for-proposals stage, and the dynamic formats that exist are either
per-frame sequences (large, and they flicker) or vendor containers.

Goals, in priority order:

1. **Exact.** A frame decoded from GSV is, up to quantisation, the frame
   the trained model renders. The conditioning maths is normative (section
   6), not left to the player.
2. **No flicker.** A primitive has one identity across its whole lifetime;
   nothing is re-fitted per frame.
3. **Compact.** A lossy encoding at roughly a tenth of raw float size,
   built on the techniques SOG has shown in practice (WebP channels,
   codebooks, Morton order).
4. **Streamable.** A player fetches only the data alive around the current
   time; long recordings do not have to be loaded whole.
5. **GPU-evaluable.** Every step from file to rendered 3D gaussian can run
   in a shader. Nothing needs a neural network or a CPU pass per frame.

Non-goals for version 1: deformation-network representations (HexPlane
4DGS), polynomial motion (Spacetime Gaussians), time-varying spherical
harmonics, audio. Section 10 notes where extensions would go.

## 2. Terms

- **Primitive**: one 4D gaussian.
- **Normalised time** `t`: the scene's time mapped to `[0, 1]`.
- **Level**: a granularity of the temporal hierarchy. Level `l` divides
  `[0, 1]` into segments of length `S_l`.
- **Block**: the set of primitives belonging to one (level, segment) pair,
  or to the global or static set. Blocks are the unit of *visibility*.
- **Page**: a set of textures or buffers holding the rows of one or more
  blocks. Pages are the unit of *transport*.

## 3. Container

A GSV file is a ZIP archive with every entry **stored** (no deflate), no
data descriptors and no zip64. Stored entries can be read by HTTP Range
straight out of the archive once the central directory is known, and WebP
is compressed already.

```
scene.gsv
├── meta.json            manifest, required, first entry
├── static/…             page files of the static set (optional)
├── p0000/…              page files
├── p0001/…
└── …
```

The same layout unzipped into a directory, with `meta.json` at its root, is
an equally valid GSV ("unpacked GSV"); a web server can serve it directly.

`meta.json` SHOULD be the first entry in the archive, so a streaming reader
can start before the central directory arrives.

## 4. Data model

### 4.1 The 4D primitive

| Field | Type | Meaning |
|---|---|---|
| `mean` | 4 × float | `(x, y, z, t)`: spatial position and temporal centre (normalised time) |
| `logScale` | 4 × float | natural log of the standard deviations along the primitive's 4 principal axes; the 4th is the temporal one |
| `rotL`, `rotR` | 2 × quaternion (w, x, y, z) | left and right isoclinic rotations; together an SO(4) rotation |
| `opacity` | float | logit of the peak opacity |
| `sh` | `3 × (1 + K)` floats | spherical-harmonic colour: DC plus `K` rest coefficients per channel, `K ∈ {0, 3, 8, 15}` |

The SH are 3D spherical harmonics, the same for the primitive's whole
lifetime, with the 3DGS convention: `colour = 0.5 + SH_C0 · dc + …`.

Quaternions need not be stored normalised. Readers MUST normalise them
before use.

### 4.2 Static primitives

Many scenes are mostly still: a stage, a room, a background. A 4D primitive
can only approximate stillness with a very long temporal scale. GSV allows
plain **3D gaussians** in a separate static set instead: no `t`, no temporal
scale, a single rotation. They are present at every `t` and are rendered
as they are. A static gaussian costs about a third less than a 4D one, and
static and dynamic content can then be edited independently.

### 4.3 Temporal hierarchy

The dynamic primitives are partitioned into blocks:

- **Global block** (`level: -1`): alive at every `t`.
- **Level blocks** (`level: l ≥ 0`, `segment: k`): alive for
  `t ∈ [k · S_l, (k + 1) · S_l)`.

`S_l` SHOULD be a power-of-two fraction (`1/2`, `1/4`, …), so that the
segment arithmetic below is exact in binary floating point.

A file without a hierarchy has a global block only. Every primitive is
then considered at every `t`, and the temporal falloff alone hides it
outside its lifetime.

## 5. The active set at time t

The primitives to condition at normalised time `t` are, in this order:

1. every static gaussian;
2. every primitive of the global block;
3. for each level `l` in ascending order, the primitives of the block with
   `segment = floor(t / S_l)`, if such a block exists.

The segment index MUST be computed in double precision, with `S_l` read as
stored. At `t = 1`, `floor(1 / S_l)` names a segment past the end, which
normally does not exist. Encoders MUST therefore place primitives needed at
the final instant so that this case is covered: in the global block, or by
writing the last segment as `[k · S_l, 1]` and flagging it `closed: true`.

**Sampling.** A sequence of `N` frames samples frame `f` at
`t = f / (N − 1)`. `meta.time.frames` and `meta.time.fps` give `N` and the
playback rate.

## 6. Conditioning (normative)

For each active dynamic primitive at time `t`:

1. **Rotation.** Normalise `rotL = (a, b, c, d)` and `rotR = (p, q, r, s)`.
   Form

   ```
   L = | a  -b  -c  -d |      R = | p  -q  -r  -s |
       | b   a  -d   c |          | q   p   s  -r |
       | c   d   a  -b |          | r  -s   p   q |
       | d  -c   b   a |          | s   r  -q   p |
   ```

   and `R4 = L · R`.

2. **Covariance.** `Σ = R4 · diag(exp(2 · logScale)) · R4ᵀ`, a symmetric
   4 × 4 matrix. Partition it as

   ```
   Σ = | Σ₃    σ  |      Σ₃: 3 × 3 spatial block
       | σᵀ   σ_tt |      σ: 3 × 1 space–time column
   ```

3. **Conditional at t.** With `v = max(σ_tt, 1e-12)` and `Δ = t − mean.t`:

   ```
   position   = mean.xyz + σ · (Δ / v)
   covariance = Σ₃ − σ · σᵀ / v
   ```

4. **Opacity.**
   `α = sigmoid(opacity) · exp(−½ · Δ² / v)`, clamped to
   `[1e-6, 1 − 1e-6]`.

5. **Colour.** The SH coefficients as stored.

The result is an ordinary 3D gaussian (position, covariance, opacity, SH),
rendered like any other. A renderer working with scale and rotation instead
of covariance obtains them by eigendecomposition of `covariance`; its
eigenvalues MUST be clamped to at least `1e-18`.

**Culling.** A renderer MAY skip a primitive whose temporal factor
`exp(−½ · Δ² / v)` falls below `1 / 255`: it would contribute less than one
8-bit step.

This is the same computation as `GaussianModel4D.get_conditional_3d` in the
TGH training code, clamps included, and as `TghModel.evalFrame` in VoluLab.

## 7. Encodings

Every page uses one of two encodings, named in its `encoding` field.

### 7.1 `f32`: lossless

Each attribute is a little-endian `float32` buffer, row-major, one row per
primitive:

| File | Shape |
|---|---|
| `mean.bin` | N × 4 |
| `logScale.bin` | N × 4 |
| `rotL.bin`, `rotR.bin` | N × 4 |
| `opacity.bin` | N |
| `sh.bin` | N × (3 + 3K), coefficient-major: DC r, g, b, then each rest coefficient's r, g, b |

Static pages use `mean.bin` N × 3, `logScale.bin` N × 3 and a single
`rot.bin`.

This is the archival and interchange encoding: nothing is lost relative to
a training checkpoint.

### 7.2 `webp`: compact

Following SOG, attributes become RGBA images saved as **lossless WebP**,
one texel per primitive, row-major, width `W` from the page header. All
pages of a file share the codebooks in `meta.json`.

| Texture | R | G | B | A |
|---|---|---|---|---|
| `means_l.webp` | x low byte | y low byte | z low byte | t low byte |
| `means_u.webp` | x high byte | y high byte | z high byte | t high byte |
| `scales.webp` | sx index | sy index | sz index | st index |
| `rot_l.webp` | smallest-three of `rotL` (3 bytes) | | | largest-component tag |
| `rot_r.webp` | smallest-three of `rotR` (3 bytes) | | | largest-component tag |
| `sh0.webp` | DC r index | DC g index | DC b index | `round(255 · sigmoid(opacity))` |
| `shN_labels.webp` | label low byte | label high byte | – | – |

- **Positions** (x, y, z) are 16-bit lerps between the page's `mins` and
  `maxs` of `sign(v) · ln(|v| + 1)`, as in SOG.
- **Time** is a 16-bit linear lerp between the page's `tMin` and `tMax`.
  A page spans a short window, so the resolution is far finer than the
  frame spacing.
- **Spatial scales** index a 256-entry codebook `scaleCodebook`; the
  **temporal scale** indexes a separate one, `timeScaleCodebook`, because
  its distribution has nothing to do with the spatial one.
- **Rotations** use SOG's smallest-three packing: the three smaller
  components times √2, mapped to bytes, and a tag `252 + i` naming the
  dropped largest component `i`, which is reconstructed as positive.
- **DC colour** indexes the 256-entry `colourCodebook`.
- **Rest SH** use SOG's palette: up to 65 536 centroids stored in
  `meta.json`'s `shN` texture, quantised through `shCodebook`, selected per
  primitive by a 16-bit label.

Static pages omit `t` (`means_*.webp` alpha is unused), the temporal scale
and `rot_r.webp`.

Unless the page uses prefix order (7.3), rows within each block SHOULD be
in Morton order of the spatial mean, which helps WebP compression and GPU
sorting.

**Size.** Before WebP compression, a 4D primitive takes 28 bytes in this
encoding (8 means, 4 scales, 8 rotations, 4 colour/opacity, 4 for the
label texel), against 260 in `f32` at SH degree 3 (65 floats): about 9 ×.
Lossless WebP typically saves a further 20–40 %.

### 7.3 Prefix order: level of detail without extra data (optional)

After Matryoshka Gaussian Splatting (MGS, arXiv 2603.19234): if the
primitives are ordered by importance, every prefix of the list is itself a
usable, coarser version of the scene. The level of detail is then a single
number - how much of each block to draw - and the file holds no extra data
for it.

A page opts in with `"order": "prefix"`. Its rows are then split into
**tiers**, each tier its own set of textures or buffers
(`<page>/<tier>/means_l.webp`, …), and:

- every block of the page has a slice in every tier, given by its `tiers`
  list of `[start, count]` pairs, one per tier, rows within that tier;
- every row of a block in tier `k` ranks above every row of the same block
  in tier `k + 1`.

How rows are ordered *within* a tier is given by `tierOrder`:

| `tierOrder` | Within a tier | What a player may draw | Trade-off |
|---|---|---|---|
| `importance` | descending importance | any prefix of a block: whole tiers, then any leading part of the next | continuous level of detail; WebP compresses worse, since neighbours in the texture are no longer neighbours in space |
| `morton` | Morton order | whole tiers only | discrete levels (one per tier); compression as for 7.2 |

A player at detail `f ∈ (0, 1]` draws, for each active block, its first
`ceil(f · count)` rows in rank order, and fetches only the tiers those rows
lie in. A player MAY use a different `f` per block, for instance by distance
or by screen size. At `f = 1` the result is identical to an unordered page.

**Importance.** The encoder chooses it and records it in `importance`:

- `"opacityVolume"`: `sigmoid(opacity) · exp(sx + sy + sz)`, the spatial
  extent weighted by peak opacity. It does not depend on `t`, so a primitive
  keeps its rank for its whole lifetime and the set drawn at a given `f` does
  not shimmer from frame to frame. VoluLab's decimate uses the same score
  for a TGH sequence for exactly this reason.
- `"trained"`: the order comes from training with prefix budgets, as MGS
  does. Prefixes of a trained order look markedly better at low `f` than a
  sorted one, but need a training pass that knows about them.
- Other values are allowed. A player never needs to know which was used;
  the field is for tools that reorder or merge files.

The order MUST NOT depend on `t`. A per-frame order would bring back the
flicker this format exists to avoid.

**Cost.** Each tier adds one set of files per page, so tiers SHOULD be few
and grow geometrically - for example 10 %, 30 %, 100 % of rows - which gives
the coarse levels cheaply and keeps the per-page overhead small.

## 8. meta.json

```jsonc
{
  "asset": { "format": "gsv", "version": "1.0", "generator": "VoluLab 0.2" },

  "time": {
    "frames": 300,               // N, optional
    "fps": 30,                   // optional
    "duration": 10.0             // seconds, optional; N / fps if absent
  },

  // optional 4 × 4 column-major matrix from file space to scene space
  "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1],

  "sh": { "bands": 3 },          // 0..3, so K = 0, 3, 8 or 15

  // shared by every page with encoding "webp"
  "codebooks": {
    "scale": [ /* 256 floats */ ],
    "timeScale": [ /* 256 floats */ ],
    "colour": [ /* 256 floats */ ],
    "sh": [ /* 256 floats */ ],
    "shN": { "count": 65536, "file": "shN_centroids.webp" }
  },

  "levels": [ 0.5, 0.25, 0.125 ],  // S_l per level

  "pages": [
    {
      "id": "static",
      "kind": "static",
      "encoding": "webp",
      "count": 120000,
      "width": 512,
      "mins": [/* x, y, z */], "maxs": [/* x, y, z */]
    },
    {
      "id": "p0000",
      "kind": "dynamic",
      "encoding": "webp",
      "count": 48000,
      "width": 256,
      "mins": [/*…*/], "maxs": [/*…*/],
      "tMin": 0.0, "tMax": 0.25
    },
    {
      "id": "p0001",
      "kind": "dynamic",
      "encoding": "webp",
      "count": 52000,
      "width": 256,
      "mins": [/*…*/], "maxs": [/*…*/],
      "tMin": 0.25, "tMax": 0.5,
      // optional, section 7.3
      "order": "prefix",
      "tierOrder": "importance",
      "importance": "opacityVolume",
      "tierCounts": [5200, 10400, 36400]
    }
  ],

  "blocks": [
    { "level": -1, "page": "p0000", "start": 0,     "count": 30000 },
    { "level": 0,  "segment": 0, "page": "p0000", "start": 30000, "count": 18000 },
    { "level": 1,  "segment": 3, "page": "p0003", "start": 0, "count": 9000, "closed": true },
    // a block on a prefix-ordered page: one [start, count] per tier
    { "level": 0,  "segment": 1, "page": "p0001", "count": 52000,
      "tiers": [[0, 5200], [0, 10400], [0, 36400]] }
  ],

  "extensionsUsed": [],
  "extensionsRequired": []
}
```

Rules:

- Every dynamic primitive belongs to exactly one block; a block's rows are
  contiguous within one page, or, on a prefix-ordered page, within each
  tier. Its tier counts sum to its `count`.
- A page MAY hold several blocks. Encoders SHOULD group blocks whose
  lifetimes overlap, so a player fetching the pages for a time window
  fetches little it does not need.
- Paths in `pages` resolve to `<id>/<texture>` or `<id>/<buffer>`.
- `extensionsUsed` and `extensionsRequired` work as in glTF: a reader MUST
  refuse a file that requires an extension it does not know, and MAY
  ignore one that is only used.

## 9. Playback

A conforming player:

1. reads `meta.json`;
2. for the current `t`, determines the active blocks (section 5) and the
   pages holding them, and fetches the missing ones, ahead of the playhead -
   on prefix-ordered pages only the tiers its detail level needs (7.3);
3. conditions every active primitive (section 6), on the GPU where it can;
4. renders the resulting 3D gaussians with the usual depth sort.

Pages whose blocks have all expired MAY be evicted.

Because conditioning is exact, scrubbing, reverse playback and arbitrary
frame rates need no special handling: any `t` is as valid as a sampled
frame.

## 10. Extension points

Reserved names for later versions:

- `GSV_temporal_sh`: spherindrical harmonics, colour that varies with time
  (as in Yang et al.'s 4DGS).
- `GSV_motion_poly`: polynomial motion and rotation per primitive (Spacetime
  Gaussians), to bring `.splatv` content in.
- `GSV_audio`: a synchronised audio track.
- `GSV_spz`: SPZ in place of WebP for the dynamic attributes.

## 11. Conformance

- **Readers** must implement sections 5 and 6 exactly. VoluLab's parity
  check is the model for a conformance test: `gen_parity_fixture.py` (in
  the VolumetricVideo repo) records what the TGH training code produces for
  a small random model, and `tgh-parity.ts` compares a reader against it.
  The tolerances it uses, for the `f32` encoding: identical active sets,
  positions within `1e-4`, covariances within `1e-3` relative, opacity
  within `1e-5`, SH within `1e-6`.
- **Writers** must produce files that pass a reader's validation: counts
  matching the textures, every block in range, codebooks of the stated
  size.
- **Round trip**: `f32` → `webp` → decode must stay within the quantisation
  error of each field (section 7.2).

## 12. Mappings

| Source | To GSV |
|---|---|
| TGH checkpoint (VoluLab `.npz`) | Direct. `_xyz`, `_t`, `_scaling`, `_scaling_t`, `_rotation_l`, `_rotation_r`, `_opacity`, `_features_dc`, `_features_rest` map to section 4.1; `hierarchy.level`, `.segment`, `.seg_len` map to blocks and `levels`. |
| Real-time 4DGS (Yang et al.) | Same primitive, global block only. Its 4D SH needs `GSV_temporal_sh`; without it the time terms are dropped. |
| 3DGS PLY / SOG | A static page. |
| Frame sequences | Not directly. Fitting 4D primitives to a sequence is a training problem, not a conversion. |
| `.splatv` | Only through `GSV_motion_poly`. |

From GSV to the rest is always possible: condition at each frame and write
any static format, PLY, SOG, SPZ or glTF.

## 13. Open questions

- **Name.** `.gsv` showed no prior use in October 2026; the GSVC paper
  (2D gaussians for ordinary video) is the nearest name, and unrelated.
- **Hierarchy semantics** at `t = 1`: the `closed` flag is a proposal; the
  TGH training code's behaviour at the very last instant should be checked
  first.
- **Static set from TGH.** TGH has no static set; whether to move
  long-lived global primitives into it on export (and with what tolerance)
  is an encoder choice to measure.
- **Codebook scope.** File-wide codebooks keep pages small but force a
  writer to see all data before writing; per-page codebooks would allow
  writing a live capture as it arrives.
- **Texture width.** One width per page or one for the file: per-page
  wastes less space on small blocks, a single width eases GPU atlasing.
- **Prefix order in 4D.** MGS was shown on static scenes. Whether a
  trained prefix order carries over to 4D primitives - and to TGH, where a
  block is already a temporal subset - is untested; so is how much
  `opacityVolume` loses against it at low detail.
- **Relation to MPEG GSC.** If MPEG's dynamic call ends up favouring a
  primitive like this one, GSV should map onto it rather than compete.
