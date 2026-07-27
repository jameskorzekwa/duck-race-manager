import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  hasSupportedDuckNameCharacters,
  isAllowedDuckName,
  publicDuckName,
} from "./duck-name-filter.ts";

// This filter is abuse-facing in both directions. Letting a slur onto the public
// race board at a community event is the obvious failure; rejecting "Bass
// Master", "Cocktail Hour", or "Scunthorpe" is the failure that actually happens
// to ordinary people, so the allowed list below is as much of this file as the
// blocked one.

const blocked = (value, label) =>
  assert.equal(isAllowedDuckName(value), false, `${label}: ${JSON.stringify(value)} must be rejected`);
const allowed = (value, label) =>
  assert.equal(isAllowedDuckName(value), true, `${label}: ${JSON.stringify(value)} must be allowed`);

test("plain profanity and slurs are rejected", () => {
  for (const value of [
    "fuck",
    "Fuck",
    "FUCK",
    "fucking duck",
    "Duck the fuck",
    "shit",
    "bullshit",
    "bitch",
    "cunt",
    "asshole",
    "arsehole",
    "dickhead",
    "motherfucker",
    "whore",
    "slut",
    "pussy",
    "wanker",
    "bollocks",
    "nigger",
    "faggot",
    "kike",
    "chink",
    "wetback",
    "tranny",
    "nazi duck",
    "rapist",
    "porn duck",
  ]) blocked(value, "plain");
});

test("a banned word is rejected as a whole word inside an ordinary sentence", () => {
  for (const value of [
    "Total Ass",
    "The Big Ass",
    "Duck Tits",
    "My Anal Duck",
    "Sir Damn",
    "Crap Duck",
    "Piss Duck",
    "Dick",
    "Twat",
  ]) blocked(value, "word");
});

test("case, accent, and unicode homoglyph evasions are folded away", () => {
  for (const value of [
    "FuCk",
    "fÜck",
    "fúck",
    "ｆｕｃｋ", // fullwidth
    "𝓯𝓾𝓬𝓴", // mathematical script
    "ⓕⓤⓒⓚ", // circled
    "fυck", // Greek upsilon
    "fuсk", // Cyrillic es
    "sнit", // Cyrillic en
    "ѕhit", // Cyrillic dze
    "ßhit", // ligature expansion
  ]) blocked(value, "unicode");
});

test("leetspeak and symbol substitutions are folded away", () => {
  for (const value of [
    "sh1t",
    "5h1t",
    "$hit",
    "@sshole",
    "a$$hole",
    "b1tch",
    "b!tch",
    "c0ck",
    "d1ckhead",
    "n1gger",
    "ni66er",
    "n1663r",
    "pu55y",
    "wh0re",
    "sh!t",
    "bo11ocks", // "1" read as "l"
    "b1tchy",
    "5h!7",
  ]) blocked(value, "leet");
});

test("separator evasions are caught in both the spaced and the stripped form", () => {
  for (const value of [
    "f u c k",
    "f.u.c.k",
    "f-u-c-k",
    "f_u_c_k",
    "f*u*c*k".replaceAll("*", "·"),
    "fu.ck",
    "fu ck",
    "s h i t",
    "a s s",
    "a.s.s",
    "a-s-s",
    "b i t c h",
    "n i g g e r",
  ]) blocked(value, "separator");
});

test("repeated-letter evasions are caught without collapsing innocent doubles", () => {
  for (const value of [
    "fuuuck",
    "fuuuuuuuck",
    "fuckkk",
    "ffuucckk",
    "shiiiit",
    "asss",
    "aassss",
    "biiitch",
  ]) blocked(value, "repeat");
  // The repeat rule lives in the pattern, not in the text, so a doubled letter
  // in an ordinary word is untouched.
  for (const value of ["Cookie", "Cookbook", "Class Act", "Bass Master", "Balloon"]) {
    allowed(value, "innocent double");
  }
});

// ---------------------------------------------------------------------------
// Evasions found by adversarial testing of the first version of this filter.
// Each one of these got through, so each one gets a permanent test.
// ---------------------------------------------------------------------------

