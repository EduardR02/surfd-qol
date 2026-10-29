import {CHAT_FILTER_WORDS} from './chat-filter-words.js';

const SUBSTITUTIONS = Object.freeze({
  '@': 'a', '4': 'a',
  '3': 'e',
  '1': 'i', '!': 'i',
  '0': 'o',
  '$': 's', '5': 's',
  '7': 't',
});
const WORD_CHARACTER = /^[\p{L}\p{N}\p{M}_]$/u;

function normalizedCharacter(codePoint) {
  const character = String.fromCodePoint(codePoint).toLowerCase();
  return character.length === 1 ? (SUBSTITUTIONS[character] ?? character) : character;
}

function createPattern(word) {
  const pattern = [];
  for (const character of word) {
    const normalized = normalizedCharacter(character.codePointAt(0));
    const previous = pattern.at(-1);
    if (previous?.character === normalized) previous.minimum += 1;
    else pattern.push({character: normalized, minimum: 1});
  }
  return pattern;
}

const FILTER_PATTERNS = CHAT_FILTER_WORDS.map(createPattern);

function isWordCharacterAt(text, index) {
  if (index >= text.length) return false;
  return WORD_CHARACTER.test(String.fromCodePoint(text.codePointAt(index)));
}

function matchPatternAt(text, start, pattern) {
  let index = start;
  for (let group = 0; group < pattern.length; group++) {
    const {character, minimum} = pattern[group];
    let count = 0;
    while (index < text.length) {
      const codePoint = text.codePointAt(index);
      if (normalizedCharacter(codePoint) !== character) break;
      // Once the spelling is complete, punctuation is not another repeated letter.
      if (group === pattern.length - 1 && count >= minimum && !isWordCharacterAt(text, index)) break;
      count += 1;
      index += codePoint > 0xffff ? 2 : 1;
    }
    if (count < minimum) return -1;
  }
  return isWordCharacterAt(text, index) ? -1 : index;
}

export function maskChat(text) {
  let cursor = 0;
  let copiedThrough = 0;
  let previousIsWord = false;
  let chunks;

  while (cursor < text.length) {
    if (!previousIsWord) {
      let end = -1;
      for (const pattern of FILTER_PATTERNS) {
        end = matchPatternAt(text, cursor, pattern);
        if (end >= 0) break;
      }
      if (end >= 0) {
        if (chunks === undefined) chunks = [];
        chunks.push(text.slice(copiedThrough, cursor), '*'.repeat(end - cursor));
        cursor = end;
        copiedThrough = end;
        previousIsWord = true;
        continue;
      }
    }

    const codePoint = text.codePointAt(cursor);
    previousIsWord = WORD_CHARACTER.test(String.fromCodePoint(codePoint));
    cursor += codePoint > 0xffff ? 2 : 1;
  }

  if (chunks === undefined) return text;
  chunks.push(text.slice(copiedThrough));
  return chunks.join('');
}
