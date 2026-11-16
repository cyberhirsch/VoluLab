# Vauss-Trainer für das Browser-Training von VoluLab: Prüfung

Stand: 16.11.2026. Geprüft wurde `voyager-so/vauss` am Commit `6294ecf` (Snapshot `vauss-v0.1.25-rc`), gegen Brush upstream `1388f74c` und gegen den VoluLab-Fork `cyberhirsch/brush`, Branch `volulab`, Commit `687fd62b`.

Alles hier stammt aus dem Lesen von Quelltext, Lizenzdateien und Diffs. **Es wurde nichts gebaut, nichts ausgeführt und nichts gemessen.** Der vorgesehene `wasm32`-Build kam nicht zustande (siehe Abschnitt 4). Aussagen sind mit *[gelesen]* (im Quelltext nachgesehen) oder *[vermutet]* (Schluss ohne Beleg) markiert.

## Kurzfassung

- Die Lizenz erlaubt die Übernahme: alle 14 Crates `crates/splat-train*` sind Apache-2.0, die zwei vendored CubeCL-Crates MIT OR Apache-2.0.
- Vauss baut nicht auf dem Brush-Stand von VoluLab auf, sondern auf einem **19 Commits neueren** Upstream-Stand (3.10.2026 statt 16.8.2026). Ein Teil des Tempogewinns steckt schon in diesen Upstream-Commits und ist ohne Vauss zu haben.
- Der Trainer ist erkennbar für `wasm32` gepflegt: es gibt eigens markierte Browser-Patches (`splat patch (wasm only)`). Ein öffentliches WASM-Paket, eine JS-Bindung oder ein CI-Job dafür fehlen aber.
- Die Trainingsschleife, die die Crates antreibt (`crates/splat-brush`), steht unter der Vauss Preview License und ist tabu. VoluLab müsste weiter Brushs eigene `brush-process` und `brush-js` nutzen.
- Die beworbenen 5,4× sind gegen gsplat-MCMC auf einer L40S über Vulkan gemessen. Einen Vergleich Vauss gegen Brush habe ich in README und `docs/launch/BENCHMARKS.md` nicht gefunden; für den Browser gibt es keine Zahl.

**Empfehlung:** Nicht den Vauss-Trainer als Ganzes übernehmen. Zuerst den VoluLab-Fork auf Brush `1388f74c` heben, dann messen, dann höchstens drei in sich geschlossene Teile aus Vauss nachziehen (Abschnitt 6).

## 1. Lizenzlage je Crate

Quellen: `LICENSE`, `NOTICE`, `crates/splat-train/NOTICE`, das `license`-Feld jeder `Cargo.toml` und die erste Zeile jeder `LICENSE`-Datei im Crate. *[alles gelesen]*

### Apache-2.0 bzw. MIT OR Apache-2.0 (kommt in Betracht)

| Crate | Herkunft (Brush) | Lizenz |
|---|---|---|
| `splat-train` | `brush-train` | Apache-2.0 |
| `splat-train-render` | `brush-render` | Apache-2.0 |
| `splat-train-loss` | `brush-loss` | Apache-2.0 |
| `splat-train-cube` | `brush-cube` | Apache-2.0 |
| `splat-train-sort` | `brush-sort` | Apache-2.0 |
| `splat-train-scan` | `brush-scan` | Apache-2.0 |
| `splat-train-dataset` | `brush-dataset` | Apache-2.0 |
| `splat-train-serde` | `brush-serde` | Apache-2.0 |
| `splat-train-serde-macros` | `brush-serde-macros` | Apache-2.0 |
| `splat-train-vfs` | `brush-vfs` | Apache-2.0 |
| `splat-train-async` | `brush-async` | Apache-2.0 |
| `splat-train-colmap` | `colmap-reader` | Apache-2.0 |
| `splat-train-rrfd` | `rrfd` | Apache-2.0 |
| `splat-train-lpips` | `lpips` | Apache-2.0 |
| `vendor/cubecl-common` | CubeCL `46752244` (0.11.0-pre.4), gepatcht | MIT OR Apache-2.0 |
| `vendor/cubecl-wgpu` | CubeCL `46752244` (0.11.0-pre.4), gepatcht | MIT OR Apache-2.0 |
| `splat-sfm-learned` | Port von Depth Anything 3 / DINOv2 | Apache-2.0 AND IJG (für VoluLab hier ohne Belang) |

