# Surfd QoL

![Surfd QoL's HUD on Utopia: speed, timer and sync, and board, down and up values for the last ramp](docs/hud.jpg)

*What it looks like most of the time. Each part can be shown or hidden on its own.*

A Chrome extension for [surfd.net](https://surfd.net/) that shows where you lose speed, on each ramp and in the air, so you can find your mistakes and see what an optimal run does differently. It also adds start stats, PB and WR checkpoint splits, a crouch-jump bind and nullbinds.

Everything on the HUD can be configured or turned off. The code is plain JavaScript with no dependencies, so it's easy to change or extend yourself, or with your own coding agent. It never changes physics, maps or your runs: it watches the game's own movement code and reports what happened.

**Download page: [eduardr02.github.io/surfd-qol](https://eduardr02.github.io/surfd-qol/)**

## Install

You need desktop Chrome 118 or newer. The extension isn't on the Chrome Web Store, so you load it yourself:

1. Download [surfd-qol.zip](https://github.com/EduardR02/surfd-qol/releases/latest/download/surfd-qol.zip) and unzip it somewhere it can stay. Chrome loads the extension from that folder every time.
2. Open `chrome://extensions` and switch on **Developer mode** (top right).
3. Click **Load unpacked** and pick the unzipped folder (the one containing `manifest.json`).
4. Open [surfd.net](https://surfd.net/). The tab reloads once while the extension hooks in. Settings are under **QoL**, bottom right of the game menu, next to the notification bell. Changes save automatically.

**Updating:** download the new zip, replace the folder's contents, then click the reload icon on the extension in `chrome://extensions` and reload Surfd. Your settings stay.

### About the "started debugging this browser" bar

Chrome shows this bar because the extension uses the debugger permission to patch the game script as it loads. That is the only way to reach the game's private physics objects. It only attaches to surfd.net's game page and only touches `assets/game-*.js`.

You can close the bar with × or **Cancel**. Everything already loaded keeps working, including the binds, until you reload the page. The toolbar badge shows **ON** when the extension is active on the page and **!** if setup failed or the bar was closed before setup finished. Click the toolbar button to reconnect; that reloads the tab, so do it between runs. The bar comes back after each reload.

## What you get

### The HUD

Speed sits big on the centre line of the screen, with the timer and strafe sync just above it. Run labels only appear when they matter (PRACTICE, REPLAY, INVALID, SPECTATING); a normal ranked run shows none. Size, height, opacity and all colors are adjustable, and the HUD uses its own bundled font (Instrument Sans), so nothing is fetched from the web. The HUD hides in menus, loading screens and dialogs, and stays up for replays and spectating.

Under the speed is a row of up to three feedback values, all in u/s. Each one stays until the next one replaces it, so you can glance at it in the air instead of mid-ramp.

| Value | What it measures |
|---|---|
| **BOARD** | Speed clipped off when you land on a ramp. Pure collision loss: height conversion doesn't count. Quick re-touches during the landing count as part of the same board. |
| **DOWN** | What the ramp cost you on the way down, from the moment you boarded (so it includes the board) to the lowest point you touched. |
| **UP** | What it cost you from the lowest point to where you left the ramp: the turn up and the exit. |
| **AIR** | Your last flight between ramps: speed lost to air braking plus gain missed by imperfect strafes. You can show either part on its own. |

Down and Up are measured against perfect gravity-only conversion. If you board at 2500 u/s and leave lower or higher, the height change is converted back to speed before comparing, so climbing a ramp is never counted as a loss. **Down + Up equals the whole-ramp loss exactly.** Prefer one number per ramp? Set **Ramp result** to **Net** to show a single SURF value instead.

Don't chase zero. Ramp surfing always bleeds some speed; on Cannonball's second ramp the KSF record still loses 34 u/s going down and 16 coming up. That's why the useful comparison is against a reference run, which is the default.

The three sit in ramp order: board, down, up. AIR shares the middle slot with DOWN: when you land on the next ramp, the flight you just finished replaces the previous ramp's DOWN, and UP turns grey because it now belongs to the previous ramp. Turn any of them off and the rest re-centre.

### Colors

Board and the ramp values compare against the same ramp in a reference run, matched by ramp, checkpoint and visit:

- **teal**: as good as the reference or better
- **gold**: worse, but within the near-reference margin (2 u/s by default)
- **red**: worse than that
- **grey**: no matching data (reference still loading, different route, or no PB on this map)

The reference can be your PB replay or the WR. "WR" means the KSF record route (the site's "Watch the record route") by default, or Surfd's leaderboard #1. You can also switch any value to fixed cutoffs. Air always uses fixed cutoffs, since there's no meaningful per-flight reference.

A worse number is a measurement, not proof of a mistake. A different line or entry speed changes it too.

### Start

For 1.8 seconds after you leave the start zone you see your exit **speed** (350 is the airborne cap, 325 grounded) and your **height** above the start platform (lower is better; crouching doesn't fake it). Grade it against fixed targets, your PB or the WR.

### Checkpoints

At each checkpoint you get your split time and speed, plus time and speed deltas against your PB, the WR, or both. The reference comes from the full replay, never per-checkpoint bests.

![The full HUD on Boreas just after a checkpoint: split time and speed against the KSF record above the timer, and board, down and up values below](docs/hud-full.jpg)

*The full HUD, just after a checkpoint.*

### Binds

- **Crouch-jump** (off by default; turn it on under **Controls**, Space unless you rebind it): holding jump presses crouch for exactly one physics tick per jump. That's enough for the crouched jump impulse (+6 u/s vertical, the same as holding crouch) without staying crouched. Rebind it to any free key.
- **Nullbinds** (off by default): for A/D and for W/Space, the newest key you press wins, and releasing it hands control back to the other key if it's still held. W/Space cuts forward input while Space wins (not your momentum) and blocks jump while W wins.

Both work inside the game's own input sampling, so the commands it records are exactly what you'd get from a keyboard that did this in hardware. Your binds on disk aren't changed.

### Run history

**Runs**, next to **QoL** in the menu, opens a summary of your runs: count, best and average finish, start speed and average sync, then one row per run with its time, result (finished, or reset at which checkpoint), start speed, sync, total board, ramp and air loss, and top speed. Click a run to see its checkpoint splits and speeds against the best finish in the list, and Board, Down and Up for every ramp.

**This session** lists the runs since the page loaded, on any map; **This map** lists every saved run on the current map. Practice and invalid runs are marked and never count as best. Restarts within the first second aren't recorded, and replays never are. The loss totals only include values the HUD was measuring, so a value you had hidden shows —.

### Watching replays

**Watch** in the Runs list replays one of your runs in the game's own replay mode, with the full HUD, starting a second before you left the start. The same controls appear for every replay the game plays: other players' runs from the leaderboard's **Watch** buttons, the record route and server replays.

The bar along the bottom says what you're watching and whether it's playing. Under it:

- **Play/pause** and **−5 s / +5 s**, then a timeline you can drag. It marks where the run left the start and each checkpoint (on other players' runs these fill in as the replay passes them).
- **Speed** from 0.25× to 4×.
- **Savelocs**: **Save loc** marks the moment you're watching, **Load loc** jumps back to the selected one, and each loc is a chip you can click or delete. They use your own **Save position** and **Load position** binds (F5 and F9 by default; previous/next saveloc step through them), and during a replay those binds only work on these locs. Locs are kept with your own runs and last until you leave anyone else's replay.
- Every loc you save is **also added to your practice savelocs** when you leave the replay, so you can load it and play from there. **Practice from here** does it in one go: it leaves the replay and puts you at that exact moment, with the same speed and view, in practice mode. This works for any replay, including ones recorded under older movement rules: a loc is only position, speed, view and timer, and you play on under today's rules. Locs from another map wait until you're back on that map.

**Keys** lists every shortcut: Space plays and pauses, ← and → jump 5 seconds, `,` and `.` step one tick, `[` and `]` change speed, and Esc stops playback as usual. Replays of the last 30 runs on each map, plus your best, are kept in the browser.

### What's kept

Under **QoL → History** you can turn **Record runs** off entirely (nothing is tracked while it’s off), and choose how much is stored: runs kept per map (100 by default), how many maps keep a history (the 20 played most recently), how many sessions (visits) to keep (all by default), whether to save replays at all, how many per map (30), and whether each map's best always stays. It also shows how much space history and replays use, with a button to clear everything. Lowering a limit deletes whatever is over it, and a run that's dropped takes its replay with it. Runs and replays are kept in the extension's own IndexedDB database on surfd.net, not in the game's local storage; replays are compressed to about 50 KB per minute of run.

### Replays and spectating

Replays get full feedback, plus a **Hull: crouched / standing** line in the game's key display, so you can see when the player is surfing crouched after letting go of crouch. Spectating shows speed, time and checkpoint progress only, since network updates don't carry enough data for exact feedback.

### Optional extras

- **Live feedback** (off by default): the values update continuously instead of holding. Meant for watching replays, not for runs.
- **Tint speed by energy** (experimental, off by default): the speed number turns teal while you gain units and red while you lose them. It tracks speed and height together, so falling or climbing doesn't count, only strafe gains, braking, clips and friction do. Ramps are excluded unless you enable **Include ramps**, because surfing a ramp always bleeds some energy and would read red almost all the time.

## Is it safe for ranked runs?

The extension doesn't change physics, collision, timing or replays, and it doesn't submit anything. The binds change which keys count as pressed, just like keyboard software would; the result is recorded in your replay as normal input. Whether the leaderboard accepts runs made with binds is up to Surfd; see [Surfd's terms](https://surfd.net/terms.html).

## Performance and privacy

- Anything you hide is not computed. With the HUD off, or Board, Air and Ramp all off, the extension skips movement analysis entirely. PB/WR replays are only downloaded and re-simulated while a comparison that uses them is visible, and each replay is processed once and cached.
- The speed counter updates at 60 FPS and the timer at 30 FPS by default, so digits stay readable. You can change both; the game itself stays uncapped.
- No telemetry. Settings, run history, replays of your runs and local checkpoint PB speeds live in surfd.net's site storage in your browser; clearing site data removes them. The only network requests are replay downloads from surfd.net.

## Troubleshooting

- **No custom HUD:** check the badge. **!** means setup failed; click the toolbar button to reload. If Surfd shipped an update the extension doesn't recognise, it stays out of the way and the game's own HUD remains.
- **Everything grey:** the reference is still loading, you have no PB on this map, or your route visits ramps in a different order than the reference.
- **A value shows —:** nothing measured yet this run, the contact was ambiguous (e.g. ramp and wall at once), or the value was hidden for part of that ramp or flight. Flights with under 50 ms of strafing don't replace the previous AIR value at all.
- **The debugger bar keeps coming back:** expected after every reload; see above.

## Development

You only need [Bun](https://bun.sh) to work on the source; no other dependencies.

```sh
bun run build   # writes the unpacked extension to dist/
bun test
```

Load `dist/` with **Load unpacked** while developing. To publish a release, bump `version` in `extension/manifest.json`, commit, then push a matching tag (`git tag v1.0.1 && git push origin v1.0.1`). The release workflow tests, builds and attaches `surfd-qol.zip` to a GitHub release, which the download links always point at. The download page lives in `docs/` and is served by GitHub Pages; `dev/` has a harness for rendering HUD states (see `dev/README.md`).

Source layout:

- `extension/`: manifest, the background loader (debugger attach and script patching) and `instrument.js`, which appends an adapter to the game module.
- `src/metrics.js`: per-tick movement analysis (Board, Down/Up/Surf, Air, live feedback).
- `src/observer.js`: wraps the game's movement methods without changing their results.
- `src/hud-model.js`: decides what the HUD shows; `src/hud.js` renders it and the settings panel.
- `src/energy.js`: the speed tint's energy trend.
- `src/references.js`, `src/run-references.js`, `src/replay-store.js`: PB/WR replay download, native re-simulation and ramp matching.
- `src/run-history.js`, `src/runs-panel.js`: per-run stats recording and the Runs popup.
- `src/replay-archive.js`, `src/replay-control.js`, `src/replay-bar.js`: saved replays (IndexedDB), playback speed and seeking, and the replay controls.
- `src/start.js`, `src/bindings.js`, `src/settings.js`, `src/visibility.js`: start stats, binds, settings schema and HUD visibility rules.

## License

[MIT](LICENSE). The bundled HUD font, Instrument Sans, is under the [SIL Open Font License 1.1](docs/fonts/OFL.txt).
