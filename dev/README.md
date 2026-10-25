# HUD harness

Renders the real HUD, settings panel, Runs panel and replay bar (`src/hud.js`, `src/hud-model.js`, the views and styles) with fixture data over screenshots from actual Surfd replays. Only the game session, the replay-reference loaders, run history, ramp references, saveloc binds and replay playback are faked (`dev/fixtures.js`, in the exact shapes `src/run-history.js`, `src/ramp-reference.js` and `src/replay-control.js` hand to the UI), so what you see here is what ships.

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
| `play=playing\|paused\|ended` | With `state=watching`: the playback state (default `playing`, and the playhead moves; `ended` holds on the last frame). Left alone for about 3 s while playing, everything but the timeline fades |
| `locs=<0–20>`, `at=<tick>`, `speed=<0.25–4>` | With `state=watching`: locs on the timeline (default 3), the start position and the speed |
| `notice=saved\|full\|<text>` | With `state=watching`: a control notice, as after saving a loc |
| `title=other` | With `state=watching`: someone else's replay (no run, so Runs opens on the current map) |
| `binds=custom\|none` | With `state=watching`: the game's saveloc binds (custom puts extras on the mouse and wheel; default F5 / F9) |
| `pop=keys\|speed` | With `state=watching`: opens the keyboard sheet or the speed picker |
| `runs[=<map key>]` | Opens the Runs panel on the current map (`utopia:3`) or another: `kitsune:1` (stages, long lists), `mesa:2` (no finish yet), `boreas:2`. With `state=watching` it opens over the replay bar |
| `maps`, `view=ramps` | With `runs`: opens the map list, or the Ramps view |
| `stat=recent\|average`, `expand=<n>`, `reset` | With `view=ramps`: the Last 10 or Average statistic, the nth ramp's other replays opened, or the Reset averages confirmation |
| `pb=official\|partial` | A leaderboard PB on the current map (`partial`: only its first split) |
| `ref=loading\|missing\|pb\|none` | The Ramps view's PB and WR references on the current map (default: both ready) |
| `history=empty` | No runs on any map; add `set.keepHistory=false` for the recording-off empty state |
| `set.<key>=<value>` | Any other setting, e.g. `set.showBoard=false` |
| `css=<rules>` | Extra CSS in the HUD's shadow root, for A/B experiments |
| `shot` | Hides the picker for screenshots |

The checkpoint clock is frozen, so splits stay on screen. The energy states drive the real energy trend with a session gaining or losing 140 u/s per second.

## Screenshots of every state

```sh
PUPPETEER=<puppeteer ESM entry or package> CHROME=<chrome.exe> bun dev/shoot.js [outDir]
```

Writes the HUD states, each settings section, the Runs panel (overview and Ramps) and the replay bar at 1920×1080, 700×900 and 540×600 into `outDir` (default: `<tmp>/surfd-qol-shots`). Puppeteer is not a project dependency.

## Fonts

`src/hud-fonts.js` embeds Instrument Sans (SIL OFL 1.1), subset to the characters the HUD and panel use. Regenerate with `python dev/subset-fonts.py <folder with InstrumentSans-*.ttf>` (needs fontTools).