Jedes dieser Crates trägt `license = "Apache-2.0"` in der `Cargo.toml` und eine eigene `LICENSE` mit dem Apache-Text. Die `LICENSE` im Wurzelverzeichnis sagt ausdrücklich, dass die Brush-Abkömmlinge Apache-2.0 bleiben, „including their modifications“.

### Vauss Preview License (nicht übernehmen)

`splat-agent`, `splat-assets`, `splat-brush`, `splat-cli`, `splat-contracts`, `splat-core`, `splat-effects`, `splat-eval`, `splat-fetch`, `splat-fill`, `splat-inpaint`, `splat-mcp`, `splat-mesh`, `splat-sfm`, `splat-shots`, `splat-spirula`, `splat-webexport`. Alle erben `license-file = "LICENSE"` aus dem Workspace. Ausnahme innerhalb von `splat-eval`: nur die Datei `src/color.rs` ist Apache-2.0.

Die Preview License verbietet, geänderte Fassungen weiterzugeben. VoluLab ist öffentlich und MIT; jede Zeile aus diesen Crates wäre ein Verstoß.

### Was die Lizenz für die Übernahme bedeutet

- **`splat-brush` ist die Lücke.** In der Zuordnungsliste von `crates/splat-train/NOTICE` fehlt `brush-process`. Vauss hat Brushs Trainingsschleife durch `splat-brush/src/train.rs` (1775 Zeilen) und `engine.rs` ersetzt, beide unter Preview License. Wie Vauss den Trainer aufruft (Reihenfolge der Setter, Budgets, Abschluss), darf man lesen, aber nicht abschreiben.
- Apache-2.0 verlangt bei Weitergabe: Lizenztext beilegen, `NOTICE` erhalten, geänderte Dateien als geändert kennzeichnen. Das gilt auch für das ausgelieferte `brush_js_bg.wasm`.
- Die öffentliche Historie besteht aus Snapshot-Commits („public source snapshot“). `NOTICE` verweist für die Änderungen auf die Git-Historie; einzelne Änderungen lassen sich dort nicht nachvollziehen. Nachziehen späterer Vauss-Stände heißt jedes Mal Diff gegen einen ganzen Snapshot.
- „This version only“: spätere Vauss-Versionen können andere Bedingungen haben. Für die Apache-Teile dieses Stands ändert das nichts.

## 2. Was Vauss gegenüber Brush geändert hat

### Drei Stände, nicht zwei

| Stand | Commit | Datum |
|---|---|---|
| VoluLab-Fork, Basis | upstream `362dc394` + 3 eigene Commits (70 Zeilen in 6 Dateien) | 16.8.2026 |
| Brush upstream, Basis von Vauss | `1388f74c` | 3.10.2026 |
| Vauss | `6294ecf` | 12.–16.11.2026 |

Zwischen VoluLabs Basis und der Vauss-Basis liegen 19 Upstream-Commits mit 3782 Einfügungen und 2211 Löschungen unter `crates/`. *[gelesen]* Darunter:

