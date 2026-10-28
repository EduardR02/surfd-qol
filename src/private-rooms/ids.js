const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const ROOM_ID = /^p-[abcdefghjkmnpqrstuvwxyz23456789]{12}$/;

export function createRoomId() {
  const bytes = new Uint8Array(24);
  let id = 'p-';
  while (id.length < 14) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      // Rejection sampling keeps every character equally likely.
      if (byte >= 256 - 256 % ALPHABET.length) continue;
      id += ALPHABET[byte % ALPHABET.length];
      if (id.length === 14) break;
    }
  }
  return id;
}

export function isPrivateRoomId(value) {
  return typeof value === 'string' && ROOM_ID.test(value);
}
