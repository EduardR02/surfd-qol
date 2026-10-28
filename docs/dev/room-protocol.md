# Private rooms: the room protocol

A private room is hosted by a player's own browser tab. The extension swaps the game's room WebSocket for its own socket when the room id is private, and the host tab answers in the game's protocol, so the game's lobby, roster, chat, spectating and map changes work unchanged. This is the reference for that protocol as the game's client uses it.

Code: `src/private-rooms/` (`host.js` the room, `protocol.js` the codecs, `socket.js` the sockets, `index.js` the wiring) and the `roomHooks` in `extension/instrument.js`.

The game's client validates binary frames strictly but consumes most JSON fields directly; what follows is what it reads. When the game updates, find the code again by these literals: `"surfd-v1"`, `"/servers/"`, `"Invalid spectator header"`, `"Changing map…"`, `"You were invited to"`.

The game trusts its server and puts some fields (a map's tier, for one) into markup unescaped, so guests rebuild every message from the host out of the fields listed here before the game sees it, dropping anything else. Map ids must be in the guest's own catalog, and titles and tiers come from that catalog, not the host. Invalid data closes with 4002.

## Ids and joining

Room ids are `p-` and 12 characters of `abcdefghjkmnpqrstuvwxyz23456789` (no 0, 1, i, l or o), random and unguessable. Official server ids (`eu`, `na`, `eut3`, …) never match.

`parseRoomCode` accepts these ids, twelve-character codes, or HTTPS invite links on `surfd.net/`. Typed codes ignore case, spaces and dashes; display codes use three groups of four capitals. Other origins, ambiguous characters and malformed codes are rejected before discovery.

The game joins rooms from its server list, where player-hosted rooms show under a Community tab. Public rooms come from the meeting point's directory; private rooms appear only for their host or someone holding an invite (`?join=<id>` highlights the row but doesn't join). Their rows carry `visibility: "public" | "private"`, their player count, `endsAt: 0`, `untimed: true`, and a measured ping when available; their map titles come from the player's own catalog. They show no capacity and never take part in the game's Play now recommendation.

Before the game's own messages, each joining client sends the host an extension-only hello: `{name, appearance, guest, userId, browserId}` (no tokens). `userId` is a signed-in player's public account id (a UUID) or `null`; `browserId` is a random UUID kept in localStorage, for bans. The host takes a signed-in player at their word; a guest whose name isn't a `Guest_` name, or a player whose name breaks the name rules below, joins as a guest with a new `Guest_` name. Invalid appearances fall back to the default.

A room holds at most 256 players, with one place kept for the host's own connection. The host refuses further joins with 4008 "This room is full.", and guests refuse rosters of more than 256 players.

Hosting needs a surfd.net account, as the game's moderators always have one: a guest's Host a room opens the game's sign-in, and signing out while hosting ends the room for everyone with "The host closed the private room." The host's own player is a signed-in moderator.

The host connects to the meeting point with `role=host` and sends `{type: "auth", key}`, with a key from `newHostKey()`, as its first message; the key never goes in the URL. A guest's `role=guest` connection carries its `room-info` request and WebRTC offer/answer/ICE exchange, then closes when the peer connection opens. Leaving the meeting point does not leave the room.
The host reconnects with its key after any unexpected meeting point close. Existing peer connections stay open. Hosts answer `room-info` at most once per peer every 5 seconds and accept at most 3 offers per peer per minute. At most 32 negotiations may be unfinished; a new one replaces the oldest. Unfinished negotiations expire after 15 seconds.

Every peer connection goes through Cloudflare's TURN relay, so no player sees another's IP address: `RTCPeerConnection` gets only the meeting point's TURN servers, with `iceTransportPolicy: "relay"`, and there is no direct fallback. The host asks for credentials with `ice-servers` once it has sent its key; a guest asks on its `role=guest` connection before it makes its offer. When the meeting point can't issue them (an error `no-relay`, or no answer within 10 seconds), hosting fails and a joining socket closes with 4000, both with "Couldn't reach the room service. Try again in a moment."; the game retries 4000. Credentials last `ttl` seconds (4 hours) and are renewed 15 minutes before they expire, retried every minute if that fails: a guest asks on a meeting point connection of its own, closed straight after, and the host on its own connection. New credentials restart ICE over the open control channel, where the guest always makes the offer:

| Control message | From | Meaning |
| --- | --- | --- |
| `{type: "restart"}` | host | the host renewed; the guest restarts ICE (at most 3 a minute, the rest ignored) |
| `{type: "offer", description}` | guest | an ICE restart offer; a host closes with 4002 past 3 a minute |
| `{type: "answer", description}` | host | its answer |
| `{type: "ice", candidate}` | either | a candidate gathered once the socket is open, sent after the description it belongs to |