test("the supported-character rule refuses symbols, emoji, and private use", () => {
  for (const value of [
    "🖕",
    "Duck 🖕",
    "🦆 Duck",
    "\u{1F595}\u{1F3FB}", // emoji plus a skin-tone modifier
    "★ Duck ★",
    "\uE000 Duck", // private use
    "┌─┐ Duck", // box drawing
    "→ Duck",
    "Duck ™",
    "½ Duck",
    "f\u2758ck", // light vertical bar, a symbol lookalike for "l"/"i"
  ]) {
    blocked(value, "unsupported character");
    assert.equal(hasSupportedDuckNameCharacters(value), false, `${value} characters`);
  }
  // The rule is a character-category rule, never an ASCII rule: letters of any
  // script, their marks, digits, spaces, and a little punctuation all pass.
  for (const value of [
    "Señor Pato",
    "Björn",
    "Renée",
    "Zoë",
    "Grandma’s Duck",
    "Ducky O'Malley",
    "Sir Quacks-a-Lot",
    "Team #7 Duck",
    "Bonnie & Clyde",
    "¡Vamos, Pato!",
    "Really? Yes.",
    "アヒル", // Japanese
    "Утка", // Cyrillic
    "أوزة", // Arabic
    "Πάπια", // Greek
  ]) {
    allowed(value, "supported character");
    assert.equal(hasSupportedDuckNameCharacters(value), true, `${value} characters`);
  }
});

test("consonant substitution readings are caught without collapsing the letters", () => {
  for (const value of [
    "fvck", // "v" for "u"
    "cvnt",
    "slvt",
    "kunt", // "k" for "c"
    "kkunt",
    "azz hole", // "z" for "s", plus a separator
    "azzhole",
    "niqqer", // "q" for "g"
    "kvnt", // two families at once
  ]) blocked(value, "substitution");
  // The readings are alternatives, not a collapse of two letters into one, so
  // every ordinary word that relies on the distinction still passes.
  for (const value of [
    "Spike",
    "Spikeball",
    "Handspike",
    "Marlinespike",
    "Spiky Duck",
    "Spick and Span",
    "Duck Duck Goose",
    "Basket Case",
    "Jazz Hands",
    "Pizza Duck",
    "Buzz Lightyear",
    "Quackers",
    "Quick Quack",
    "Vanilla Duck",
    "Massive Duck",
    "Kayak",
    "Eduskunta",
  ]) allowed(value, "substitution false positive");
});

test("a severe slur is caught with an interior vowel elided, but only tier one", () => {
  for (const value of ["niggr", "wiggr", "faggt", "n1ggr"]) blocked(value, "elision");
  // The same trick applied to general profanity would turn "coon" into "cn" and
  // "gook" into "gk". These ordinary words prove it is not applied there, and
  // that the tier-1 elision itself stays away from real English.
  for (const value of [
    "Banner Duck",
    "Bannerman",
    "Habanera",
    "Ringlet",
    "Singlet",
    "Winglet",
    "Kinglet",
    "Springlet",
    "Singleton",
    "Big Kite",
    "Tenggerese",
    "Shebeener",
  ]) allowed(value, "elision false positive");
});

test("compound insults built on a whole-word term are caught", () => {
  for (const value of [
    "badass",
    "Bad Ass",
    "b a d a s s",
    "dumbass",
    "smartass",
    "asshat",
    "asshead",
    "dickwad",
    "cumshot",
    "arsewipe",
  ]) blocked(value, "compound");
  // The compound list is explicit precisely so that these keep working.
  for (const value of [
    "Class Act",
    "Grass Roots",
    "Bass Master",
    "Assassin",
    "Massachusetts",
    "Assessment",
    "Assortment",
    "Assurance",
    "Compass Rose",
    "Dickens",
    "Dickinson",
    "Cucumber",
    "Cumin Seed",
    "Circumstance",
    "Arsenal",
  ]) allowed(value, "compound false positive");
});

test("confusable letters are folded to their plain Latin counterpart", () => {
  for (const value of [
    "ƒuck", // U+0192 latin small letter f with hook
    "ƒ u c k",
    "ıdiot fuck", // dotless i elsewhere in the name
    "ᴄᴜɴᴛ", // latin small capitals
    "ғᴜᴄᴋ", // Cyrillic ghe with stroke plus small capitals
    "ѕһіт", // all Cyrillic
    "ЬιтсН", // mixed Greek and Cyrillic
    "fυck", // Greek upsilon
    "ѕhеmale",
  ]) blocked(value, "confusable");
});

test("the surnames and words a first-pass filter wrongly blocked are allowed", () => {
  for (const value of [
    // Cockburn is the canonical Scunthorpe surname; it is also a place, a port,
    // and a range of hills.
    "Cockburn",
    "Cockburn Duck",
    "Claire Cockburn",
    "Cockcroft",
    "Cockermouth",
    "Alcock",
    "Hiscock",
    "Wilcock",
    "Cockaigne",
    "Shinnecock Bay",
    "Cockatiel",
    "Cockateel",
    // "shitake" is how most menus spell "shiitake", and a mushroom-themed duck
    // is innocent.
    "Shitake Mushroom",
    "Shitake",
    "Shiitake Mushroom",
    "Cushitic",
    "Washita River",
  ]) allowed(value, "wrongly blocked");
});

