# Private rooms signalling

Before two browsers in a private room can talk directly over WebRTC, they swap connection details (offers, answers and ICE candidates). This Cloudflare Worker is where they meet to do that; gameplay never passes through it. Each room is one Durable Object that holds its sockets through the WebSocket hibernation API, so a quiet room costs nothing and Cloudflare's free plan is plenty. It is deployed on its own and is not part of the extension build.

## Deploy

You need a free [Cloudflare account](https://dash.cloudflare.com/sign-up) and Node.js (for `npx`). From this folder:

1. `npx wrangler login` opens Cloudflare in your browser to let Wrangler deploy for you.
2. `npx wrangler deploy` uploads the Worker. The first time, it asks you to pick a `workers.dev` subdomain. It ends by printing the Worker's URL, such as `https://surfd-signal.<subdomain>.workers.dev`.
3. Put that URL in `SIGNAL_URL` at the top of `src/private-rooms/signal-client.js`, then `bun run build` and reload the extension.

Run `npx wrangler deploy` again after changing `src/`. `npx wrangler tail` streams the Worker's errors live; it never logs what rooms send.

## Protocol

`GET /rooms/<roomId>` upgrades to a WebSocket. A room id is `p-` and 12 characters of `abcdefghjkmnpqrstuvwxyz23456789`. Only pages on `https://surfd.net` may connect (checked by the `Origin` header). Bad requests get a plain HTTP error: 404 (path or room id), 403 (origin), 426 (not a WebSocket upgrade), 400 (role or key).

- The host connects with `?role=host&key=<key>`, a random secret of at least 128 bits as 32 to 128 lowercase hex characters, and claims the room. Only that key can reconnect to it.
- Guests connect with `?role=guest`.
- On joining, the relay sends `{"type":"welcome","data":{"id","peers":[guest ids]}}` to the host and `{"type":"welcome","data":{"id","host"}}` to a guest.
- The host sends `{"to","type","data"}` to a guest and a guest `{"type","data"}` (or with `"to"` set to the host's id) to the host; each arrives as `{"from","type","data"}`. Guests never reach each other. `type` is up to 32 letters, digits, `_` or `-`; the relay never reads `data`.
- The host hears `{"type":"peer-joined","from"}` and `{"type":"peer-left","from"}` as guests come and go.
- A message the relay won't pass on gets back `{"type":"error","data":{"code","to"?}}`, with code `bad-message`, `no-peer` (no such guest), `forbidden` (a guest naming someone other than the host) or `host-away`.
- The text `ping` is answered with `pong`, without waking the room.

A host whose socket drops keeps the room for 30 seconds: its guests stay, and it can reconnect with its key (keeping its id; the welcome lists the guests now present). A host closing with code 1000 ends the room at once.

The relay closes sockets with these codes (the reason is the name):

| Code | Reason | When |
| --- | --- | --- |
| 4403 | `room-taken` | a host without the room's key |
| 4404 | `no-room` | a guest before any host, or after the room ended |
| 4409 | `replaced` | the host reconnected on another socket |
| 4410 | `room-closed` | the host left for good; the room is gone |
| 4413 | `too-large` | a message over 16 KB |
| 4429 | `rate-limited` | over 50 messages in 10 seconds (the host: 50 per guest present) |
| 4503 | `room-full` | 16 guests already |

## Tests

The relay (`src/room.js`) has no Workers dependencies; `bun test` at the repository root covers it (`tests/signal-room.test.js`) without Wrangler.
