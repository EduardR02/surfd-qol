# HUD harness

Renders the real HUD and settings panel (`src/hud.js`, `src/hud-model.js`, the views and styles) with fixture data over screenshots from actual Surfd replays. Only the game session and the replay-reference loaders are faked, so what you see here is what ships.

The backdrops are not in the repository (they are screenshots of the game). Save your own 1920×1080 JPEG captures as `dev/backdrops/<name>.jpg` for `snow`, `fog`, `ice`, `neon`, `warm`, `dark` and `menu`; the folder is gitignored. Without them the harness draws a plain gradient sky.

```sh
bun dev/serve.js            # http://127.0.0.1:5178/dev/
```

Pick a state and backdrop from the bottom-left menus, or use the URL:

| Parameter | Values |
| --- | --- |
| `state` | `ramp`, `air` (stale Up), `net`, `sole`, `pair`, `none`, `unavailable`, `live`, `start-good`, `start-bad`, `checkpoint`, `checkpoint-start`, `practice`, `replay`, `invalid`, `spectating`, `energy-good`, `energy-loss`, `energy-neutral`, `menu` |
| `bg` | `snow`, `fog`, `ice`, `neon`, `warm`, `dark`, `menu` |
| `scale`, `y`, `opacity` | Layout settings, e.g. `scale=1.6&y=10` |
| `palette=custom` | A non-default palette |
| `panel=display\|feedback\|compare\|controls` | Opens the settings panel on that section |
| `runs=session\|map` | Opens the Runs popup with fixture history on that scope; add `expand=fixture-6` to open a run |
| `set.<key>=<value>` | Any other setting, e.g. `set.showBoard=false` |
| `css=<rules>` | Extra CSS in the HUD's shadow root, for A/B experiments |
| `shot` | Hides the picker for screenshots |

The checkpoint clock is frozen, so splits stay on screen. The energy states drive the real energy trend with a session gaining or losing 140 u/s per second.

## Screenshots of every state

```sh
PUPPETEER=<puppeteer ESM entry or package> CHROME=<chrome.exe> bun dev/shoot.js [outDir]
```

Writes the HUD states and each settings section at 1920×1080 and 540×600 into `outDir` (default: `<tmp>/surfd-qol-shots`). Puppeteer is not a project dependency.

## Fonts

`src/hud-fonts.js` embeds Instrument Sans (SIL OFL 1.1), subset to the characters the HUD and panel use. Regenerate with `python dev/subset-fonts.py <folder with InstrumentSans-*.ttf>` (needs fontTools).