test("combined evasions are caught", () => {
  for (const value of [
    "F.U.C.K.",
    "f  u  c  k",
    "$ H 1 T",
    "n 1 g g 3 r",
    "A$$H0LE",
    "ⓕ.ⓤ.ⓒ.ⓚ",
    "  FuCkInG   dUcK  ",
  ]) blocked(value, "combined");
});

// ---------------------------------------------------------------------------
// The Scunthorpe problem. Every one of these must be allowed.
// ---------------------------------------------------------------------------

test("ordinary words containing a banned substring are allowed", () => {
  for (const value of [
    // "ass"
    "Assassin",
    "Assassins Creed",
    "Class Act",
    "Classic Duck",
    "Grass Roots",
    "Grasshopper",
    "Bass Master",
    "Bassoon",
    "Brass Band",
    "Glass Slipper",
    "Compass Rose",
    "Passenger",
    "Passion Fruit",
    "Massive Duck",
    "Molasses",
    "Potassium",
    "Embassy Row",
    "Cassidy",
    "Cassandra",
    "Lassie",
    "Sassy Duck",
    "Assemble",
    "Assessment",
    "Assistant",
    "Associate",
    "Assortment",
    "Assume Nothing",
    "Harassment",
    "Carcass Creek",
    "Cutlass Supreme",
    "Fast As Lightning",
    // "cock"
    "Cocktail Hour",
    "Hancock",
    "Hitchcock",
    "Peacock",
    "Woodcock",
    "Shuttlecock",
    "Cockatoo",
    "Cockatiel",
    "Cocker Spaniel",
    "Cockroach",
    "Cockpit Crew",
    "Cockney Duck",
    "Gamecock",
    "Poppycock",
    "Weathercock",
    "Cocky Duck",
    // "cunt"
    "Scunthorpe",
    "Scunthorpe United",
    // "shit"
    "Shiitake Mushroom",
    "Shiite",
    // "anal"/"anus"
    "Analysis Paralysis",
    "Analyst Duck",
    "Analog Duck",
    "Canal Boat",
    "Banal Duck",
    "Manual Override",
    "Uranus",
    // "rape"/"rapist"
    "The Therapist",
    "Physiotherapist",
    "Therapy Duck",
    "Grape Soda",
    "Grapefruit",
    "Drapes",
    "Scrape By",
    "Trapeze Artist",
    "Trappist Ale",
    // "spic"
    "Spicy Duck",
    "Spice Girl",
    "Aspic",
    "Suspicious Duck",
    "Auspicious Start",
    "Inauspicious Start",
    "Conspicuous Duck",
    "Despicable Duck",
    "Hospice",
    // "coon"
    "Raccoon",
    "Racoon",
    "Tycoon",
    "Cocoon",
    "Lagoon",
    // "nigg"
    "Niggardly",
    "Snigger",
    // "dick"
    "Dickens",
    "Dickinson",
    "Dickerson",
    // "clit"/"penis" place names, the canonical examples of this problem
    "Clitheroe",
    "Penistone",
    // "twat"
    "Lightwater",
    "Cutwater",
    // "wank"
    "Swanky Duck",
    // "prick"
    "Prickly Pear",
    // "tit"
    "Titan",
    "Titanic",
    "Title Fight",
    "Lake Titicaca",
    // "cum"
    "Cumin Seed",
    "Cucumber",
    "Circumstance",
    "Document Duck",
    // "sex"
    "Sussex Duck",
    "Essex Duck",
    "Middlesex",
    "Sexton",
    // "arse"
    "Arsenal",
    // "porn"
    "Popcorn",
    // "hoe"
    "Hoedown",
    "Shoehorn",
    // "retard"
    "Flame Retardant",
    // "boob"
    "Booby Bird",
  ]) allowed(value, "scunthorpe");
});

test("ordinary duck names are allowed", () => {
  for (const value of [
    "Sir Quacks-a-Lot",
    "Bubbles",
    "Ducky McDuckface",
    "Quackers",
    "Waddles",
    "Mr. Feathers",
    "Puddle Jumper",
    "Sir Paddington",
    "Duck Norris",
    "Quackzilla",
    "The Duckinator",
    "Count Duckula",
    "Quack Sparrow",
    "Mallard of Honor",
    "Rubber Ducky",
    "Splash",
    "Nugget",
    "Marshmallow",
    "Pancake",
    "Waffles",
    "Lightning McQuack",
    "Señor Pato",
    "Grandma’s Duck",
    "Team #7 Duck",
    "José",
    "Zoë",
    "Renée",
    "Björn",
    "Ducky O'Malley",
    "L’il Bill",
    "Lily",
    "Ali",
    "Bo",
    "Ed",
    "A",
  ]) allowed(value, "ordinary");
});

