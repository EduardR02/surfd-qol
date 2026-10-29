import {describe, expect, test} from 'bun:test';
import {maskChat} from '../src/private-rooms/chat-filter.js';
import {CHAT_FILTER_WORDS} from '../src/private-rooms/chat-filter-words.js';

describe('private room chat filter', () => {
  test('masks every curated entry as a whole word without changing its length', () => {
    for (const word of CHAT_FILTER_WORDS) {
      const text = `before ${word}! after`;
      const filtered = maskChat(text);
      expect(filtered).toBe(`before ${'*'.repeat(word.length)}! after`);
      expect(filtered.length).toBe(text.length);
    }
  });

  test('matches case, repeated letters, and common character substitutions', () => {
    for (const text of [
      'FUUUUCK', 'n!gg3r', 'n1gger', 'fuck7@rd', 'b@stard', 'b4stard',
      'b3llend', 'b!tch', 'wh0re', 'c000n', 'ba$7ard', 'ba57ard', 'fuck5', 'sh1t',
    ]) {
      expect(maskChat(text)).toBe('*'.repeat(text.length));
    }
  });

  test('preserves trailing punctuation and surrounding text', () => {
    expect(maskChat('FUCK!!!')).toBe('****!!!');
    expect(maskChat('FUCK$')).toBe('****$');
    expect(maskChat('paki!!!')).toBe('****!!!');
    expect(maskChat('pak!')).toBe('****');
    expect(maskChat('“FUCK,” she said.')).toBe('“****,” she said.');
    expect(maskChat('hello/fuck? yes')).toBe('hello/****? yes');
  });

  test('uses Unicode-aware whole-word boundaries', () => {
    const words = [
      'prefuck', 'fuck2', '2fuck', '_fuck', 'fuck_', 'éfuck', 'fucké', 'fuck\u0301',
      'niggerish', 'niger', 'Scunthorpe', 'class', 'assassin', 'cocktail',
    ];
    for (const text of words) expect(maskChat(text)).toBe(text);
    expect(maskChat('🛹FUCK🛹')).toBe('🛹****🛹');
  });
});
