// Random duck names offered to participants who would rather not think of one.
//
// The two word lists are the single source of truth. `client-scripts.ts`
// serialises them into the browser bundle so a suggestion costs no request, and
// `duck-name-suggestions.test.mjs` asserts that every one of the possible
// combinations survives `cleanDuckName` and `isAllowedDuckName` unchanged. That
// test is the contract: a suggestion the participant accepts must always be a
// name the write endpoint would accept, so pressing the button can never lead
// to a rejection the participant did not cause.
//
// Keep both lists free of anything that reads as a person's name, a place, or a
// slur under the filter's substitution readings. Adding a word is cheap; the
// test will tell you immediately if a pairing is refused or overruns the
// 40-character bound.

export const DUCK_NAME_ADJECTIVES: readonly string[] = [
  "Admiral",
  "Bold",
  "Bouncy",
  "Brave",
  "Bubbly",
  "Captain",
  "Cheerful",
  "Clever",
  "Cosmic",
  "Dapper",
  "Daring",
  "Dashing",
  "Dizzy",
  "Doctor",
  "Fancy",
  "Fearless",
  "Fluffy",
  "Galactic",
  "Gentle",
  "Giggly",
  "Grumpy",
  "Happy",
  "Jolly",
  "Lucky",
  "Majestic",
  "Mighty",
  "Noble",
  "Peppy",
  "Plucky",
  "Professor",
  "Rapid",
  "Regal",
  "Rowdy",
  "Royal",
  "Rusty",
  "Sleepy",
  "Snappy",
  "Speedy",
  "Splashy",
  "Sunny",
  "Swift",
  "Thunderous",
  "Turbo",
  "Wobbly",
  "Zippy",
];

export const DUCK_NAME_NOUNS: readonly string[] = [
  "Beak",
  "Bill",
  "Bubbles",
  "Cannonball",
  "Current",
  "Dabbler",
  "Doodle",
  "Drake",
  "Dumpling",
  "Feather",
  "Fizz",
  "Flapjack",
  "Flipper",
  "Float",
  "Honker",
  "Mallard",
  "Marshmallow",
  "Nibbles",
  "Noodle",
  "Paddle",
  "Pancake",
  "Pebble",
  "Pond Star",
  "Puddle",
  "Quackers",
  "Quill",
  "Rapids",
  "Ripple",
  "Rubber Duck",
  "Skipper",
  "Splash",
  "Sprinkle",
  "Squeak",
  "Tadpole",
  "Torpedo",
  "Waddle",
  "Waffle",
  "Wake",
  "Waterwing",
  "Whistle",
];

// Deterministic given the two indexes, so the browser and the tests build the
// same string from the same pair.
export const duckNameFromIndexes = (
  adjectiveIndex: number,
  nounIndex: number,
): string =>
  `${DUCK_NAME_ADJECTIVES[adjectiveIndex % DUCK_NAME_ADJECTIVES.length]} `
  + `${DUCK_NAME_NOUNS[nounIndex % DUCK_NAME_NOUNS.length]}`;
