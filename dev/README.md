# HUD harness

Renders the real HUD, settings panel, Runs panel and replay extras/custom bar (`src/hud.js`, `src/hud-model.js`, the views and styles) with fixture data over screenshots from actual Surfd replays. Only the game session, replay-reference loaders, run history, ramp references, saveloc binds, cinematic state and playback are faked (`dev/fixtures.js`). Native replay uses the actual transport structure and shipping `rt-*` stylesheet in `dev/native-transport.js` / `dev/native-transport.css`; its controller is a fixture, not the game engine. Cinematic fixtures exercise controls, not camera rendering, physics or synchronization.

The backdrops are not in the repository (they are screenshots of the game). Save your own 1920×1080 JPEG captures as `dev/backdrops/<name>.jpg` for `snow`, `fog`, `ice`, `neon`, `warm`, `dark` and `menu`; the folder is gitignored. Without them the harness draws a plain gradient sky.

```sh
bun dev/serve.js            # http://127.0.0.1:5178/dev/
```

Pick a state and backdrop from the bottom-left menus, or use the URL:

| Parameter | Values |
| --- | --- |
| `state` | `ramp`, `air` (stale Up), `net`, `sole`, `pair`, `none`, `unavailable`, `live`, `start-good`, `start-bad`, `checkpoint`, `checkpoint-start`, `practice`, `replay`, `invalid`, `spectating`, `energy-good`, `energy-loss`, `energy-neutral`, `menu`, `watching` (replay bar) |
| `bg` | `snow`, `fog`, `ice`, `neon`, `warm`, `dark`, `menu` |
| `scale`, `y`, `opacity` | Layout settings, e.g. `scale=1.6&y=10` |
| `palette=custom` | A non-default palette |
| `panel=display\|feedback\|compare\|controls\|history` | Opens the settings panel on that section |
| `play=playing\|paused\|ended` | With `state=watching`: the playback state (default `playing`, and the playhead moves; `ended` holds on the last frame). Left alone for about 3 s, native transport and extras fade together; custom mode retains its timeline |
| `set.customReplayUi=false` | Use native transport plus graded touch marks, saved locs and tools instead of the default custom bar |
| `cinema=off\|solo\|group\|focus\|many\|error` | With `state=watching`: cinematic controls disabled, one run, several runs, one focused run, twelve extras, or an activation error |
| `view=pov\|steady\|cinematic` | With `cinema`: the view shown (default `cinematic`; `pov` keeps added runs in first person) |
| `pick`, `views`, `adjusted` | With `cinema`: open Add run or the view menu, or show Reset view after a camera adjustment |
| `parked=true`, `indexing` | Show Return to server, or partial native indexing reach |
| `locs=<0–20>`, `at=<tick>`, `speed=<0.25–8>` | With `state=watching`: locs on the timeline (default 3), the start position and the speed |
| `notice=saved\|full\|<text>` | With `state=watching`: a control notice, as after saving a loc |
| `title=other` | With `state=watching`: someone else's replay (no run, so Runs opens on the current map) |
| `binds=custom\|none` | With `state=watching`: the game's saveloc binds (custom puts extras on the mouse and wheel; default F5 / F9) |
| `pop=keys\|speed` | With `state=watching`: opens the keyboard sheet or the speed picker |
| `runs[=<map key>]` | Opens the Runs panel on the current map (`utopia:3`) or another: `kitsune:1` (stages, long lists), `mesa:2` (no finish yet), `boreas:2`. With `state=watching` it opens over the replay bar |
| `maps`, `view=ramps` | With `runs`: opens the map list, or the Ramps view |
| `stat=recent\|average`, `expand=<n>`, `reset` | With `view=ramps`: the Last 10 or Average statistic, the nth ramp opened, or the Reset averages confirmation |
| `bail=none` | With `view=ramps`: Utopia's Ramp 6 without its bail, so no ramp runs past the bar scale |
| `touch=few\|none` | With `view=ramps`: touch stats from 23 runs, or with no runs recorded yet (`mesa:2` always has few) |
| `pb=official\|partial` | A leaderboard PB on the current map (`partial`: only its first split) |
| `ref=loading\|missing\|pb\|none` | The Ramps view's PB and WR references on the current map (default: both ready) |
| `history=empty` | No runs on any map; add `set.keepHistory=false` for the recording-off empty state |
| `preview=running\|error` | Starts the strafe preview, so its indicator shows; `error` with `panel=controls` presses Start and shows why it can't start |
| `set.<key>=<value>` | Any other setting, e.g. `set.showBoard=false` |
| `css=<rules>` | Extra CSS in the HUD's shadow root, for A/B experiments |
| `shot` | Hides the picker for screenshots |

The checkpoint clock is frozen, so splits stay on screen. The energy states drive the real energy trend with a session gaining or losing 140 u/s per second.

## Screenshots of every state

```sh
PUPPETEER=<puppeteer ESM entry or package> CHROME=<chrome.exe> bun dev/shoot.js [outDir]
```

Writes the HUD states, each settings section, Runs panel (overview and Ramps), native transport/extras and custom replay bar at desktop and narrow sizes into `outDir` (default: `<tmp>/surfd-qol-shots`). Includes native ramp hover, idle, indexing, Return to server and custom keyboard-sheet scenarios. Puppeteer is not a project dependency.

