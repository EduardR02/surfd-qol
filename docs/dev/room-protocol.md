# Private rooms: phase 1 protocol

## Scope and evidence

The authority is the browser hosting the private room, not Surfd's public servers. A room holds at most 16 connections including the host. No ranked context, verified result, playtime credit, inactivity challenge, public moderation, map vote or public account identity is issued. All native `result` messages are deliberately absent in phase 1. Guest-only development must not finish a run or submit an attempt.

Source inspected: [game-CjfdKdJo.js](https://surfd.net/assets/game-CjfdKdJo.js), retrieved 2026-10-28; SHA-256 `c2c8d9bf13c11b63879670d2944b101910bf09d4a21aafd929f7b7e342a64dfa`. Positions below are zero-based JavaScript string offsets in that fetched file, not byte offsets. Symbols and adjacent literals are the durable search anchors if an upstream build changes.

| Source anchor | Offset | Evidence |
| --- | ---: | --- |
| `Vo=1`, `ps=n=>Hl[n]?.name??"Surfd "+n.toUpperCase()` | 786448 | Protocol version and arbitrary room-ID display fallback. |
| `Gt={grounded:1,...}` | 786849 | Pose flags. |
| `Vh`, `vb`, `Rm`, `gr` | 786918–787705 | Stage result validation and exact appearance schema/default. |
| `const ua=12`, `r0`, `jx`, `a0`, `Yx`, `o0`, `Kx`, `Jx` | 1130708 onward | Compact poses, upload batches and download snapshots; complete binary validation. |
| `const l0=3`, `d0`, `nw` | 1137499 onward | Detailed spectator packets and input-bit validation. |
| `class iw` | 1139304 onward | HTTP discovery, ticketed WebSocket creation, JSON handling, timers, binary consumers and close/retry policy. |
| `cw`, `h0`, `dw` | 1150529 onward | Result message text, stage-record rendering and sounds. |
| community `re(X)` | 1168365 | Native guest chat prohibition. |
| community `Pe`, `Ae`, `Ie` | 1173300–1175100 | Ranked-context wait, map switching and JSON consumers. |
| community `tt`, `J`, `Ke` | 1176600–1183000 | Player fields, moderator UI and report fields. |
| `L9`, `El` | 986970–987075 | Native timer formatting has no untimed sentinel. |

The bundle is a client, not the public server implementation. Constraints below explicitly distinguish client validation from private-host policy. It cannot prove unobserved server-only fields, server-side rate limits, or the semantic assignment of every 4xxx close code. JSON is largely consumed directly rather than validated by a complete native schema.

## Entry points, discovery and transport

Development entry points are `window.__SURFD_QOL__.privateRooms.host()` and `.join(roomId)`, each resolving to the room ID. Hosting uses the selected/current native map. Joining waits for same-origin discovery before entering the normal native lobby connection flow. Native `?join=id` selects a discovered row; it does not automatically join.

IDs are `p-` followed by 12 cryptographically random characters from `abcdefghjkmnpqrstuvwxyz23456789`, using rejection sampling. The prefix cannot collide with native public IDs `eu`, `na`, `eut3`; the native `ps` fallback formats it normally. No ambiguous `0`, `1`, `i`, `l`, or `o` is generated. IDs are discovery addresses, not authentication secrets.

The host uses an asynchronously opened loopback pair. Register `host.addClient(hostSocket, hello, {host:true})` before loopback open. Remote same-origin tabs use WebRTC: reliable ordered JSON/control plus an unreliable binary channel. Both channels must be ready and the extension hello received before the listener invokes `onSocket(socket, hello)`. The socket-compatible surface uses protocol `surfd-v1`, ArrayBuffer binary messages, native open/message/close events and a reliable close control. Default ICE uses public STUN; there is no TURN relay or cross-origin signalling service in phase 1. BroadcastChannel is same-origin development signalling only, not internet room discovery. See `socket.js` and `signalling.js` for channel/signalling implementation.

Runtime discovery uses room-specific `room-query`/`room-info`, with a 5-second host heartbeat, 15-second row expiry and 5-second join discovery timeout. Only the own hosted room, explicitly requested `join(id)` / `?join=id` rooms, and already-known IDs become visible. There is no global query or all-room enumeration; unsolicited room-info is ignored. Private native rows contain `{id,name,region,players,capacity,mapId,mapTitle,endsAt,epoch,online,untimed,ping,roster}`: `region:"Private"`, `capacity:16`, `players` counts open connections, `untimed:true`, `endsAt:0`, and `ping:0`. Four native room/list countdown callsites render `untimed:true` as “No time limit”; public countdowns are unchanged. Private tickets, identity refresh, ping measurement, and sockets resolve locally. The native browser still fetches the public `/servers` list and public-room pings; known private rows merge into that list, including when public discovery fails.

The extension-only hello is `{name,appearance,guest}`. It precedes gameplay, is not a native gameplay JSON message, and contains no account token. `guest` records the actual site session state. `name` must be a nonblank string; the host trims and limits it to 24 JavaScript code units. Invalid appearance falls back to the native default.

## Common JSON structures

All native JSON messages have a string `type`. Native receive rejects nonstrings other than ArrayBuffers and strings longer than 65,536 JavaScript code units; literal `pong` is handled before JSON. The private host accepts literal `ping`, otherwise requires an object (not an array/null) with string `type` and the same length bound. Unknown controls and explicitly unsupported phase-1 actions are inert.

### Appearance

`{title:"",titleColor:null,nameColor:null,revision:0}` is the exact native default. `Rm` accepts only a nonarray object with:

- `title`: string, length at most 24, already trimmed, matching `/^[\p{L}\p{N} _.'!?-]*$/u`.
- `titleColor`, `nameColor`: each `null` or a six-digit `#RRGGBB` string, case-insensitive.
- `revision`: nonnegative safe integer.

`gr` falls back to the default for invalid values. The host copies only these four fields. The adapter obtains `client.profile?.appearance ?? null` and `client.profile?.username ?? "Guest"`.

### Player

Native roster/player consumers use `{id,connectionId,slot,name,rank,points,guest,moderator,appearance,spectating}`. `id` is used for mute/rank/own-player comparisons and chat sender lookup; `connectionId` distinguishes live connections and selects spectator targets; `slot` selects binary interpolation buffers. Names/ranks/points populate the scoreboard. `spectating` disables targets already watching someone else. A slot is uint16 on the wire; private rooms assign unique slots 0–15 and reuse departed slots with a fresh connection ID, which makes native roster handling clear the old buffer.

Private identities are generated locally: `connectionId` is a fresh random UUID; `id` is `private-` plus that UUID; `rank:"Guest"`, `points:0`. Only the host has `moderator:true`. **All private room player objects have `guest:false` for native UI compatibility**, even when hello has `guest:true`: the native chat sender rejects `C.player.guest`, and moderator map controls require `moderator && !guest`. This is a local capability flag, not a public sign-in or reward assertion. No site session is changed. Keeping nonhost `guest:true` would silently prevent guest-only private chat. Ranked context remains `null`.

### State and catalog

Native consumers require `mapId`, `epoch`, `endsAt`, `recent`, `nominations`, `vote`, and `nextMap`. `recent[0]` and current `mapId` exclude maps from nomination; nominations map player IDs to map IDs. A nonnull vote has `{id,kind,runoff,choices,ballots,endsAt}`: choices are map IDs or `@extend` / `@continue`, ballots map player IDs to choices, kind `extend` changes labels, runoff changes the header, and endsAt gates voting.

Private state is `{roomId,name,mapId,mapTitle,capacity:16,epoch,startedAt,endsAt:0,untimed:true,recent:[],nominations:{},rtv:[],vote:null,nextMap:null}`. `roomId`, `name`, `mapTitle`, `capacity`, `startedAt`, `untimed`, and `rtv` are private metadata/defaults, not claimed native validator requirements. Epoch starts at 1 and increments only when the host changes to a different map. `startedAt` is wall-clock milliseconds. `recent` retains up to eight previous map IDs. There is no deadline or automatic rotation. `endsAt:0` alone would display native “Changing map…”; private runtime presentation supplies the untimed label rather than pretending a far-future deadline is infinite.

`maps` is the catalog supplied by the native adapter, reduced to `{id,title,tier?}`. The current map must exist in that catalog; unknown change-map requests return an error without changing state. If a standalone host omits `maps`, only its initial `mapId` is allowed. Native community code filters welcome maps through `ka` (currently hides unavailable `surf_pantheon`).

## Native client → room JSON/control

| Message | Fields and consumer intent | Phase-1 behavior |
| --- | --- | --- |
| literal `ping` | Native timer sends every 15s and measures elapsed time on literal `pong`. | Reply `pong` to sender. |
| `chat` | `text:string`, native form trims before send. Private boundary rejects blank text; full packet is bounded to 65,536 code units. No additional public-server chat limit can be inferred from this bundle. | Broadcast normalized text with authoritative sender fields, including to sender. No URL mute/global moderation is implemented. |
| `change-map` | `mapId:string`, selected native catalog map. | Only connection registered `{host:true}` may change to a known different map. Broadcast state and reissue all spectator demands after epoch change. |
| `spectate` | `connectionId:string|null`, `request`: incrementing integer correlating errors. Private validator requires nonnegative safe integer. `null` unsubscribes. | Reject self/missing/already-spectating target with matching `spectatorRequest`; maintain subscriptions and roster `spectating`. |
| `refresh` | `token:string`, new ticket. Native refresh every 5min or after own result, throttled to at least 15s since last refresh. | Ignore; no account/ticket authority. Private ticket hook supplies no public request. |
| `context` | No payload; requests ranked map context. Native `Pe` waits up to 2.5s; cached token is reused for up to 20min. | Reply `{type:"context",epoch,token:null}` immediately. Resolves native map-start wait without ranked submission authority. |
| `ack` | `nonce` copied unmodified from `check`. | Ignore; private host never emits `check`. |
| `activity` | `mode:"play"|"view"`, `hidden:boolean`, `interacted:boolean`. Native sends when enabled and mode/revision changes, with 5s throttling for same mode. | Ignore; activityTracking false. |
| `rtv` | No payload. | Ignore. |
| `nominate` | `mapId:string`. | Ignore. |
| `vote` | `voteId`, `choice`; choice from current vote choices. | Ignore. |
| `extend` | No payload; native start UI requires nonguest points >1,000. | Ignore. |
| `query` | `query:"rank"|"mrank"|"timeleft"|"nextmap"|"played"`; optional `name` only for played, native truncates to 24. | Ignore; no public queries or playtime service. |
| `report` | `playerId`, `reason` from nonblank trimmed form. | Ignore; no report backend. |
| `reports` | No payload. | Ignore. |
| `moderate` | `playerId`, `action:"kick"|"ban"`, `minutes:60` in the native UI. | Ignore; moderator flag grants private map UI only. |

Neither client → room `hello` nor client → room `result` is a native gameplay message. Extension hello travels before opening; ranked results normally originate from public verification, not arbitrary peer submissions.

## Native room → client JSON/control

| Message | Fields, defaults and consumer meanings |
| --- | --- |
| literal `pong` | Updates native ping, bypasses JSON parsing. |
| `welcome` | `{state,player,players,maps,serverTime,spectatorStream,playtime,activityTracking,recentResults?,chatMute?}`. Assigns own player, roster and state, clears buffers/sequences/reconnect retries, starts ping/refresh, enables native connected UI and map load. Private defaults: spectatorStream true; playtime/activityTracking false; recentResults `[]`; chatMute `null`; serverTime `Date.now()`. Native only enables the three booleans when exactly true. |
| `state` | `{state,serverTime}`. Lower epochs ignored. Epoch changes clear pose/spectator buffers and pose sequence and set spectator teleport; native also resets viewer count but not demand flag, so host republishes demands. Community updates map and clock offset. |
| `roster` | `{players}`. Replaces roster, refreshes own player by connectionId, clears buffers for changed/missing slot ownership, redraws scoreboard/moderator controls. |
| `chat` | `{playerId,name,text,rank?,appearance?}`. This is **not** `{sender:{...}}`. Native local mute uses playerId; name is displayed; rank falls back through matching roster then `"Guest"`; appearance goes through `gr`. Host supplies all five sender/text fields. |
| `notice` / `error` | `{text,spectatorRequest?}`. Displays server/error chat and clears pending map-change/report UI. When error spectatorRequest equals current watch request and a target exists, native calls watch(null). Host uses errors for invalid map permissions/IDs and unavailable/departed spectator targets. |
| `spectator-demand` | `{active:boolean,count?:integer}`. Native requires count, if present, to be safe integer 0–65535 and `(count>0)===active`. Missing count with active true means unknown count. Host always includes exact count. Transition sets spectator teleport and clears accumulated input presses. |
| `context` | `{epoch,token}`. Community accepts only current epoch and resolves pending context waiters. Private token always null. |
| `check` | `{nonce}`. Native replies ack. Never emitted privately. |
| `afk-warning` | `{seconds}`. Native shows local countdown and keep-slot button. Never emitted privately. |
| `chat-status` | `{mute}`. Mute is `{muted,until,reason}`; until null means permanent, otherwise epoch milliseconds. Native considers active when muted and null/future until. Never emitted privately. |
| `reports` | `{reports:[{id,playerId,playerName,reason,reporter,at,recentMessages}]}`. Native shows name/reason/reporter, formats at with Date, joins recentMessages; id forms roomId + ':' + id moderation reference. Never emitted privately. |
| `result` | `{result}` with schema below. Never emitted in phase 1. |

### Result schema (documented, not fabricated)

Native consumers read `result.id` (deduplication), `userId` (own result/account refresh), `name`, `rank`, `mapId`, `mapTitle`, `timeUs`, `record`, `personalBest`, `previousBestUs`, `pointsDelta`, `promoted`, optional `leaderboardRank`, `leaderboardTotal`, and optional `stageRecords`.

`cw` formats mapTitle/timeUs; record takes precedence over personalBest; previousBestUs supplies improvement text when truthy; pointsDelta >0 displays points; promoted displays rank. Leaderboard text is emitted only when rank/total are safe integers with rank >0 and total >=rank. `dw` chooses record/rank/pb/complete sounds based on these booleans and matching userId. `Vh` accepts stageRecords only when array, inspects at most 64 entries, and requires each `{stage,timeUs,previousRecordUs}` to be an object with safe integer stage 1–64, positive safe integer timeUs, and previousRecordUs either null or positive safe integer. Stage records render only for supported staged maps. These are observed consumer fields, not a claim that public result payloads contain no other fields. Phase-3 result emission is intentionally outside this implementation.

## Binary wire format

All multibyte numbers are **little-endian**, no padding except reserved bytes explicitly listed. Version byte is **1**. Binary uploads/downloads are ArrayBuffers. Private input accepts only client packet types 1 and 3; type 2/4 uploads and malformed packets close the sender. Epoch must exactly match host state to relay; stale/future epoch packets are ignored. Sequence freshness/wrap is interpreted by native interpolation (`a !== b && ((a-b)>>>0) < 2^31`), not reordered by the host.

### Compact pose: 32 bytes

Offsets are relative to the start of each pose.

| Offset | Bytes | Type | Meaning / validation |
| ---: | ---: | --- | --- |
| 0 | 4 | uint32 | `time`, sender performance timestamp modulo 2^32, 0–4294967295. |
| 4 | 4 | float32 | `x`, finite, absolute value <=131072. |
| 8 | 4 | float32 | `y`, same. |
| 12 | 4 | float32 | `z`, same. |
| 16 | 2 | int16 | `vx`, source finite abs <=32767, encoder Math.round. Decoded -32768 is invalid. |
| 18 | 2 | int16 | `vy`, same. |
| 20 | 2 | int16 | `vz`, same. |
| 22 | 2 | uint16 | `yaw`: encode round((((yaw %360)+360)%360)/360*65535); decode /65535*360. Source finite abs <=360. Endpoint decode may be 360. |
| 24 | 2 | int16 | `pitch`: encode round(pitch/90*32767); decode /32767*90. Finite abs <=90; encoded -32768 is invalid. |
| 26 | 1 | uint8 | `flags`, integer 0–63: grounded=1, crouched=2, teleport=4, practice=8, idle=16, finished=32. |
| 27 | 1 | uint8 | Reserved, must equal zero. |
| 28 | 4 | float32 | `seconds`, finite timer seconds 0–86400. |

Positions, velocity, yaw, pitch and seconds are validated both on native encode and decode. Encoding may quantize; relay copies validated pose bytes instead of decode/re-encode, preventing a second quantization.

### Client pose batch: type 1

| Offset | Bytes | Type | Meaning |
| ---: | ---: | --- | --- |
| 0 | 1 | uint8 | Version 1. |
| 1 | 1 | uint8 | Type 1. |
| 2 | 1 | uint8 | Sample count 1 or 2. |
| 3 | 1 | uint8 | Reserved zero. |
| 4 | 4 | uint32 | Sequence. |
| 8 | 4 | uint32 | Epoch. |
| 12 | 32 × count | compact pose | One/two samples. |

Exact size 44 or 76; no trailing bytes. Native samples no faster than every 49ms and usually sends pairs. More than 65,536 buffered upload bytes closes native connection with 4013.

### Room snapshot: type 2

Header: offset 0 uint8 version=1; offset 1 uint8 type=2; offset 2 uint16 block count 0–100. Header length 4. Each block has the following 14-byte header followed immediately by 1–2 compact poses:

| Block offset | Bytes | Type | Meaning |
| ---: | ---: | --- | --- |
| 0 | 2 | uint16 | Host-assigned player slot. |
| 2 | 4 | uint32 | Sender sequence. |
| 6 | 4 | uint32 | Sender epoch. |
| 10 | 1 | uint8 | Sample count 1–2. |
| 11 | 1 | uint8 | Reserved zero. |
| 12 | 2 | uint16 | Reserved zero. |
| 14 | 32 × count | compact pose | Samples. |

Total size 4–7804, duplicate slots invalid, truncated block/sample invalid, trailing bytes invalid. Empty snapshot is valid. Private host wraps each type-1 upload in one type-2 block with the sender's authoritative slot, retaining sequence/epoch and all sample bytes, and broadcasts only to other clients. Native ignores unknown slots, own slot or wrong epoch. Interpolation retains at most 12 samples, rejects samples >250ms behind newest, resets on teleport, and extrapolates at most 100ms.

### Spectator upload type 3 / forward type 4: 56 bytes

| Offset | Bytes | Type | Meaning |
| ---: | ---: | --- | --- |
| 0 | 1 | uint8 | Version 1. |
| 1 | 1 | uint8 | 3 uploading, 4 forwarding. |
| 2 | 2 | uint16 | Slot; **not count/reserved from the pose-batch header**. Native publisher uses zero; host overwrites with authoritative sender slot. |
| 4 | 4 | uint32 | Spectator sequence, separate from ordinary pose sequence. |
| 8 | 4 | uint32 | Epoch. |
| 12 | 32 | compact pose | Includes common flags, timer and reserved-byte checks. |
| 44 | 4 | float32 | `eyeHeight`, finite 0–128. |
| 48 | 1 | uint8 | Phase index: 0 ready, 1 running, 2 finished; other values invalid. |
| 49 | 1 | uint8 | `untimed`, exactly 0 or 1. |
| 50 | 2 | uint16 | `checkpoints`, 0–1024. |
| 52 | 2 | uint16 | `stage`, 0–1024. |
| 54 | 1 | uint8 | Optional-input marker bit7=128; bit6 must be zero; low six bits are current held inputs. Zero means inputs absent, 128 means present but none held. |
| 55 | 1 | uint8 | Accumulated `inputPresses`, 0–63; must be zero if byte54 is zero. |

Input bits: w=1, a=2, s=4, d=8, jump=16, duck=32. Native encoder rejects inputPresses without inputs, defaults presses to zero when inputs are present, and omits both decoded fields when marker absent. Native decoder temporarily restores a type-1 header to validate the common 44 bytes, then validates/re-encodes detailed state. All exact sizes, bounds and reserved bits are mirrored in `protocol.js` without that allocation-heavy validation re-encode.

Native publishes at approximately 30Hz only while spectator-demand active, not itself watching, connected, and bufferedAmount <=4096. On demand transition/epoch it marks teleport; pressed bits accumulate between sends and clear after sending. Forwarding rewrites only type and slot, preserving every other byte. Host sends only to current watchers of that sender, never room-wide. Watcher leave/unsubscribe decrements demand; target leave or beginning to spectate someone else clears its watchers with correlated errors and updates roster. Map changes retain subscriptions and republish viewer counts. Native consumes type4 only if slot matches its selected connection and epoch matches state; missing detailed stream can fall back to ordinary poses.

## Lifecycle and failures

Private host uses `4002` for invalid data/hello, `4004` for room gone/host closed, and `4008` for full. These are compatible assignments: native `iw.open` treats **4002, 4004, 4008, 4009** as terminal and shows supplied reason without retry. Their individual public-server meanings beyond the client-emitted 4002 are not established by this client bundle. Other observed native codes: 4000 welcome timeout (10s), 4003 session-refresh reconnect hint, 4013 slow connection, 1000 voluntary leave. Normal unexpected close retries up to six times with exponential backoff.

Connecting clients reserve capacity immediately. Welcome occurs exactly once on socket open (or immediately for already-open RTC sockets). A disconnect removes its slot and subscriptions and broadcasts roster. Host departure closes the entire room; explicit close also closes pending sockets, removes listeners and rejects later additions. Native Leave for the host tab invokes runtime room shutdown. No room state survives host departure.

Both native clients and the host set their receiving socket's `binaryType` to `arraybuffer`. The WebSocket-compatible transport defaults to `blob`; neglecting the host assignment turns valid binary uploads into Blob objects and incorrectly triggers the JSON-data error path. A real-loopback regression covers both pose and spectator uploads across this boundary, rather than only injecting ArrayBuffers directly into a fake socket.

## Tests

`tests/private-room-host.test.js` covers open ordering, already-open sockets, native welcome/roster, cap and slot reuse, identities/appearance, guest-compatible chat, ping/null context, ignored controls, host-only catalog changes/epochs, pose isolation, spectator demand/forwarding/unsubscribe/leave and terminal cleanup. `tests/private-room-protocol.test.js` covers quantization/extrema, reserved headers, sizes/counts/duplicate slots, detailed input markers, malformed control boundaries and independent transcriptions of native snapshot/spectator validators. Socket and instrumentation fixtures cover transport lifecycle, discovery isolation and native join/timer behavior.

## Verified integration

`bun test`: 642 passed, zero failed. `bun run build.js` built the unpacked extension. Instrumenting the referenced live bundle emitted no warnings. Actual unchanged native codecs accepted extension output, matched encoded bytes, and agreed on 2,746 mutated pose/snapshot/spectator packets. Two actual native room-client instances exercised welcome/roster, chat, rejected nonhost map changes, epoch changes, pose interpolation buffers, spectator buffers and terminal closure through loopback.

Headed Chrome for Testing 145 loaded `dist/` unpacked with the real debugger loader. Two separate guest windows joined through the native flow over real WebRTC. Verified unknown rooms stay hidden, both rosters, native chat in both directions, host map-change dialog taking both clients from Rookie to Boreas with epoch 2, bounded practice movement publishing changed positions in both directions, detailed nonstale spectator rendering, and host departure delivering 4004 followed by Solo. No run reached finish.

Safety limitation discovered during browser verification: the unmodified game prepares `guest-attempt` tickets automatically, even before a finish. Initial browser startup issued those POSTs before this was noticed; subsequent verification blocked attempt/upload/claim endpoints through CDP and used practice for movement. No completed run or replay upload was submitted, and no account was used. Null room context is not a global block on the game's independent attempt preparation; future guest-only verification must install network guards before initial navigation.
