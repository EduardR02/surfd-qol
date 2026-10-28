# Private rooms: the room protocol

A private room is hosted by a player's own browser tab. The extension swaps the game's room WebSocket for its own socket when the room id is private, and the host tab answers in the game's protocol, so the game's lobby, roster, chat, spectating and map changes work unchanged. This is the reference for that protocol as the game's client uses it.

Code: `src/private-rooms/` (`host.js` the room, `protocol.js` the codecs, `socket.js` the sockets, `index.js` the wiring) and the `roomHooks` in `extension/instrument.js`.

The game's client validates binary frames strictly but consumes most JSON fields directly; what follows is what it reads. When the game updates, find the code again by these literals: `"surfd-v1"`, `"/servers/"`, `"Invalid spectator header"`, `"Changing map…"`, `"You were invited to"`.

## Ids and joining

Room ids are `p-` and 12 characters of `abcdefghjkmnpqrstuvwxyz23456789` (no 0, 1, i, l or o), random and unguessable. Public room ids (`eu`, `na`, `eut3`, …) never match.

The game joins rooms from its server list. Public rooms come from the meeting point's directory; private rooms appear only for their host or someone holding an invite (`?join=<id>` highlights the row but doesn't join). Community rows carry `visibility: "public" | "private"`, their player count, `endsAt: 0`, `untimed: true`, and a measured ping when available. They have no player cap and never take part in the game's Play now recommendation.

Before the game's own messages, each joining client sends the host an extension-only hello: `{name, appearance, guest}` (no tokens). The host trims the name to 24 characters and falls back to the default appearance when it's invalid.

The host connects to the meeting point with `role=host` and a key from `newHostKey()`. A guest's `role=guest` connection carries its `room-info` request and WebRTC offer/answer/ICE exchange, then closes when the peer connection opens. Leaving the meeting point does not leave the room.

Public hosts send `listing` with `{name, mapId, mapTitle, players}` when the row changes and at least every 30 seconds; `listing` with `null` makes the room private. `GET /rooms` returns `{rooms:[{id,name,mapId,mapTitle,players,updatedAt}]}`. The directory is fetched only while the server browser is open, at most once every 10 seconds.

The room UI observes only the server browser and, in a community room, its room-menu controls. A hidden browser observes only its own visibility attributes; HUD mutations do not refresh room UI.

Guest names are `Guest_` plus five lowercase hex characters, kept in localStorage. Signed-in players use their username. The host's room name is `<name>'s room`.

## Shared structures

**Appearance:** `{title, titleColor, nameColor, revision}`. `title` is at most 24 characters of letters, digits, space and `_.'!?-`; the colours are `null` or `#RRGGBB`; `revision` is a non-negative integer. The default is `{title: "", titleColor: null, nameColor: null, revision: 0}`.

**Player:** `{id, connectionId, slot, name, rank, points, guest, moderator, appearance, spectating}`.
- `id` drives mutes, own-player checks and chat senders; `connectionId` tells live connections apart and picks spectator targets; `slot` (a unique uint16) picks the interpolation buffer for binary poses.
- A freed slot is reused with a new `connectionId`, which makes the game clear the old buffer.
- In private rooms: `id` is `private-<connectionId>`, `rank` is `"Guest"`, `points` 0, only the host has `moderator: true`, and **every player has `guest: false`**. The game refuses to send chat for guests and shows map controls only for moderators who aren't guests; the flag changes nothing on the site.

**State:** the game reads `mapId`, `epoch`, `endsAt`, `recent`, `nominations`, `vote` and `nextMap`. A community room sends `{roomId, name, visibility, mapId, mapTitle, epoch, startedAt, endsAt: 0, untimed: true, recent: [], nominations: {}, rtv: [], vote: null, nextMap: null}`. `visibility` is `"public"` or `"private"`; changing it broadcasts `state` without changing the epoch. `epoch` starts at 1 and goes up when the host changes the map; `recent` keeps up to 8 earlier maps. On its own, `endsAt: 0` would read "Changing map…", which is why the countdown hook checks `untimed`.

## Client → room

| Message | Fields | Private host |
| --- | --- | --- |
| `ping` (plain text) | sent every 15 s; the reply measures ping | answers `pong` |
| `chat` | `text`, trimmed and limited to 240 characters by the host | broadcasts to everyone, sender included, with the sender's fields |
| `change-map` | `mapId` from the game's catalog | host only, to a different known map: new epoch, `state` to all |
| `spectate` | `connectionId` or `null` to stop, `request` (increasing integer) | refuses self, missing or already-spectating targets with an `error` carrying `spectatorRequest` |
| `context` | none; the game waits up to 2.5 s for it when a map starts | answers `{type: "context", epoch, token: null}` (no ranked context) |
| `refresh`, `ack`, `activity` | ticket refresh, `check` reply, activity tracking | ignored |
| `rtv`, `nominate`, `vote`, `extend` | map votes | ignored |
| `query`, `report`, `reports`, `moderate` | public server services | ignored |

## Room → client

