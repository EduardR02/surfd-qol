# Private rooms signalling

Before two browsers in a room can talk over WebRTC, they swap connection details (offers, answers and ICE candidates) and get credentials for Cloudflare's TURN relay, which carries all room traffic so that no player ever sees another's IP address. This Cloudflare Worker is where they meet to do that; gameplay never passes through it. Each room is one Durable Object that holds its sockets through the WebSocket hibernation API, so a quiet room costs nothing and Cloudflare's free plan is plenty. It is deployed on its own and is not part of the extension build.

## Deploy

You need a free [Cloudflare account](https://dash.cloudflare.com/sign-up) and Node.js (for `npx`). From this folder:

1. `npx wrangler login` opens Cloudflare in your browser to let Wrangler deploy for you.
2. `npx wrangler deploy` uploads the Worker. The first time, it asks you to pick a `workers.dev` subdomain. It ends by printing the Worker's URL, such as `https://surfd-signal.<subdomain>.workers.dev`.
3. Put that URL in `SIGNAL_URL` at the top of `src/private-rooms/signal-client.js`, then `bun run build` and reload the extension.

The Worker issues credentials from a Cloudflare Realtime TURN key stored in `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` secrets. Local configuration defaults to `RELAY = "off"`: deploying it unchanged prevents new room connections. Before enabling relay, choose explicit positive integer values for `RELAY_GRANTS_PER_HOUR`, `RELAY_GRANTS_PER_DAY` and `RELAY_MAX_UNEXPIRED`. The checked-in examples are 256, 1024 and 256. Every grant reserves a place transactionally in the singleton Lobby before the provider request; reservations survive restarts, disconnects and provider failures. Missing/invalid settings or storage failures refuse credentials.

Size these global counts by credential holders: one host grant plus one grant per guest. With the one-hour TTL automatically renewed at 45 minutes, a continuously connected holder uses about 32 grants per rolling day and overlaps two grants in the hourly and unexpired windows. The examples therefore support at most 32 continuously connected holders from the daily budget before churn or failures; the hourly and unexpired limits each have a theoretical ceiling of 128 holders. Choose limits for intended concurrency and leave room for joins, reconnects and provider failures, which also consume grants. A 256-holder initial cohort consumes all 256 hourly grants and unexpired slots, so it cannot renew at 45 minutes. This is not a 256-player sustained-capacity promise, and the credential TTL itself does not limit room duration.

These are credential-count limits, **not byte or spending caps**. Host keys prove room ownership, not Surfd account identity; non-browser callers can forge Origin, claim rooms and obtain credentials when relay is enabled. Credentials are reusable for unrelated TURN traffic. Hostile callers can also exhaust grants and deny legitimate connections. Cloudflare bills relayed egress after the shared 1,000 GB allowance; the documented key API exposes no hard bandwidth/spend quota. Monitor provider usage and use [credential revocation](https://developers.cloudflare.com/realtime/turn/generate-credentials/) for containment; [pricing and expiry behavior](https://developers.cloudflare.com/realtime/turn/faq/) remain provider policy.

Anything but `RELAY = "on"` stops new issuance, not credentials already issued. New credentials last one hour, with a five-second reservation issuance window; clients renew at 45 minutes, so the TTL does not limit a room's duration. Older credentials can retain their previously issued lifetime. Changing deployed configuration requires applying the change on Cloudflare; the next deploy uses the checked-in values. No deployment is part of local verification.

Run `npx wrangler deploy` again after changing `src/`. `npx wrangler tail` streams the Worker's errors live; it never logs what rooms send.

## Protocol

`GET /rooms/<roomId>` upgrades to a WebSocket. A room id is `p-` and 12 characters of `abcdefghjkmnpqrstuvwxyz23456789`. Browsers must connect from `https://surfd.net` (Origin checked); this prevents another website using a visitor's browser, not a non-browser client forging the header. Bad requests get 404 (path/id), 403 (origin), 426 (upgrade), 400 (role) or 429 (connection rate).

- The host connects with `?role=host` and, within 5 seconds, sends its key as its first message: `{"type":"auth","key"}`, a random secret of at least 128 bits as 32 to 128 lowercase hex characters. That claims the room, and only that key can reconnect to it. The key never goes in the URL, which could end up in logs.
- Guests connect with `?role=guest`, and leave once their connection to the host is up, so a room's size isn't limited here.
- On joining, the relay sends `{"type":"welcome","data":{"id","peers":[guest ids]}}` to the host and `{"type":"welcome","data":{"id","host"}}` to a guest.
- The host sends `{"to","type","data"}` to a guest and a guest `{"type","data"}` (or with `"to"` set to the host's id) to the host; each arrives as `{"from","type","data"}`. Guests never reach each other. `type` is up to 32 letters, digits, `_` or `-`; the relay never reads `data`.
- The host hears `{"type":"peer-joined","from"}` and `{"type":"peer-left","from"}` as guests come and go.
- A message the relay won't pass on gets back `{"type":"error","data":{"code","to"?}}`, with code `bad-message`, `no-peer` (no such guest), `forbidden` (a guest naming someone other than the host) or `host-away`.
- The text `ping` is answered with `pong`, without waking the room.
- `{"type":"ice-servers"}`, from a host that sent its room key or a guest of a live room, asks for TURN credentials. The answer is `{"type":"ice-servers","data":{"iceServers":[{"urls","username","credential"}],"ttl"}}`, TURN servers only, valid for one hour, or an `error` with code `no-relay`. A socket gets one answer before it may ask again; neither request nor answer reaches another peer. All grants, including renewals, pass the durable global budget and existing per-client limiter.

A public room is listed by its host: `{"type":"listing","data":{"name","mapId","players","capacity","roster"}}` (no `"to"`) lists or updates it; `data: null` unlists it, as does ending the room. Names are free text: trim leading/trailing whitespace and collapse repeated spaces, then allow 3–32 ASCII letters, digits, spaces and `' - _ . ! ? & # : ( )`; names containing "surfd" or "official" in any case are refused. Map ids use 1–64 lowercase letters, digits or `_`; capacity is 2–64 and player counts are 0–64, independent of capacity so players may temporarily exceed a lowered capacity. Roster previews inspect at most the first 24 source entries and retain valid `{name, guest, userId?}` values, using the private-room player-name grammar. `guest` must be boolean; an optional UUID `userId` is allowed only for non-guests. Points, rank and other fields are never returned, and missing rosters become empty previews. Counts, capacity and names are host claims, not verified attendance. A client lists at most three rooms. Listings expire after 90 seconds. `GET /rooms` returns the 200 busiest `{id,name,mapId,players,capacity,roster,updatedAt}` rows, cached for about ten seconds. Malformed stored rows are discarded individually.

Limits are per client, an IPv4 address or an IPv6 /64, counted in memory by each Worker isolate: 60 new connections at once, then one more every 30 seconds; 2,000 messages at once, then one more a second; 40 TURN credentials at once, then one more a minute. A host's message to a guest counts against that guest and its client, so a guest that asks for too much is the one disconnected. The host's other messages past 50 in 10 seconds, such as replies to guests that already left, are dropped without an error.

A host whose socket drops keeps the room for 30 seconds: its guests stay, and it can reconnect with its key. Closing with code 1000 ends the room immediately. An ended room's id stays reserved for six hours: guests get `no-room`, other keys get `room-taken`, and the old key may reclaim it. **After that reservation expires, another key can claim a known old id.** Old invite links do not prove the original host's identity.

The relay closes sockets with these codes (the reason is the name):

| Code | Reason | When |
| --- | --- | --- |
| 4401 | `unauthorized` | a host whose first message isn't its key, or that sent none within 5 seconds |
| 4403 | `room-taken` | a host without the room's key |
| 4404 | `no-room` | a guest before any host, or after the room ended |
| 4409 | `replaced` | the host reconnected on another socket |
| 4410 | `room-closed` | the host left for good; the room is gone |
| 4413 | `too-large` | a message over 16 KB |
| 4429 | `rate-limited` | a guest over 50 messages in 10 seconds, or the host over 50 to it; or a client over its limit |
| 4503 | `room-full` | 100 guests connected at once, or 20 from one client |

## Tests

The relay, directory, credential issuer, durable grant-budget helper and limiters have no Workers dependencies; `bun test` at the repository root covers them without contacting Cloudflare. Worker integration can run locally in workerd. After an authorized deploy, `bun signal/check-live.mjs` checks the deployed Worker; pass another base URL to target a local instance instead. The check requests credentials and is not an offline test.
