# Private rooms signalling

Before two browsers in a private room can talk directly over WebRTC, they swap connection details (offers, answers and ICE candidates). This Cloudflare Worker is where they meet to do that; gameplay never passes through it. Each room is one Durable Object that holds its sockets through the WebSocket hibernation API, so a quiet room costs nothing and Cloudflare's free plan is plenty. It is deployed on its own and is not part of the extension build.

## Deploy

You need a free [Cloudflare account](https://dash.cloudflare.com/sign-up) and Node.js (for `npx`). From this folder:

1. `npx wrangler login` opens Cloudflare in your browser to let Wrangler deploy for you.
2. `npx wrangler deploy` uploads the Worker. The first time, it asks you to pick a `workers.dev` subdomain. It ends by printing the Worker's URL, such as `https://surfd-signal.<subdomain>.workers.dev`.
3. Put that URL in `SIGNAL_URL` at the top of `src/private-rooms/signal-client.js`, then `bun run build` and reload the extension.

Run `npx wrangler deploy` again after changing `src/`. `npx wrangler tail` streams the Worker's errors live; it never logs what rooms send.

## Protocol

`GET /rooms/<roomId>` upgrades to a WebSocket. A room id is `p-` and 12 characters of `abcdefghjkmnpqrstuvwxyz23456789`. Only pages on `https://surfd.net` may connect (checked by the `Origin` header). Bad requests get a plain HTTP error: 404 (path or room id), 403 (origin), 426 (not a WebSocket upgrade), 400 (role), 429 (too many connections from one client).

- The host connects with `?role=host` and, within 5 seconds, sends its key as its first message: `{"type":"auth","key"}`, a random secret of at least 128 bits as 32 to 128 lowercase hex characters. That claims the room, and only that key can reconnect to it. The key never goes in the URL, which could end up in logs.
- Guests connect with `?role=guest`, and leave once their direct connection to the host is up, so a room's size isn't limited here.
- On joining, the relay sends `{"type":"welcome","data":{"id","peers":[guest ids]}}` to the host and `{"type":"welcome","data":{"id","host"}}` to a guest.
- The host sends `{"to","type","data"}` to a guest and a guest `{"type","data"}` (or with `"to"` set to the host's id) to the host; each arrives as `{"from","type","data"}`. Guests never reach each other. `type` is up to 32 letters, digits, `_` or `-`; the relay never reads `data`.
- The host hears `{"type":"peer-joined","from"}` and `{"type":"peer-left","from"}` as guests come and go.
- A message the relay won't pass on gets back `{"type":"error","data":{"code","to"?}}`, with code `bad-message`, `no-peer` (no such guest), `forbidden` (a guest naming someone other than the host) or `host-away`.
- The text `ping` is answered with `pong`, without waking the room.

A public room is listed by its host: `{"type":"listing","data":{"name","mapId","players"}}` (no `"to"`) lists or updates it, `{"type":"listing","data":null}` unlists it, and a room that ends is unlisted. Listings pass the extension's own checks or get `bad-message`: `name` is `<username>'s room` with a username of 3 to 24 letters, digits, `_` or `-`, and without "surfd" or "official" in any case; `mapId` is 1 to 64 of `a-z`, `0-9` and `_`; `players` is 0 to 256. A client lists at most 3 rooms at once. A listing nobody refreshes for 90 seconds disappears. `GET /rooms` (from `https://surfd.net`) returns `{"rooms":[{"id","name","mapId","players","updatedAt"}]}`, the 200 busiest, cached for about 10 seconds.

Limits are per client, an IPv4 address or an IPv6 /64, counted in memory by each Worker isolate: 60 new connections at once, then one more every 30 seconds; 2,000 messages at once, then one more a second. A host's message to a guest counts against that guest and its client, so a guest that asks for too much is the one disconnected. The host's other messages past 50 in 10 seconds, such as replies to guests that already left, are dropped without an error.

A host whose socket drops keeps the room for 30 seconds: its guests stay, and it can reconnect with its key (keeping its id; the welcome lists the guests now present). A host closing with code 1000 ends the room at once. An ended room's id stays reserved for 6 hours, so stale invite links never lead into someone else's room: guests get `no-room`, other keys `room-taken`, and only the old key can claim it again, as a new room.

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

The relay (`src/room.js`) and the limits (`src/limits.js`) have no Workers dependencies; `bun test` at the repository root covers them (`tests/signal-*.test.js`) without Wrangler. After a deploy, `bun signal/check-live.mjs` checks the deployed Worker end to end; pass it another base URL to check that one instead.
