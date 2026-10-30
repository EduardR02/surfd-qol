# HUD harness

Renders the real HUD, settings panel, Runs panel and replay extras/custom bar (`src/hud.js`, `src/hud-model.js`, the views and styles) with fixture data over screenshots from actual Surfd replays. Only the game session, replay-reference loaders, run history, ramp references, saveloc binds and playback are faked (`dev/fixtures.js`). Native replay uses the actual transport structure and shipping `rt-*` stylesheet in `dev/native-transport.js` / `dev/native-transport.css`; its controller is a fixture, not the game engine.

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
| `set.customReplayUi=true` | Opt into the existing custom bar; otherwise native transport plus graded touch marks, saved locs and tools is shown |
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

`docs/hud-full.jpg` is `?shot&state=checkpoint&bg=fog&set.surfHud=full` at a 1920×1080 viewport with device scale 0.75 (1440×810), saved as JPEG at quality 88.

`docs/replay-native.jpg` is `?shot&state=watching&bg=warm&title=other&play=paused&y=60` and `docs/replay-custom.jpg` the same with `&set.customReplayUi=true`, each at a 1100×1000 viewport with device scale 2, clipped to the bottom 120 px (x 0, y 880, 1100×120, so 2200×240) and saved as JPEG at quality 88. `y=60` lifts the HUD out of the strip, and the tall viewport crops the backdrop's key display out of it.

## Fonts

`src/hud-fonts.js` embeds Instrument Sans (SIL OFL 1.1), subset to the characters the HUD and panel use. Regenerate with `python dev/subset-fonts.py <folder with InstrumentSans-*.ttf>` (needs fontTools).
