// End-to-end check of the deployed signalling Worker, run after each deploy
// with `bun signal/check-live.mjs`: refusals, a host and a guest swapping
// messages both ways, and the room closing when the host leaves.
const BASE = 'surfd-signal.lightconelabs.workers.dev';
const ORIGIN = 'https://surfd.net';
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const pick = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => ALPHABET[b % ALPHABET.length]).join('');
const room = `p-${pick(12)}`;
const key = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

// HTTP refusals, before any room wakes.
const status = async (path, headers = {}) => (await fetch(`https://${BASE}${path}`, {headers})).status;
check('bad room id is 404', await status('/rooms/nope', {Origin: ORIGIN}) === 404);
check('other origin is 403', await status(`/rooms/${room}?role=guest`, {Origin: 'https://evil.example'}) === 403);
check('plain GET from surfd.net is 426', await status(`/rooms/${room}?role=guest`, {Origin: ORIGIN}) === 426);
check('there is no room directory (404)', await status('/rooms', {Origin: ORIGIN}) === 404);

function open(query) {
  const socket = new WebSocket(`wss://${BASE}/rooms/${room}?${query}`, {headers: {Origin: ORIGIN}});
  const inbox = [], waiters = [];
  socket.addEventListener('message', event => {
    const message = event.data === 'pong' ? 'pong' : JSON.parse(event.data);
    const waiter = waiters.findIndex(w => w.match(message));
    if (waiter >= 0) waiters.splice(waiter, 1)[0].resolve(message); else inbox.push(message);
  });
  const closed = new Promise(resolve => socket.addEventListener('close', event => resolve({code: event.code, reason: event.reason})));
  const next = (match, ms = 8000) => {
    const queued = inbox.findIndex(match);
    if (queued >= 0) return Promise.resolve(inbox.splice(queued, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = {match, resolve};
      waiters.push(waiter);
      setTimeout(() => { const i = waiters.indexOf(waiter); if (i >= 0) { waiters.splice(i, 1); reject(new Error('timed out')); } }, ms);
    });
  };
  return {socket, next, closed, opened: new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', reject); })};
}
const type = t => m => m?.type === t;

try {
  const early = open('role=guest');
  check('guest before host is refused (4404)', (await early.closed).code === 4404);

  const host = open(`role=host&key=${key}`);
  await host.opened;
  const hostWelcome = await host.next(type('welcome'));
  check('host gets welcome with its id', typeof hostWelcome.data?.id === 'string', hostWelcome.data?.id);

  const thief = open(`role=host&key=${'f'.repeat(32)}`);
  check('another key cannot take the room (4403)', (await thief.closed).code === 4403);

  const guest = open('role=guest');
  await guest.opened;
  const guestWelcome = await guest.next(type('welcome'));
  check('guest gets welcome naming the host', guestWelcome.data?.host === hostWelcome.data.id);
  const joined = await host.next(type('peer-joined'));
  check('host hears the guest join', joined.from === guestWelcome.data.id);

  const started = performance.now();
  guest.socket.send(JSON.stringify({type: 'offer', data: {sdp: 'v=0 fake offer'}}));
  const offer = await host.next(type('offer'));
  check('guest → host relayed', offer.from === guestWelcome.data.id && offer.data?.sdp === 'v=0 fake offer');
  host.socket.send(JSON.stringify({to: guestWelcome.data.id, type: 'answer', data: {sdp: 'v=0 fake answer'}}));
  const answer = await guest.next(type('answer'));
  check('host → guest relayed', answer.from === hostWelcome.data.id && answer.data?.sdp === 'v=0 fake answer',
    `round trip ${Math.round(performance.now() - started)} ms`);

  guest.socket.send(JSON.stringify({type: 'welcome', data: {}}));
  check('peers cannot forge relay notices', (await guest.next(type('error'))).data?.code === 'bad-message');

  guest.socket.send('ping');
  check('heartbeat answered', await guest.next(m => m === 'pong') === 'pong');

  host.socket.close(1000, 'done');
  check('host leaving closes the room for guests (4410)', (await guest.closed).code === 4410);

  const late = open('role=guest');
  check('the room is gone afterwards (4404)', (await late.closed).code === 4404);
} catch (error) {
  check('no step timed out', false, error.message);
}
console.log(`\n${results.filter(Boolean).length}/${results.length} passed, room ${room}`);
process.exit(results.every(Boolean) ? 0 : 1);