- `993c3a23` (#546): Burn fusioniert den Trainingsschritt, Scans in eigenem Crate `brush-scan`, weniger Kernel-Starts im Min-Scale-Fold (laut Commit-Text 19 auf 7).
- `64b85338` (#554): SH-Second-Moment auf den kompakten Gradienten reduziert (laut Commit-Text 1,15 GB je Schritt weniger bei 3 M Splats).
- `1388f74c` (#556): „Improve viewer rendering and training efficiency“.
- `2f4fb858` (#527): „Keep prefix sums within WebGPU limits“.
- `ce76c88f` (#526): Wechsel auf Burns native Runtimes.

Upstream prüft `wasm32` in seiner CI (`cargo check -p brush-app -p brush-js --target wasm32-unknown-unknown`). Dieser Teil ist also browsertauglich gehalten und frei von Vauss.

### Umfang der Vauss-Änderungen (Diff gegen `1388f74c`)

| Crate | Einfügungen / Löschungen | Inhalt |
|---|---|---|
| `splat-train` | 9770 / 579 | Trainer |
| `splat-train-render` | 6196 / 734 | Rasterizer vorwärts und rückwärts |
| `splat-train-loss` | 1497 / 27 | Loss-Kernel |
| `splat-train-serde` | 661 / 22 | Import/Export, `.ply.zst`, Quantisierung |
| `splat-train-cube` | 495 / 3 | Autotune-Bundles, VRAM-Abfrage |
| `splat-train-sort` | 376 / 57 | Radix-Sort |
| `splat-train-dataset` | 281 / 21 | kleine Ergänzungen |
| `splat-train-scan` | 272 / 7 | ein zusätzlicher Scan-Kernel |
| übrige sechs | je rund 210 | fast nur Lizenzdateien und `Cargo.toml` |

Die Zahl der Compute-Kernel steigt von 17 auf 35. *[gezählt per Skript über `#[cube(launch)]`]*

### Die Änderungen nach Thema

**GPU-Sortierung** (`splat-train-sort`, in sich geschlossen) *[gelesen]*
- 8-Bit- statt 4-Bit-Ziffern: halb so viele Durchgänge und Dispatches.
- Bei kleinen Sorts zählt der Scatter-Kernel den nächsten Durchgang mit; der eigene Zähl-Dispatch entfällt. Im Kommentar ist die 16-KiB-Grenze von WebGPU für Shared Memory ausdrücklich berücksichtigt.
- Die Eingabepuffer dienen als zweites Ping-Pong-Paar, wenn niemand sonst sie hält.
- Sortierlänge liegt auf der GPU (`radix_argsort_with_count`), kein Readback nötig.
- Der Subgroup-Pfad (`plane_inclusive_sum`) im Scatter ist entfernt; der Kernel braucht keine Subgroups mehr.

**Scan** (`splat-train-scan`, in sich geschlossen) *[gelesen]*
- `scan_in_place`: ein einzelner Start für kurze Eingaben statt einer Rekursionsstufe.

**Rasterisierung** (`splat-train-render`, stark verzahnt) *[gelesen, in Auszügen]*
- Rückwärts-Rasterizer mit Zustand in Registern (`rasterize_backwards_planes.rs`, 719 Zeilen), nutzt Subgroup-Operationen; ohne Subgroups Rückfall auf den bisherigen Kernel.
- Trainings-Renders warten nicht mehr auf ihre eigenen Zählerstände: die Größe der Intersection-Puffer kommt aus dem vorigen Schritt („lagged counts“), ein Überlauf kappt die fernsten Splats und vergrößert den Puffer für den nächsten Schritt. Die CPU kann Schritt N+1 kodieren, während die GPU Schritt N rechnet.
- Kapazitäts-Hinweise mit Fenster und p99-Quantil, damit Puffer selten neu angelegt werden.
- Projektion und Shading der sichtbaren Splats in Vor-Sortier-Reihenfolge, dann Tiefensortierung der Indizes.
- Präfixsumme der Tile-Zähler in zwei Starts, verschmolzen mit Gather und Null-Füllungen.

**Fusionierte Operationen** *[gelesen]*
- `project_update_kernel`: Rückwärts-Projektion und Adam-Schritt in einem Kernel (12 Puffer-Bindings).
- Fusionierter Parameter-Update mit Neuverpackung der quantisierten Momente (`quant_kernels.rs`, 949 Zeilen).

**Speicher und Puffer-Wiederverwendung** (`memory-design.md`) *[gelesen]*
- SH-Koeffizienten in f16 statt f32, ohne f32-Kopie.
- SH-First-Moments von Adam in 8 Bit je Block, Geometrie-Momente in 32 statt 64 Bit je Wert.
- GPU-Sync und Freigabe der Pool-Seiten vor jedem Refine, damit alte und neue Puffergrößen nicht nebeneinander liegen.
- Vauss' eigene Messung dazu: ein Paar auf L40S, truck, 7k Schritte: Spitzen-VRAM −21,9 %, Laufzeit −14,7 %. Wiederholungen stehen laut Dokument aus. *[Zahl von Vauss, nicht nachgemessen]*

**Trainingsbudgets** (`train.rs`, `config.rs`) *[gelesen]*
- Automatisches Splat-Budget aus Szene, Trainingspixeln und Gerätespeicher; exponentielle Wachstumskurve.
- Morton-Sortierung der Splats alle 1000 Schritte für bessere Speicherlokalität.
- Ein einziger Readback je Refine für alle Entscheidungen auf dem Host.

**Vendored CubeCL** (`vendor/*/PATCH.md`) *[gelesen]*
- Bind-Group-Cache: laut Patch-Notiz waren `create_bind_group`-Aufrufe rund 11 % der CPU-Zeit je Schritt.
- Persistenter Pipeline-Cache (nur Vulkan).
- Übertragungen über 64 MiB in Stücken.
- Thread-Aufwecken im Kanal zwischen Client und Server (nur native Threads).

**Neue Funktionen, die VoluLab nicht braucht, aber mitkämen**
- 2DGS-Surfels, neurale Appearance (`neural*.rs`), Pose-Refinement, Kamera-Bewegungsunschärfe (`blur_kernels.rs`, 1156 Zeilen), Depth-Prior, Multi-View-Loss, QAT-Tail, 39 neue Felder in `TrainConfig`.

### Was in sich geschlossen ist

| Teil | Geschlossen? | Begründung |
|---|---|---|
| 8-Bit-Radix-Sort | ja | eigenes Crate, 3 Dateien, alte Signatur `radix_argsort` bleibt erhalten |
| `scan_in_place` | ja | ein zusätzlicher Kernel, eine Funktion |
| Bind-Group-Cache in `cubecl-wgpu` | ja | eigene Datei plus Einhängepunkte in 3 Dateien; hängt an der CubeCL-Revision `46752244` |
| WASM-Patches in `cubecl-wgpu` | ja | vier kleine, markierte Stellen |
| Morton-Sortierung der Splats | weitgehend | nutzt den Sort und die Zeilen-Umordnung im Refine |
| Rückwärts-Rasterizer mit Subgroups | nein | hängt am geänderten Projektions-Layout und an `render_bwd.rs` |
| Lagged Counts, Kapazitäts-Hinweise | nein | durchziehen `render.rs` (1055 geänderte Zeilen) und `train.rs` |
| Fusionierter Adam, f16-SH, gepackte Momente | nein | Renderer, Rückwärtspfad, Optimizer, Refine und Export hängen zusammen |
| Automatische Budgets | nein | hängen an der VRAM-Abfrage, die es im Browser nicht gibt |

## 3. Browser-Tauglichkeit

### Für `wasm32` vorhanden *[gelesen]*

- `cfg(target_family = "wasm")`-Pfade in `splat-train`, `-render`, `-serde`, `-cube`, `-async`, `-rrfd`, `-vfs`, `-dataset` und in `vendor/cubecl-wgpu`.
- Vier ausdrücklich als „splat patch (wasm only)“ markierte Stellen:
  1. `train.rs`: `Device::sync` blockiert und ist im Browser nicht möglich; stattdessen ein asynchroner Readback eines Elements (`wasm_gpu_wait`).
  2. `optim.rs`: f16-SH nur, wenn das Gerät `shader-f16` meldet; sonst f32. Der Kommentar nennt Chrome auf Linux/NVIDIA als Fall ohne f16.
  3. `cubecl-wgpu/.../shader.rs`: Atomics in `var<storage, read>` lehnt Tint ab, also `read_write`; `enable subgroups;` und abgeschaltete Subgroup-Uniformity-Diagnose für Browser.
  4. `cubecl-wgpu/.../storage.rs` und `stream.rs`: `GPUBuffer.destroy()` wird nach dem Submit ausdrücklich aufgerufen, weil wgpu im Browser Puffer sonst erst beim JS-Garbage-Collector freigibt.
- `splat-train/Cargo.toml` beschränkt `tokio` für WASM auf `io-util` und `rt`, mit Begründung im Kommentar.
- `deny.toml` führt `wasm32-unknown-unknown` als Ziel.

Diese Stellen zeigen, dass Vauss den Trainer intern im Browser laufen lässt oder ließ. *[vermutet; ein öffentlicher Beleg fehlt]*

### Für `wasm32` nicht vorhanden *[gelesen]*

- Kein WASM-Paket, keine JS-Bindung, kein Gegenstück zu `apps/brush-js` im Repo.
- Die CI baut nur `x86_64-unknown-linux-gnu`, `aarch64-apple-darwin` und `x86_64-pc-windows-msvc`. Ein WASM-Bruch fiele dort nicht auf.

### Was im Browser nicht oder nur eingeschränkt läuft

| Teil | Im Browser | Beleg |
|---|---|---|
| VRAM-Abfrage (`vram.rs`, Vulkan `VK_EXT_memory_budget` über `ash`) | nein, per `cfg` abgeschaltet; liefert `None` | *[gelesen]* |
| Automatisches Splat-Budget nach Gerätespeicher | fällt auf einen konservativen Wert zurück | *[gelesen im Kommentar, Wert nicht geprüft]* |
| Persistenter Pipeline-Cache | nein, „Not compiled on wasm“ | *[gelesen]* |
| Autotune-Bundles | wirkungslos: Auswahl nach exaktem Adapternamen und Backend „Vulkan“ bzw. „Metal“ | *[gelesen]* |
| Kanal-Aufwecken in `cubecl-common` | wirkungslos, nutzt native Threads | *[gelesen]* |
| LPIPS-Loss im Training | per `cfg` abgeschaltet | *[gelesen]* |
| `float_export`, Pfad-basierte Eval-Teile | per `cfg` abgeschaltet | *[gelesen]* |
| `rayon` (neue Abhängigkeit von `splat-train`) | ohne Threads einsträngig | *[vermutet]* |
| Rückwärts-Rasterizer mit Subgroups | nur mit WebGPU-Feature `subgroups`; sonst der alte Kernel | *[gelesen]* |
| Butterfly-Reduktion | nur bei genau 32 breiten Subgroups (NVIDIA, Apple); sonst langsamerer Weg | *[gelesen]* |
| Surfels (2DGS), neurale Appearance | brauchen Subgroups zwingend (`assert!`) | *[gelesen]* |
| f16-SH und gepackte Momente | nur mit `shader-f16`; sonst f32 und damit kein Speichergewinn bei SH | *[gelesen]* |
| Übertragungen in 64-MiB-Stücken | unverändert nutzbar | *[vermutet]* |

### Offene Risiken bei WebGPU-Grenzen

- **Storage-Buffer je Shader-Stufe.** WebGPU garantiert 8. Der größte Vauss-Kernel bindet 12 Puffer (`project_update_kernel`), upstream `1388f74c` schon 11 (`project_forward_kernel`), der VoluLab-Fork heute 9. *[gezählt per Skript; Uniforms können je nach Übergabe dazukommen]* Ob Chrome auf den Zielgeräten 12 hergibt, ist ungeprüft. Das Risiko entsteht bereits beim Sprung auf upstream `1388f74c`, nicht erst mit Vauss.
- **Shared Memory je Workgroup.** WebGPU garantiert 16 KiB. Der Sort hält das laut Kommentar ein; die neuen Rasterizer-Kernel habe ich nicht nachgerechnet. *[offen]*
- **Workgroup-Größe.** Der Sort verlangt `WG >= 256`, das ist genau die garantierte WebGPU-Obergrenze. *[gelesen]*

## 4. Build für `wasm32-unknown-unknown`: nicht ausgeführt

Toolchain und Target sind vorhanden: `rustc 1.97.1`, `cargo 1.97.1`, Target `wasm32-unknown-unknown` installiert. Die Ressourcen hätten gereicht (CPU 4 % Last, 35 GB RAM frei, 200 GB auf G: frei; die GPU war zu 99 % fremdbelegt, ein Build braucht sie nicht). Die Build-Skripte, die dabei auf dem Host laufen würden (`vendor/cubecl-common/build.rs`, `vendor/cubecl-wgpu/build.rs`), habe ich gelesen: sie setzen nur `cfg`-Schalter.

Der Build selbst wurde von der Rechteprüfung der Sitzung zweimal abgelehnt (einmal über PowerShell, einmal über Bash). Ich habe ihn nicht auf anderem Weg erzwungen. **Woran der Build scheitert oder ob er durchläuft, ist damit unbekannt.**

Der Befehl, von Hand im Ordner `G:\Code\_3D\_extern\vauss` auszuführen:

```bash
CARGO_TARGET_DIR=G:/Code/_3D/_extern/vauss-target cargo build --locked -j 4 -p splat-train --target wasm32-unknown-unknown
```

Erwartung *[vermutet]*: Der Trainer-Crate baut, weil die WASM-Pfade gepflegt wirken. Möglich sind Brüche an Stellen, die seit dem letzten internen WASM-Build dazukamen (`rayon`, `sha2`, `serde_json` in `splat-train`; neue Module ohne `cfg`). Ein gelungener Build von `splat-train` beweist noch kein lauffähiges Training: dazu fehlen `brush-process` und `brush-js` gegen diese Crates.

## 5. Geschätzter Aufwand

Alle Angaben sind Schätzungen ohne Build und ohne Messung.

### Weg A: VoluLab-Fork auf Brush `1388f74c` heben (ohne Vauss)

- Drei eigene Commits (70 Zeilen) auf 19 neue Upstream-Commits umsetzen. `apps/brush-js/src/lib.rs` und `brush-process` haben sich upstream geändert (156 Einfügungen, 88 Löschungen), Konflikte sind zu erwarten.
- `brush-engine.ts` an geänderte Nachrichten und Konfigurationsfelder anpassen (z. B. `units_per_meter`, `growth_start_iter`).
- Im Browser prüfen: 11 Storage-Buffer, Subgroups, Speicher.
- **1 bis 3 Tage.** Lizenz unverändert Apache-2.0, kein neuer Fork-Unterhalt.

### Weg B: zusätzlich geschlossene Teile aus Vauss

- 8-Bit-Sort und `scan_in_place`: rund 650 Zeilen, je Crate austauschbar.
- WASM-Patches und Bind-Group-Cache aus `vendor/cubecl-wgpu`: verlangt, CubeCL als gepatchte Kopie zu führen, passend zur CubeCL-Revision von Brush `1388f74c`.
- **3 bis 6 Tage** über Weg A hinaus, dazu die Pflege einer gepatchten CubeCL-Kopie bei jedem Brush-Update.
- Der `GPUBuffer.destroy()`-Patch ist für den Browser der wahrscheinlich wertvollste Einzelteil: er betrifft genau die Speicherspitzen, die im Tab zum Absturz führen. *[vermutet]*

### Weg C: die ganzen `splat-train*`-Crates unter `brush-process` und `brush-js`

- Die Kern-API ist erhalten (`SplatTrainer::new_seeded`, `set_view_cams`, `step`, `refine`, `bounds`). *[gelesen]* Vauss' eigene Schleife ruft aber zusätzliche Setter (`set_train_pixels`, `set_target_sh_degree`, `finish_training` und weitere). Welche davon für korrektes Training nötig sind, muss man aus den Apache-Crates selbst herleiten; die Antwort steht in `splat-brush`, das nicht übernommen werden darf.
- 16 000 Zeilen fremder Diff im Trainer und Renderer, davon große Teile für Funktionen, die VoluLab nicht anbietet.
- Fork eines Forks: Brush-Updates und Vauss-Snapshots müssen beide nachgezogen werden, Vauss liefert nur Snapshots.
- **2 bis 4 Wochen** bis zu einem stabilen Browser-Training, danach dauerhaft erhöhter Pflegeaufwand.

## 6. Empfehlung

1. **Weg A zuerst.** Er ist klein, lizenzrechtlich unverändert und bringt die Upstream-Verbesserungen, auf denen Vauss selbst aufsetzt. Vorher und nachher im Browser messen: Schritte je Sekunde, Spitzen-VRAM, auf demselben Datensatz und derselben GPU.
2. **Dann entscheiden, ob Weg B lohnt.** Kandidaten in dieser Reihenfolge: `GPUBuffer.destroy()`-Patch, Bind-Group-Cache, 8-Bit-Sort. Jeden Teil einzeln einbauen und messen.
3. **Weg C nicht gehen.** Der Tempogewinn im Browser ist unbelegt, die Verzahnung hoch, die antreibende Schleife gesperrt, und die Hälfte der Speicherersparnis hängt an `shader-f16` und Subgroups, die nicht jeder Browser liefert.
4. **Vor jeder Übernahme** den Build aus Abschnitt 4 von Hand ausführen. Er kostet wenige Minuten und ersetzt die größte Vermutung dieses Berichts durch einen Befund.

Die 5,4× sind kein Maß für VoluLab: gemessen gegen gsplat-MCMC, auf L40S, über Vulkan, bei 1 M Splats und 30 000 Schritten. Wie viel davon gegenüber Brush `1388f74c` im Browser über Dawn/D3D12 übrig bleibt, weiß niemand, auch dieser Bericht nicht.

## Anhang: was auf der Platte liegt

Außerhalb von VoluLab, nicht Teil des Repos:

- `G:\Code\_3D\_extern\vauss`: Klon von `voyager-so/vauss`, Tiefe 50, Stand `6294ecf`.
- `G:\Code\_3D\_extern\brush-upstream`: Klon von `ArthurBrussee/brush`, Stand `1388f74c`, nur für den Diff.

Es wurden keine Release-Binaries geladen, keine Skripte aus dem Vauss-Repo gestartet und kein Vauss-Code nach VoluLab kopiert. An `Repos/brush` wurde nichts geändert.
