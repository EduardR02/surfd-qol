import {describe, expect, test} from 'bun:test';
import {formatRoomCode, inviteLink, parseRoomCode} from '../src/private-rooms/ids.js';

const ROOM = 'p-7gr63s7yfb9p';

describe('community room codes', () => {
  test('typed codes and site invite links resolve to the same room', () => {
    for (const input of ['7gr63s7yfb9p', 'P-7GR63S7YFB9P', ' 7GR6-3S7Y-FB9P ', '7gr6 3s7y fb9p',
      'https://surfd.net/?join=p-7gr63s7yfb9p', 'https://surfd.net/?join=P-7GR6-3S7Y-FB9P&other=1']) {
      expect(parseRoomCode(input)).toBe(ROOM);
    }
    expect(parseRoomCode(formatRoomCode(ROOM))).toBe(ROOM);
    expect(parseRoomCode(inviteLink(ROOM))).toBe(ROOM);
  });

  test('rejects foreign links, non-room ids and ambiguous characters', () => {
    for (const input of [null, 12, '', 'eu', 'p-000000000000', 'llllllllllll', '7gr63s7yfb9',
      '7gr63s7yfb9pp', 'https://evil.example/?join=' + ROOM, 'https://surfd.net.evil.example/?join=' + ROOM,
      'https://surfd.net/other?join=' + ROOM, 'http://surfd.net/?join=' + ROOM,
      'https://surfd.net/?join=%E0%A4%A', 'x'.repeat(2049)]) {
      expect(parseRoomCode(input)).toBeNull();
    }
    expect(() => inviteLink('eu')).toThrow();
    expect(() => formatRoomCode('eu')).toThrow();
  });
});