Public hosts send `listing` with `{name, mapId, players}` when the row changes and at least every 30 seconds; `listing` with `null` makes the room private. `GET /rooms` returns `{rooms:[{id,name,mapId,players,updatedAt}]}`. The directory is fetched only while the server browser is open, at most once every 10 seconds, and rows the browser would refuse are skipped. A room whose name contains "surfd" or "official", in any case, can't be public.

Outside the server browser, hosting and being in a room, private rooms make no requests and run no timers. Invite lookups and directory fetches wait for the server browser and stop when it closes. A public host renews its listing every 30 seconds; relay credentials are renewed only while hosting or in a room; upload stats are sampled only while the host's own room is shown.

Names follow the site's username rules: 3–24 letters, digits, `_` or `-`. Guest names are `Guest_` plus five lowercase hex characters, kept in localStorage. Signed-in players use their username. The host's room name is `<name>'s room`. Guests refuse other player, chat and room names.

## Shared structures

**Appearance:** `{title, titleColor, nameColor, revision}`. `title` is at most 24 characters of letters, digits, space and `_.'!?-`; the colours are `null` or `#RRGGBB`; `revision` is a non-negative integer. The default is `{title: "", titleColor: null, nameColor: null, revision: 0}`.

**Player:** `{id, connectionId, slot, name, rank, points, guest, userId?, moderator, appearance, spectating}`.
- `id` drives mutes, own-player checks and chat senders; `connectionId` tells live connections apart and picks spectator targets; `slot` (a unique uint16) picks the interpolation buffer for binary poses.
- A freed slot is reused with a new `connectionId`, which makes the game clear the old buffer.
- In private rooms: `connectionId` is a UUID, `id` is `private-<connectionId>`, `rank` is `"Guest"`, `points` 0, only the host has `moderator: true` (guests accept at most one moderator, never themselves), and `guest` is the player's real status, as on official servers. Signed-in players may carry `userId`; guests never do.
- The game refuses to send chat for its own guest player, shows map controls only to moderators who aren't guests, and hides View profile, Add friend and Block for guests. Add friend sends a request by name. In private rooms View profile opens `userId` instead of `id`, and Block is hidden, as the room can't confirm who a player is.

**State:** the game reads `mapId`, `epoch`, `endsAt`, `recent`, `nominations`, `vote` and `nextMap`. A player-hosted room sends `{roomId, name, visibility, mapId, mapTitle, epoch, startedAt, endsAt: 0, untimed: true, recent: [], nominations: {}, rtv: [], vote: null, nextMap: null}`. `visibility` is `"public"` or `"private"`; changing it broadcasts `state` without changing the epoch. `epoch` starts at 1 and goes up when the host changes the map; `recent` keeps up to 8 earlier maps. On its own, `endsAt: 0` would read "Changing map…", which is why the countdown hook checks `untimed`.

## Client → room

| Message | Fields | Private host |
| --- | --- | --- |
| `ping` (plain text) | sent every 15 s; the reply measures ping | answers `pong` |
| `chat` | `text`, trimmed and limited to 240 characters by the host | refuses guests with an `error` "Sign in to send chat messages. You can still read chat."; otherwise broadcasts to everyone, sender included, with the sender's fields; 1 per second with bursts of 3, beyond which the sender gets one `error` "You're sending messages too fast." |
| `change-map` | `mapId` from the game's catalog | host only, to a different known map: new epoch, `state` to all |
| `spectate` | `connectionId` or `null` to stop, `request` (increasing integer) | refuses self, missing or already-spectating targets with an `error` carrying `spectatorRequest`; 2 per second with bursts of 4, beyond which requests are dropped |
| `context` | none; the game waits up to 2.5 s for it when a map starts | answers `{type: "context", epoch, token: null}` (no ranked context) |
| `refresh`, `ack`, `activity` | ticket refresh, `check` reply, activity tracking | ignored |
| `rtv`, `nominate`, `vote`, `extend` | map votes | ignored |
| `moderate` | `playerId`, `action` (`"kick"` or `"ban"`), `minutes` (the game sends 60) | host only, not on itself: closes the player with 4008 "You were kicked from this room." or "You were banned from this room for 1 hour." and sends everyone a `notice` "<name> was kicked." or "<name> was banned for 1 hour.". A ban refuses that `browserId` for an hour with 4008 "You're banned from this room for now." |
| `query`, `report`, `reports` | official server services | ignored |

