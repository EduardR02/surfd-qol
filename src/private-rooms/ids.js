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

export function parseRoomCode(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let text = value.trim();
  if (/^https?:\/\//i.test(text)) {
    let url;
    try { url = new URL(text); } catch { return null; }
    if (url.origin !== 'https://surfd.net' || url.pathname !== '/') return null;
    text = url.searchParams.get('join') ?? '';
  }
  text = text.toLowerCase().replace(/[\s-]+/g, '');
  if (text.length === 13 && text.startsWith('p')) text = text.slice(1);
  const id = 'p-' + text;
  return isPrivateRoomId(id) ? id : null;
}

export function formatRoomCode(id) {
  if (!isPrivateRoomId(id)) throw new Error('Invalid private room identifier.');
  const code = id.slice(2).toUpperCase();
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}

export const inviteLink = id => {
  if (!isPrivateRoomId(id)) throw new Error('Invalid private room identifier.');
  return `https://surfd.net/?join=${id}`;
};
