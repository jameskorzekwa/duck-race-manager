import assert from "node:assert/strict";
import test from "node:test";

import {
  DUCK_NAME_ADJECTIVES,
  DUCK_NAME_NOUNS,
  duckNameFromIndexes,
} from "./duck-name-suggestions.ts";
import { isAllowedDuckName, publicDuckName } from "./duck-name-filter.ts";
import { cleanDuckName, DUCK_NAME_MAX_LENGTH } from "./registration.ts";

const everyCombination = function* () {
  for (const [adjectiveIndex] of DUCK_NAME_ADJECTIVES.entries()) {
    for (const [nounIndex] of DUCK_NAME_NOUNS.entries()) {
      yield duckNameFromIndexes(adjectiveIndex, nounIndex);
    }
  }
};

test("both word lists are non-empty and free of duplicates", () => {
  assert.ok(DUCK_NAME_ADJECTIVES.length > 0);
  assert.ok(DUCK_NAME_NOUNS.length > 0);
  assert.equal(new Set(DUCK_NAME_ADJECTIVES).size, DUCK_NAME_ADJECTIVES.length);
  assert.equal(new Set(DUCK_NAME_NOUNS).size, DUCK_NAME_NOUNS.length);
});

test("every word is already normalized, so a suggestion needs no cleanup", () => {
  for (const word of [...DUCK_NAME_ADJECTIVES, ...DUCK_NAME_NOUNS]) {
    assert.equal(word, word.trim().replace(/\s+/g, " "), `"${word}" is not normalized`);
    assert.ok(word.length > 0, "a word list entry is empty");
  }
});

// The contract that makes the suggest button safe to press: the participant can
// accept any suggestion and the write endpoint will take it. `cleanDuckName`
// and `isAllowedDuckName` are exactly the two gates `POST
// /api/v1/registrations/mine/duck-name` applies before it writes.
test("every suggestion survives the same gates the write endpoint applies", () => {
  let checked = 0;
  for (const name of everyCombination()) {
    checked += 1;
    assert.ok(
      name.length <= DUCK_NAME_MAX_LENGTH,
      `"${name}" is ${name.length} characters, over the ${DUCK_NAME_MAX_LENGTH} limit`,
    );
    assert.equal(cleanDuckName(name), name, `cleanDuckName changed or refused "${name}"`);
    assert.ok(isAllowedDuckName(name), `the duck-name filter refuses "${name}"`);
  }
  assert.equal(checked, DUCK_NAME_ADJECTIVES.length * DUCK_NAME_NOUNS.length);
});

// Read-time filtering runs again wherever a name is projected. A suggestion
// that stored fine but was suppressed on the board would be worse than useless.
test("every suggestion also survives the read-time public projection", () => {
  for (const name of everyCombination()) {
    assert.equal(publicDuckName(name), name, `publicDuckName suppresses "${name}"`);
  }
});

test("duckNameFromIndexes wraps rather than producing undefined", () => {
  const wrapped = duckNameFromIndexes(DUCK_NAME_ADJECTIVES.length, DUCK_NAME_NOUNS.length);
  assert.equal(wrapped, duckNameFromIndexes(0, 0));
  assert.ok(!wrapped.includes("undefined"));
});