test("the predicate reports only a decision and never the matched term", () => {
  assert.equal(typeof isAllowedDuckName("fuck"), "boolean");
  assert.equal(typeof isAllowedDuckName("Bubbles"), "boolean");
  // A non-string can never be allowed, and never throws.
  for (const value of [null, undefined, 12, {}, []]) {
    assert.equal(isAllowedDuckName(value), false, String(value));
    assert.equal(hasSupportedDuckNameCharacters(value), false, String(value));
  }
  // The alphabet rule reports only a decision too, never the offending
  // character, so an API message built on it cannot echo the attempt back.
  assert.equal(typeof hasSupportedDuckNameCharacters("🖕"), "boolean");
  assert.equal(typeof hasSupportedDuckNameCharacters("Bubbles"), "boolean");
});

test("the read-time helper trims, collapses, and suppresses", () => {
  assert.equal(publicDuckName("  Sir   Quacks-a-Lot  "), "Sir Quacks-a-Lot");
  assert.equal(publicDuckName("Bubbles"), "Bubbles");
  // Values that must never reach a public surface.
  assert.equal(publicDuckName("Fucking Duck"), null);
  assert.equal(publicDuckName("sh1t"), null);
  // A row stored before a rule existed is suppressed by every rule, including
  // the alphabet one and the readings added after those rows were written.
  assert.equal(publicDuckName("🖕"), null);
  assert.equal(publicDuckName("Duck 🖕"), null);
  assert.equal(publicDuckName("fvck"), null);
  assert.equal(publicDuckName("azz hole"), null);
  assert.equal(publicDuckName("ƒuck"), null);
  assert.equal(publicDuckName("niggr"), null);
  assert.equal(publicDuckName("Cockburn"), "Cockburn");
  assert.equal(publicDuckName("Shitake Mushroom"), "Shitake Mushroom");
  assert.equal(publicDuckName(null), null);
  assert.equal(publicDuckName(undefined), null);
  assert.equal(publicDuckName(""), null);
  assert.equal(publicDuckName("   "), null);
  assert.equal(publicDuckName(12), null);
  // Defensive against a legacy row: control and zero-width characters are
  // suppressed even though the write path has always rejected them.
  assert.equal(publicDuckName("Bub\u0000bles"), null);
  assert.equal(publicDuckName("Bub\u200dbles"), null);
  assert.equal(publicDuckName("Bub\u202ebles"), null);
});

test("the filter module is pure, dependency-free, and silent", () => {
  const source = readFileSync(new URL("./duck-name-filter.ts", import.meta.url), "utf8");
  // No imports at all: it must not reach a network, a binding, or a package.
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /\brequire\(/);
  assert.doesNotMatch(source, /\bfetch\(/);
  // It never logs, so an attempted name cannot leak through a log line.
  assert.doesNotMatch(source, /console\./);
  // It exports exactly the predicate, the alphabet rule, and the read-time
  // helper.
  assert.deepEqual(
    [...source.matchAll(/^export const (\w+)/gm)].map((match) => match[1]).sort(),
    ["hasSupportedDuckNameCharacters", "isAllowedDuckName", "publicDuckName"],
  );
  // The wordlists stay in one clearly marked, editable place.
  assert.match(source, /WORDLISTS — THE ONE PLACE TO EDIT/);
  for (const list of ["SEVERE_SLURS", "PROFANITY", "COMPOUNDS", "ALLOWLIST"]) {
    assert.match(source, new RegExp(`const ${list}`), list);
  }
});

test("the filter is fast enough to run on every read", () => {
  // Deliberately includes names that exercise every substitution family, which
  // is the expensive path: they cannot collapse onto the plain reading.
  const names = [
    "Sir Quacks-a-Lot",
    "Shiitake Mushroom",
    "f u c k",
    "Scunthorpe United",
    "Quizzical Kayak Viking",
    "Buzzy Kwik Vex Quack",
  ];
  const started = performance.now();
  for (let index = 0; index < 2000; index += 1) isAllowedDuckName(names[index % names.length]);
  // Names are at most 40 characters; a read-time check must not be a cost that
  // makes anyone want to remove the safety net.
  assert.ok(performance.now() - started < 2000, "8000 checks should be far below two seconds");
});