## Room → client

| Message | Fields and what the game does with them |
| --- | --- |
| `pong` (plain text) | updates the ping display |
| `welcome` | `{state, player, players, maps, serverTime, spectatorStream, playtime, activityTracking, recentResults?, chatMute?}`. Sets the own player, roster and state and loads the map. Private: `spectatorStream: true`, `playtime` and `activityTracking` false, `recentResults: []`, `chatMute: null`. |
| `state` | `{state, serverTime}`. Lower epochs are ignored; a new epoch clears pose and spectator buffers, so the host republishes spectator demand after a map change. |
| `roster` | `{players}`. Replaces the roster and clears buffers of slots that changed hands. The private host sends at most one every 100 ms. |
| `chat` | `{playerId, name, text, rank?, appearance?}` (flat fields, not a `sender` object) |
| `notice`, `error` | `{text, spectatorRequest?}`. Shown in chat; an `error` matching the current spectate request stops spectating. Guests keep only the extension's own texts (`ROOM_TEXTS`): they drop other notices and give an `error` with `spectatorRequest` "That player is not available to spectate." |
| `spectator-demand` | `{active, count}`; `count` is 0–256 and positive exactly when `active`. Tells a player to stream detailed frames. |
| `context` | `{epoch, token}`; private `token` is always `null` |
| `result` | a finished run (phase 3), below |
| `check`, `afk-warning`, `chat-status`, `reports` | official server features; never sent by a private room |

**Result** (phase 3): `{result}` with `id` (deduplication), `userId`, `name`, `rank`, `mapId`, `mapTitle`, `timeUs`, `record`, `personalBest`, `previousBestUs`, `pointsDelta`, `promoted`, and optionally `leaderboardRank`, `leaderboardTotal` and `stageRecords` (`[{stage, timeUs, previousRecordUs}]`, at most 64). `record` outranks `personalBest` in the text and sound; leaderboard text needs `0 < leaderboardRank <= leaderboardTotal`.

Control frames stay within 65,536 bytes. Larger JSON messages use sequential `{type:"room-chunk",data,final}` frames on the reliable channel; `data` holds part of the original JSON string and `final:true` completes it. The room-client hook assembles the message before applying it.
Frame sizes are measured after the transport wraps and escapes them once more, so chunks carry at most 4,000 characters. An assembled message stays within 1,048,576 characters (256 × 4,096) and 263 chunks.

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

**Type 2, room snapshot** (4–7804 bytes): version, type 2, uint16 block count (0–100), then per block a 14-byte header (uint16 slot, uint32 sequence, uint32 epoch, uint8 sample count 1–2, uint8 and uint16 reserved 0) and its poses. Duplicate slots or trailing bytes are invalid. The host keeps each sender's latest upload and bundles the blocks for each recipient about every 50 ms, excluding that recipient. More than 100 blocks are split across snapshots. Pose bytes stay unchanged. A recipient with more than 64 KB buffered skips snapshots and spectator frames until it drains. The game keeps up to 12 samples per player, drops samples over 250 ms behind the newest, and extrapolates at most 100 ms.

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

The game treats 4002, 4004, 4008 and 4009 as final and shows the reason without retrying; other unexpected closes retry six times with backoff. Guests replace any close reason that isn't one of the extension's own texts with "This private room has closed." for 4004, "Invalid private room data" for 4002, and nothing otherwise. The private host uses 4002 for invalid data, 4004 when the room is gone, 4008 for full rooms, kicks and bans, and 4013 (which the game retries) for a player whose buffer stays above 8 MB for 5 seconds. The game itself closes with 4000 (no welcome within 10 s), 4013 (too much buffered), 4003 (session refresh) and 1000 (leaving).

The host's own game reads its room through the same rebuilding and checks as a guest's, except that its own player is the moderator. A replacement host loopback removes the old host connection without ending the room. Explicit Leave and `pagehide` close the room. When a guest's peer connection drops without a close message, the guest asks the meeting point: if the room is gone, it closes with 4004; otherwise it reconnects through the meeting point. When a guest's open connections to a room have closed more than 3 times within 30 seconds, the next attempt closes at once with 4004 "This private room has closed.", which stops the game's retries. Closing a guest's meeting point socket after negotiation doesn't affect its peer connection.

## Testing safely

Test as a guest, without finishing runs. Hosting needs a signed-in account; finish no runs with it either. The game prepares `guest-attempt` tickets on its own, even before a finish, so block the attempt, upload and claim endpoints before the first page load when testing in a browser.