| Message | Fields and what the game does with them |
| --- | --- |
| `pong` (plain text) | updates the ping display |
| `welcome` | `{state, player, players, maps, serverTime, spectatorStream, playtime, activityTracking, recentResults?, chatMute?}`. Sets the own player, roster and state and loads the map. Private: `spectatorStream: true`, `playtime` and `activityTracking` false, `recentResults: []`, `chatMute: null`. |
| `state` | `{state, serverTime}`. Lower epochs are ignored; a new epoch clears pose and spectator buffers, so the host republishes spectator demand after a map change. |
| `roster` | `{players}`. Replaces the roster and clears buffers of slots that changed hands. |
| `chat` | `{playerId, name, text, rank?, appearance?}` (flat fields, not a `sender` object) |
| `notice`, `error` | `{text, spectatorRequest?}`. Shown in chat; an `error` matching the current spectate request stops spectating. |
| `spectator-demand` | `{active, count}`; `count` is 0–65535 and positive exactly when `active`. Tells a player to stream detailed frames. |
| `context` | `{epoch, token}`; private `token` is always `null` |
| `result` | a finished run (phase 3), below |
| `check`, `afk-warning`, `chat-status`, `reports` | public server features; never sent by a private room |

**Result** (phase 3): `{result}` with `id` (deduplication), `userId`, `name`, `rank`, `mapId`, `mapTitle`, `timeUs`, `record`, `personalBest`, `previousBestUs`, `pointsDelta`, `promoted`, and optionally `leaderboardRank`, `leaderboardTotal` and `stageRecords` (`[{stage, timeUs, previousRecordUs}]`, at most 64). `record` outranks `personalBest` in the text and sound; leaderboard text needs `0 < leaderboardRank <= leaderboardTotal`.

Control frames stay within 65,536 bytes. Larger JSON messages use sequential `{type:"room-chunk",data,final}` frames on the reliable channel; `data` holds part of the original JSON string and `final:true` completes it. The room-client hook assembles the message before applying it.

## Binary frames

Little-endian, version byte 1, ArrayBuffers (set `binaryType = "arraybuffer"` on every receiving socket; the default `blob` breaks the JSON/binary split). A frame whose epoch isn't the room's current one is dropped.

**Compact pose, 32 bytes**

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | uint32 | `time`, sender timestamp mod 2^32 |
| 4, 8, 12 | float32 | `x`, `y`, `z`, finite, \|v\| ≤ 131072 |
| 16, 18, 20 | int16 | `vx`, `vy`, `vz`, rounded, -32768 invalid |
| 22 | uint16 | `yaw`: `round(yaw mod 360 / 360 × 65535)` |
| 24 | int16 | `pitch`: `round(pitch / 90 × 32767)`, -32768 invalid |
| 26 | uint8 | flags 0–63: grounded 1, crouched 2, teleport 4, practice 8, idle 16, finished 32 |
| 27 | uint8 | reserved, 0 |
| 28 | float32 | `seconds`, timer, 0–86400 |

**Type 1, client pose batch** (44 or 76 bytes): version, type 1, sample count (1 or 2), reserved 0, uint32 sequence, uint32 epoch, then the poses. The game samples at most every 49 ms, usually sends pairs, and closes its socket with 4013 when more than 64 KB is buffered.

**Type 2, room snapshot** (4–7804 bytes): version, type 2, uint16 block count (0–100), then per block a 14-byte header (uint16 slot, uint32 sequence, uint32 epoch, uint8 sample count 1–2, uint8 and uint16 reserved 0) and its poses. Duplicate slots or trailing bytes are invalid. The host keeps each sender's latest upload and bundles the blocks for each recipient about every 50 ms, excluding that recipient. More than 100 blocks are split across snapshots. Pose bytes stay unchanged. The game keeps up to 12 samples per player, drops samples over 250 ms behind the newest, and extrapolates at most 100 ms.

**Types 3 and 4, spectator frames** (56 bytes; 3 uploaded, 4 forwarded):

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | uint8 | version 1 |
| 1 | uint8 | 3 or 4 |
| 2 | uint16 | slot (0 from the sender; the host writes the sender's) |
| 4 | uint32 | spectator sequence, separate from pose sequences |
| 8 | uint32 | epoch |
| 12 | 32 bytes | compact pose |
| 44 | float32 | `eyeHeight`, 0–128 |
| 48 | uint8 | phase: 0 ready, 1 running, 2 finished |
| 49 | uint8 | `untimed`, 0 or 1 |
| 50, 52 | uint16 | `checkpoints`, `stage`, 0–1024 |
| 54 | uint8 | 0 = no inputs; else bit 7 set, bit 6 clear, low 6 bits held inputs (w 1, a 2, s 4, d 8, jump 16, duck 32) |
| 55 | uint8 | presses since the last frame, 0–63; 0 when byte 54 is 0 |

A player streams these at about 30 Hz while `spectator-demand` is active for them. The host rewrites only the type and slot and forwards each frame to that player's watchers alone. When a watcher leaves or switches, or the target leaves, demand and roster `spectating` are updated.

## Closing

The game treats 4002, 4004, 4008 and 4009 as final and shows the reason without retrying; other unexpected closes retry six times with backoff. The private host uses 4002 for invalid data and 4004 when the room is gone. The game itself closes with 4000 (no welcome within 10 s), 4013 (too much buffered), 4003 (session refresh) and 1000 (leaving).

A replacement host loopback removes the old host connection without ending the room. Explicit Leave and `pagehide` close the room. When a guest's peer connection drops without a close message, the guest asks the meeting point: if the room is gone, it closes with 4004; otherwise it reconnects through the meeting point. Closing a guest's meeting point socket after negotiation doesn't affect its peer connection.

The runtime heartbeat exists only while hosting and is cleared on leave, host replacement and startup failure. Attaching room hooks or joining as a guest does not create a runtime interval.

## Testing safely

Test as a guest, without finishing runs. The game prepares `guest-attempt` tickets on its own, even before a finish, so block the attempt, upload and claim endpoints before the first page load when testing in a browser.