`docs/hud.jpg` and `docs/hud-full.jpg` use `?shot&state=checkpoint&bg=warm&scale=1.6&y=72`, with `&set.surfHud=full` for the full view. Both use the default combined Surf feedback; compact value labels are enabled. `docs/hud-energy.jpg` uses the same framing with `state=energy-loss`, `set.surfHud=full` and `set.speedEnergyColor=true`; its tint comes from the real energy model. Capture at a 1440×810 viewport with device scale 1 as JPEGs at quality 88. Values are examples, not measurements from the backdrop's run.

`docs/replay-custom.jpg` uses `?shot&state=watching&bg=warm&title=other&play=paused&y=60`, and `docs/replay-native.jpg` adds `&set.customReplayUi=false`, each at a 1100×1000 viewport with device scale 2, clipped to the bottom 120 px (x 0, y 880, 1100×120, so 2200×240) and saved as JPEG at quality 88. `y=60` lifts the HUD out of the strip, and the tall viewport crops the backdrop's key display out of it.

`docs/cinematic.jpg` and `docs/cinematic-custom.jpg` come from the real game, not the harness: the Fiellu leaderboard record paused at command 3300, with the KSF WR and leaderboard #2–#4 added in Cinematic. The 1440×810 pair shares its camera, playback index and crop; only `customReplayUi` changes.

## Cinematic performance checks

The harness does not measure replay simulation or GPU compilation. The cinematic tests run offline; real-game profiling is a separate manual check:

- Measure the first visible cinematic frame separately from full preparation, reopening the same replay, and switching to an already-planned style. Recording publishes an actual prefix after releasing its physics observer. Initial planning uses a window with six seconds of future context and up to six seconds of history, aligned to four ticks; this provisional shot can differ from the final plan. Path geometry grows geometrically, not on every physics batch. Only complete tracks and plans enter the weak replay/map/world cache.
- Hold late recording work and confirm the early window still draws. Seek outside it and check for native POV, never a clamped stale shot; release recording and verify full-plan handoff without a position jump. Ghost/path indices stay on the replay clock; only camera-plan sampling subtracts the window base. Cancel or select POV during recording and check that late results cannot restore the camera. Hold an added run's download and processing separately: neither should delay solo activation.
- On a browser with `KHR_parallel_shader_compile`, new scene objects stay outside the live map while their shaders prepare, then remain hidden until a positioned frame. Compilation overlaps planning and waits only on the submitted materials' program variants, not unrelated map programs. Ordinary recording-prefix growth during initial compilation must not repeatedly replace the scene and restart that wait; regional/retimed updates still take effect immediately. The hook owns cancellable readiness polling rather than using the uncancellable `compileAsync()` wait. Check that POV keeps drawing, disposal stops polling, and renderer replacement does not wait for an obsolete compiler. Without that capability, no precompilation is attempted.
- The camera can reuse the native collision BVH when the expected public arrays and query interface are present. Its filtered view preserves candidate order and collision flags and shares native triangle convexes, whose vertices, bounds and SAT planes do not depend on camera visibility or the probe hull. Incompatible implementations use the constructor path. Compare hit fractions, normals and solid-state results, not generated triangle-brush object identity.
- Camera planning consumes available idle time between bounded trace batches and still checks cancellation. Segment travel windows are scanned linearly; shot-independent blurs are reused during safe-shot replanning. Matching retains Float32 costs and the existing DTW tie-breaking.

## Map preparation checks

- Measure input-ready map entry separately from `view.__qolAssetsReady` and `view.__qolGpuReady`, where `view` is the native map-renderer adapter. GPU readiness reports `uploadsComplete`, `shadersComplete` and `completion`; only supported shader-completion and fence APIs can produce `completion: 'gpu-complete'`. Background preparation must not delay entry.
- Hold a required first-view texture and check that its priority is raised before ramp preprocessing. Selected shader variants may prepare during the wait on supported drivers; unrelated objects must not compile. Disabled native sampler uniforms must not block entry, while active environment/normal-alpha-mask samplers still do. Unknown shaders remain conservative.
- Compare worker sky pixels against synchronous conversion for mixed dimensions, transforms and transparent pixels. Hold the sky result: construction and the visibility probe may finish, but no real first-view draw may use unconverted faces. Block Worker/CSP or OffscreenCanvas support and check synchronous fallback. Abort before and after worker completion; late results must not publish or detach the native images.
- Hold the existing player-atlas response, enter a map and watch a replay while GPU preparation remains pending. Replace the map before releasing the response: the obsolete promise must reject, and the new view must finish independently after release. Check optional atlas failure, renderer disposal and context loss without changing native fallback behavior.
- After readiness, seek to distant replay positions and count map buffer uploads and shader links separately from dynamic buffer updates, changing canvas labels and newly created player/cinematic variants. Check PVS changes and sky instance matrices/light offsets: idle uploads must not suppress the next native frame's updates. The background queue must never render, clear a framebuffer or alter instance counts for a hidden all-map draw.
- Exercise quality changes during preparation, unsupported parallel-compilation/sync APIs, detached scene roots and disposed resources. Compare actual native replay states, timer results, ordered collision candidates and trace results when changing preprocessing; passing unit tests alone is not a physics-parity check.

## Fonts

`src/hud-fonts.js` embeds Instrument Sans (SIL OFL 1.1), subset to the characters the HUD and panel use. Regenerate with `python dev/subset-fonts.py <folder with InstrumentSans-*.ttf>` (needs fontTools).
