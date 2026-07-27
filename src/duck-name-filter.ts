// Participant-chosen duck names are public, so this module decides whether one
// may be shown. It is pure and dependency-free on purpose: it runs inside the
// Worker on every write and on every read-time projection, so it must add no
// latency, no cost, no third-party dependency, and it must never send a
// participant's text off-platform to a moderation API.
//
// HOW MATCHING WORKS
//
// 0. RESTRICT THE ALPHABET (`hasSupportedDuckNameCharacters`). This is the
//    highest-leverage rule in the module, and it runs before any of the
//    matching below. A name is letters, the marks that go with them, digits,
//    spaces, and a little punctuation. Symbols, emoji, private-use characters,
//    box drawing, arrows, and every other category are refused outright,
//    because a duck name has no use for them and every one of those blocks is
//    an open-ended supply of new letter-lookalikes that no wordlist could ever
//    catch up with. Unicode LETTERS stay allowed on purpose, so "José", "Zoë",
//    "Björn", "Señor Pato", and non-Latin scripts are unaffected: this is a
//    category rule, not an ASCII rule.
//
// 1. NORMALIZE (`normalize`). One pipeline folds away the usual evasions:
//    control/format characters are dropped, NFKD plus combining-mark stripping
//    folds accents and compatibility forms ("Ｆ", "𝓯", "ｆｕｃｋ", "fúck"), the text
//    is casefolded, and a table maps leetspeak and confusables to plain Latin
//    ("0"->"o", "3"->"e", "$"->"s", Cyrillic "а"->"a", Greek "ο"->"o", the
//    small capitals "ᴜ"->"u", and hooked or turned Latin letters NFKD leaves
//    alone such as "ƒ"->"f" and "ı"->"i").
//
// 2. READ THE NAME SEVERAL WAYS, AND REJECT ON A HIT IN ANY OF THEM.
//      - "1", "!", "|", and "¡" are genuinely ambiguous — they stand for "i" or
//        for "l" — so the name is read once each way.
//      - Some substitutions are one-way evasions rather than ambiguities:
//        "fvck", "azz", "kunt", "niqqer". Each of those is a SUBSTITUTION
//        FAMILY ("v"->"u", "z"->"s", "k"->"c", "q"->"g") applied to the whole
//        text or not at all, once for every subset of the families.
//    These are alternative READINGS, never a collapse of two letters into one.
//    Collapsing is what makes "kike" match "duck-like", "clit" match
//    "facility", and "spike" match "spic"; alternative readings do not, because
//    the plain reading is always evaluated as well and each substituted reading
//    loses the source letter it consumed.
//
// 3. SPLIT INTO THE THREE REQUIRED FORMS. Everything that is not a letter after
//    folding is a separator, which yields:
//      - `tokens`   — the separator-preserving form, used for word matching.
//      - `merged`   — `tokens` with runs of single-letter tokens joined, so
//                     "f u c k" and "a-s-s" become one word without inventing
//                     word boundaries anywhere else.
//      - `stripped` — every token concatenated, the separator-stripped form,
//                     so "f.u.c.k", "fu-ck", and "azz hole" are matched too.
//
// 4. SCRUB THE ALLOWLIST FIRST. A token that is an innocent word is removed
//    before any matching, which is what keeps "Scunthorpe", "shiitake",
//    "Cockburn", "cocktail", and "therapist" out of the wordlists' way. A token
//    counts as innocent when EITHER its plain spelling or its substituted
//    spelling is allowlisted, so "spick" survives the "k"->"c" reading as
//    itself and "spike" survives it as "spice". See ALLOWLIST.
//
// 5. MATCH IN TIERS.
//      - Tier 1 (SEVERE_SLURS) matches anywhere, including inside a word, and
//        additionally matches a VOWEL-ELIDED spelling ("niggr", "fggot"). That
//        elision is deliberately tier-1 only: applied to general profanity it
//        turns "coon" into "cn" and "gook" into "gk" and starts rejecting
//        ordinary names. Even here it is guarded — a variant is only used when
//        it is still at least five letters long and still contains a vowel.
//      - Tier 2 (PROFANITY) carries a per-term `mode`, because "match anywhere"
//        is only safe for a distinctive letter sequence:
//          "anywhere" — the sequence is distinctive ("fuck", "bitch", "rapist").
//          "word"     — the sequence occurs inside ordinary English words, so it
//                       only matches a whole word ("ass" in "bass", "class",
//                       "passenger", "Cassidy"; "tit" in "title", "titan"). A
//                       "word" term still matches the merged form and a whole
//                       stripped name, so "a s s" and "a.s.s" are caught.
//      - A "word" term may also carry a COMPOUNDS entry, a short explicit list
//        of the words that build a compound insult around it, so "badass",
//        "asshat", and "dickwad" match as whole words while "class", "grass",
//        "bass", "assassin", and "Massachusetts" stay untouched. The list is
//        explicit rather than a rule precisely because a rule here is what
//        rejects real words.
//
// REPEATED LETTERS are handled on the pattern side rather than by collapsing the
// text: each term becomes a regular expression whose every letter is `+`, so
// "fuuuuck" and "assss" match while an innocent doubled letter is never damaged.
// Collapsing the text instead would turn "cookie" into "cokie" and "class" into
// "clas", which is exactly how a naive filter starts rejecting real names.
//
// KNOWN AND ACCEPTED LIMITS. Concatenating tokens can create a match that
// neither word contained ("crisp icing"), and removing an allowlisted word can
// hide a match that spanned it ("bass hole", and now "bazz hole" with it). A
// substitution reading is all-or-nothing per family, so a term that itself
// contains the swapped letter is only caught in the readings that leave that
// letter alone. All of these are inherent to this class of filter, all are rare
// in a 40-character duck name, and staff moderation (clearing a name) is the
// deliberate backstop for everything a wordlist misses.
//
// THE WORDLISTS ARE AUDITED, NOT GUESSED. Every change here is checked against
// /usr/share/dict/words, because the failure that actually reaches a real
// person is a rejected ordinary name, not a slur that slipped past. At the time
// of writing that audit rejects 538 of 235,976 words (0.23%), nearly all of
// them archaic entries no one would name a duck.
//
// This module never reports which term matched, to a caller or to a log.

// ---------------------------------------------------------------------------
// WORDLISTS — THE ONE PLACE TO EDIT
//
// To extend the filter, add a lowercase, letters-only term to the right list
// below and nothing else; normalization, evasion folding, and repeated-letter
// handling are applied automatically.
//
//   SEVERE_SLURS  Tier 1. Matched anywhere, including inside another word, and
//                 also in a vowel-elided spelling. Use this only for terms that
//                 are unacceptable in any context.
//   PROFANITY     Tier 2. `mode: "anywhere"` for a distinctive sequence;
//                 `mode: "word"` when the sequence also occurs inside ordinary
//                 words. When in doubt choose "word" and, if a real-world word
//                 still trips, add that word to ALLOWLIST.
//   COMPOUNDS     The words that build a compound insult around a short
//                 `mode: "word"` term. Keep these lists to parts that only ever
//                 appear in an insult; anything vaguer belongs nowhere near it.
//   ALLOWLIST     Innocent whole words that contain a banned sequence. Entries
//                 are removed from the text before matching, and common English
//                 prefixes ("un-", "in-", "non-") and suffixes ("-s", "-es",
//                 "-ed", "-ing", "-er", "-y", "-ly", "-ness") are accepted
//                 automatically, so list the base word only.
//
// The lists are deliberately short: they cover common English profanity, the
// severe slurs, and the obvious evasions, rather than trying to be exhaustive.
// ---------------------------------------------------------------------------

const SEVERE_SLURS: readonly string[] = [
  "nigger",
  "nigga",
  "niglet",
  "jigaboo",
  "wigger",
  "coon",
  "kike",
  "chink",
  "gook",
  "spic",
  "wetback",
  "beaner",
  "towelhead",
  "raghead",
  "kaffir",
  "faggot",
  "fagot",
  "tranny",
  "shemale",
];

interface ProfanityTerm {
  term: string;
  mode: "anywhere" | "word";
}

const PROFANITY: readonly ProfanityTerm[] = [
  // Distinctive sequences: safe to match inside a word, so evasion by padding
  // ("xxfuckxx") does not work.
  { term: "fuck", mode: "anywhere" },
  { term: "fuk", mode: "anywhere" },
  { term: "fuq", mode: "anywhere" },
  { term: "phuck", mode: "anywhere" },
  { term: "motherfucker", mode: "anywhere" },
  { term: "shit", mode: "anywhere" },
  { term: "bullshit", mode: "anywhere" },
  { term: "bitch", mode: "anywhere" },
  // Vowel INSERTION is spelled out term by term. Generalizing it the way vowel
  // elision is generalized for tier 1 would match "biotech" from "bitch".
  { term: "biatch", mode: "anywhere" },
  { term: "biotch", mode: "anywhere" },
  { term: "beotch", mode: "anywhere" },
  { term: "cunt", mode: "anywhere" },
  { term: "whore", mode: "anywhere" },
  { term: "slut", mode: "anywhere" },
  { term: "wanker", mode: "anywhere" },
  { term: "wank", mode: "anywhere" },
  { term: "bollock", mode: "anywhere" },
  { term: "arsehole", mode: "anywhere" },
  { term: "asshole", mode: "anywhere" },
  { term: "dickhead", mode: "anywhere" },
  { term: "shithead", mode: "anywhere" },
  { term: "dumbass", mode: "anywhere" },
  { term: "jackass", mode: "anywhere" },
  { term: "cock", mode: "anywhere" },
  { term: "penis", mode: "anywhere" },
  { term: "vagina", mode: "anywhere" },
  { term: "boner", mode: "anywhere" },
  { term: "clit", mode: "anywhere" },
  { term: "pussy", mode: "anywhere" },
  { term: "blowjob", mode: "anywhere" },
  { term: "handjob", mode: "anywhere" },
  { term: "rimjob", mode: "anywhere" },
  { term: "rapist", mode: "anywhere" },
  { term: "molester", mode: "anywhere" },
  { term: "pedophile", mode: "anywhere" },
  { term: "paedophile", mode: "anywhere" },
  { term: "nazi", mode: "anywhere" },
  { term: "titties", mode: "anywhere" },
  { term: "retard", mode: "anywhere" },
  { term: "bastard", mode: "anywhere" },

  { term: "prick", mode: "anywhere" },
  { term: "queef", mode: "anywhere" },
  { term: "felch", mode: "anywhere" },
  { term: "smegma", mode: "anywhere" },
  { term: "scrotum", mode: "anywhere" },
  { term: "testicle", mode: "anywhere" },
  { term: "ejaculate", mode: "anywhere" },
  { term: "masturbate", mode: "anywhere" },
  { term: "porn", mode: "anywhere" },
  { term: "hentai", mode: "anywhere" },

  // Short sequences that live inside ordinary English words. Whole word only.
  { term: "ass", mode: "word" },
  { term: "arse", mode: "word" },
  // "Dickens", "Dickinson", and "Dickerson" are ordinary surnames.
  { term: "dick", mode: "word" },
  { term: "dicks", mode: "word" },
  // "twat" hides inside "cutwater", "outwatch", and the village of Lightwater.
  { term: "twat", mode: "word" },
  { term: "twats", mode: "word" },
  { term: "tit", mode: "word" },
  { term: "tits", mode: "word" },
  { term: "boob", mode: "word" },
  { term: "boobs", mode: "word" },
  { term: "cum", mode: "word" },
  { term: "anal", mode: "word" },
  { term: "anus", mode: "word" },
  { term: "rape", mode: "word" },
  { term: "hoe", mode: "word" },
  { term: "hoes", mode: "word" },
  { term: "fag", mode: "word" },
  { term: "fags", mode: "word" },
  { term: "damn", mode: "word" },
  { term: "goddamn", mode: "word" },
  { term: "crap", mode: "word" },
  { term: "turd", mode: "word" },
  { term: "piss", mode: "word" },
  { term: "poon", mode: "word" },
  { term: "skank", mode: "word" },
  { term: "sex", mode: "word" },
  { term: "sexy", mode: "word" },
  { term: "horny", mode: "word" },
  { term: "nude", mode: "word" },
  { term: "naked", mode: "word" },
];

// Compound insults built around a short whole-word term. Without this, "ass"
// matches "Total Ass" but not "badass", because matching "ass" inside a word
// would reject "class", "grass", "bass", "assassin", and "Massachusetts".
// An explicit list of parts is the safe way to have both: a token matches when
// it is exactly one listed `before` word plus the term, or the term plus one
// listed `after` word. Every part below is a word that only ever turns up in
// an insult, which is what keeps the rule from leaking into ordinary English.
interface CompoundTerm {
  term: string;
  before: readonly string[];
  after: readonly string[];
}

const COMPOUNDS: readonly CompoundTerm[] = [
  {
    term: "ass",
    before: [
      "bad", "big", "candy", "dumb", "dum", "fat", "half", "hard", "horse",
      "jack", "kick", "kiss", "lame", "lard", "pain", "punk", "smart", "sorry",
      "stupid", "tight", "wise",
    ],
    after: [
      "bag", "bags", "clown", "clowns", "face", "faces", "hat", "hats", "head",
      "heads", "hole", "holes", "jacket", "kisser", "licker", "monkey", "munch",
      "muncher", "tard", "wipe", "wipes",
    ],
  },
  {
    term: "arse",
    before: ["dumb", "smart"],
    after: ["face", "faces", "head", "heads", "hole", "holes", "licker", "wipe", "wipes"],
  },
  {
    term: "dick",
    before: [],
    after: [
      "bag", "bags", "brain", "cheese", "face", "faces", "head", "heads",
      "hole", "holes", "wad", "wads", "weed",
    ],
  },
  {
    term: "cum",
    before: [],
    after: ["bucket", "dump", "dumpster", "guzzler", "shot", "shots", "stain", "stains"],
  },
];

const ALLOWLIST: readonly string[] = [
  // "ass"
  "assassin",
  "assassination",
  "assault",
  "assemble",
  "assembly",
  "assess",
  "asset",
  "assign",
  "assignment",
  "assist",
  "assistant",
  "associate",
  "association",
  "assorted",
  "assume",
  "assure",
  "bass",
  "brass",
  "carcass",
  "cassidy",
  "class",
  "classic",
  "compass",
  "crass",
  "cutlass",
  "embassy",
  "glass",
  "grass",
  "harass",
  "lass",
  "mass",
  "massive",
  "molasses",
  "morass",
  "pass",
  "passenger",
  "passion",
  "potassium",
  "sassy",
  "wrasse",
  // "cock" — the rooster sense is everywhere in ordinary English
  "cockade",
  "cockatiel",
  "cockatoo",
  "cockatrice",
  "cocked",
  "cocker",
  "cockerel",
  "cockeyed",
  "cockle",
  "cockleshell",
  "cockney",
  "cockpit",
  "cockroach",
  "cocksure",
  "cocktail",
  "cocky",
  "acock",
  "cockapoo",
  "cockamamie",
  "cockalorum",
  "cockchafer",
  "cockcrow",
  "cocksfoot",
  "cockspur",
  "cockswain",
  "cocklebur",
  "cockloft",
  "cockboat",
  "cockhorse",
  "cockscomb",
  "cockshy",
  "cockbill",
  // near neighbours found by auditing the filter against /usr/share/dict/words:
  // birds, hats, plumbing, and ordinary derivations of the rooster sense
  "cockateel",
  "cockbird",
  "cockeye",
  "cockfight",
  "cockily",
  "cockiness",
  "cocking",
  "cockleboat",
  "cocklet",
  "cockshut",
  "cockup",
  "billycock",
  "gorcock",
  "haycock",
  "petcock",
  "pinchcock",
  "spitchcock",
  "stormcock",
  "turncock",
  "uncock",
  "peacockery",
  "peacocklike",
  // "cock" surnames and place names — Cockburn is the classic one
  "cockburn",
  "cockaigne",
  "shinnecock",
  "bawcock",
  "cockcroft",
  "cockerell",
  "cockermouth",
  "cockfield",
  "cockshutt",
  "adcock",
  "alcock",
  "babcock",
  "badcock",
  "blackcock",
  "gamecock",
  "glasscock",
  "hancock",
  "heathcock",
  "hiscock",
  "hitchcock",
  "leacock",
  "meacock",
  "moorcock",
  "peacock",
  "poppycock",
  "shuttlecock",
  "silcock",
  "simcock",
  "spatchcock",
  "stopcock",
  "turkeycock",
  "weathercock",
  "wilcock",
  "woodcock",
  // "cunt"
  "scunthorpe",
  // "shit" — "shitake" is the everyday misspelling of "shiitake", and a
  // mushroom-themed duck has done nothing wrong
  "shiitake",
  "shitake",
  "shiite",
  "shittim",
  "shittah",
  "shittimwood",
  // near neighbours found by the dictionary audit: peoples, places, minerals
  "bereshith",
  "brushite",
  "cushite",
  "cushitic",
  "mackintoshite",
  "marshite",
  "washita",
  // "anal"/"anus"
  "analog",
  "analogue",
  "analogy",
  "analysis",
  "analyst",
  "analytical",
  "analyze",
  "banal",
  "canal",
  "manual",
  // "rape"/"rapist"
  "drape",
  "grape",
  "scrape",
  "therapist",
  "physiotherapist",
  "psychotherapist",
  "therapy",
  "trapeze",
  "trappist",
  // "wank"
  "swank",
  // "pussy"
  "pussycat",
  "pussyfoot",
  "pussytoe",
  // place names that carry a banned sequence, the classic Scunthorpe problem
  "penistone",
  "clitheroe",
  // "prick"
  "prickle",
  "prickly",
  // "retard"
  "retardant",
  "retardation",
  // severe slurs inside innocent words
  "cocoon",
  "raccoon",
  "racoon",
  "tycoon",
  "lagoon",
  "niggard",
  "niggardly",
  "niggle",
  "snigger",
  "pakistan",
  "gobbledygook",
  "chinkapin",
  // "spic" hides in an entire family of ordinary English words
  "aspic",
  "allspice",
  "auspicate",
  "auspice",
  "auspicial",
  "auspicious",
  "conspicuous",
  "despicable",
  "hospice",
  "inconspicuous",
  "spice",
  "spick",
  "suspicion",
  "suspicious",
  // "nazi" inside an ethnonym. Rejecting these reads as bigotry, not moderation.
  "ashkenazi",
  "ashkenazic",
  "ashkenazim",
  // "porn" inside the lovebird genus, which is a plausible bird-themed name.
  "agapornis",
  // "anal" inside ordinary words.
  "annal",
  "annals",
  "banal",
  "banality",
  "canal",
  "cananal",
  // miscellaneous
  "hellenic",
  "titan",
  "titanic",
  "title",
  "cumin",
  "cucumber",
  "circumstance",
  "document",
  "sexton",
  "sussex",
  "essex",
  "middlesex",
  "wessex",
];

// ---------------------------------------------------------------------------
// SUPPORTED CHARACTERS
// ---------------------------------------------------------------------------

// The alphabet a duck name is allowed to be written in: any Unicode letter, the
// combining marks that belong to those letters, decimal digits, space
// separators, and the short punctuation list below.
//
//   ' ’ ‘   apostrophes, for "Ducky O'Malley" and "Grandma’s Duck"
//   - ‐ – — hyphen and dashes, for "Sir Quacks-a-Lot"
//   . , ! ? ¡ ¿  sentence punctuation, including the Spanish opening pair
//   #       for "Team #7 Duck"
//   &       for "Bonnie & Clyde"
//
// Everything else is refused: currency and mathematical symbols, dingbats,
// emoji, private-use characters, box drawing, arrows, and the rest. None of
// them belongs in a name, and each block is an unbounded supply of fresh
// letter-lookalikes, so admitting them would give an attacker an evasion
// surface that no wordlist and no confusable table can close.
//
// Letters of every script stay allowed deliberately. This rule must never
// become an ASCII rule: it has to keep working for names in any language.
const SUPPORTED_CHARACTERS = /^[\p{L}\p{M}\p{Nd}\p{Zs}'’‘\-‐–—.,!?¡¿#&]*$/u;

// Exported so the naming API can explain this rule on its own terms instead of
// telling a participant that "🙂 Duck" reads as profanity. It reports only
// whether the alphabet is acceptable; it never says which character failed.
export const hasSupportedDuckNameCharacters = (value: string): boolean =>
  typeof value === "string" && SUPPORTED_CHARACTERS.test(value);

// ---------------------------------------------------------------------------
// NORMALIZATION
// ---------------------------------------------------------------------------

// Leetspeak, symbol, homoglyph, and ligature folding. Every entry maps one
// source character to plain lowercase Latin letters.
//
// The symbol entries ("@", "$", "+", "€") are unreachable through
// `isAllowedDuckName`, which refuses those characters outright above. They stay
// because folding is the second line of defence: if the supported-character set
// is ever widened, these must not silently become evasions again.
const CHARACTER_FOLDS: Readonly<Record<string, string>> = {
  // leetspeak digits
  "0": "o",
  "3": "e",
  "4": "a",
  "5": "s",
  "6": "g",
  "7": "t",
  "8": "b",
  "9": "g",
  // leetspeak symbols
  "@": "a",
  "$": "s",
  "+": "t",
  "€": "e",
  // ligatures and letters NFKD leaves intact
  "ß": "ss",
  "æ": "ae",
  "œ": "oe",
  "ø": "o",
  "đ": "d",
  "ð": "d",
  "þ": "th",
  "ł": "l",
  // Latin confusables NFKD leaves intact: hooked, turned, barred, and stroked
  // letters that read as their plain counterpart on any screen. "ƒ" (U+0192) is
  // the one an attacker reaches for first.
  "ƒ": "f",
  "ı": "i",
  "ȷ": "j",
  "ǝ": "e",
  "ɐ": "a",
  "ɑ": "a",
  "ɓ": "b",
  "ƈ": "c",
  "ɖ": "d",
  "ɗ": "d",
  "ɠ": "g",
  "ɡ": "g",
  "ɦ": "h",
  "ɩ": "i",
  "ɪ": "i",
  "ƙ": "k",
  "ɱ": "m",
  "ɲ": "n",
  "ɳ": "n",
  "ɵ": "o",
  "ƥ": "p",
  "ʠ": "q",
  "ɽ": "r",
  "ʂ": "s",
  "ƭ": "t",
  "ʈ": "t",
  "ʋ": "v",
  "ʌ": "v",
  "ƴ": "y",
  "ʏ": "y",
  "ƶ": "z",
  "ȥ": "z",
  // Latin small capitals, the "ғᴜᴄᴋ" style of evasion
  "ᴀ": "a",
  "ʙ": "b",
  "ᴄ": "c",
  "ᴅ": "d",
  "ᴇ": "e",
  "ꜰ": "f",
  "ɢ": "g",
  "ʜ": "h",
  "ᴊ": "j",
  "ᴋ": "k",
  "ʟ": "l",
  "ᴍ": "m",
  "ɴ": "n",
  "ᴏ": "o",
  "ᴘ": "p",
  "ꞯ": "q",
  "ʀ": "r",
  "ꜱ": "s",
  "ᴛ": "t",
  "ᴜ": "u",
  "ᴠ": "v",
  "ᴡ": "w",
  "ᴢ": "z",
  // Cyrillic homoglyphs
  "а": "a",
  "в": "b",
  "е": "e",
  "к": "k",
  "м": "m",
  "н": "h",
  "о": "o",
  "р": "p",
  "с": "c",
  "т": "t",
  "у": "y",
  "х": "x",
  "і": "i",
  "ј": "j",
  "ѕ": "s",
  "ь": "b",
  "ԁ": "d",
  "һ": "h",
  "ӏ": "l",
  "ԛ": "q",
  "ԝ": "w",
  "ѵ": "v",
  "ѡ": "w",
  "ғ": "f",
  "ԍ": "g",
  "ө": "o",
  "ѳ": "o",
  "ӡ": "z",
  // Greek homoglyphs
  "α": "a",
  "β": "b",
  "ε": "e",
  "ι": "i",
  "κ": "k",
  "ν": "v",
  "ο": "o",
  "ρ": "p",
  "τ": "t",
  "υ": "u",
  "χ": "x",
  "η": "n",
  "μ": "u",
  "ς": "s",
  "ϲ": "c",
  "ϳ": "j",
  "ω": "w",
  "ζ": "z",
  "ϱ": "p",
  "ϵ": "e",
};

// "1", "!", "|", and "¡" stand for either "i" or "l" depending on the font the
// writer had in mind, so they are resolved per reading rather than merged.
//
// "1", "!", and "¡" are supported characters, so these readings are the only
// thing standing between "b1tch" and the race board. "|" is refused by the
// alphabet rule before it ever reaches here and stays listed for the same
// reason the symbol folds do: it must not become an evasion again if that rule
// is ever widened.
const AMBIGUOUS_CHARACTERS: Readonly<Record<string, true>> = {
  "1": true,
  "!": true,
  "|": true,
  "¡": true,
};

const foldCharacters = (value: string, ambiguousAs: "i" | "l"): string => {
  let folded = "";
  for (const character of value) {
    if (Object.prototype.hasOwnProperty.call(AMBIGUOUS_CHARACTERS, character)) {
      folded += ambiguousAs;
      continue;
    }
    folded += Object.prototype.hasOwnProperty.call(CHARACTER_FOLDS, character)
      ? CHARACTER_FOLDS[character]
      : character;
  }
  return folded;
};

// Casefold, fold accents and compatibility forms, then fold the evasion
// alphabet under one reading of the ambiguous characters.
const normalize = (value: string, ambiguousAs: "i" | "l"): string =>
  foldCharacters(
    value
      .replace(/[\p{Cc}\p{Cf}]/gu, "")
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "")
      .toLowerCase(),
    ambiguousAs,
  );

// Wordlist entries are plain ASCII, so either reading gives the same result.
const normalizeWord = (value: string): string => normalize(value, "i").replace(/[^a-z]+/g, "");

// ---------------------------------------------------------------------------
// SUBSTITUTION READINGS
// ---------------------------------------------------------------------------

// One-way evasions: "fvck", "cvnt", "azz hole", "kunt", "niqqer". Unlike the
// ambiguous characters above these are not two spellings of one glyph, so they
// are handled the same way and for the same reason — as alternative READINGS of
// the whole text rather than by declaring "v" and "u" to be one letter.
//
// The difference matters. Collapsing "k" into "c" everywhere would make "spike"
// read as "spic" and "duck" as "duc"; a reading only ever ADDS a second chance
// to match, because the plain reading is always evaluated too. It also means a
// substituted reading loses the source letter it consumed, so "fuck" is caught
// by the plain reading and "fvck" by the "v"->"u" one.
//
// No family's target is another family's source, so a reading may apply its
// families in any order without one substitution feeding another.
//
// `where` records where the swap is credible. "k" for "c" is a word-INITIAL
// habit ("kunt", "kock", "kum") because that is where English "c" sounds like
// "k". Reading it anywhere instead would turn every ordinary "spik" into
// "spic" and reject "Spikeball", "handspike", and "marlinespike" — a whole
// family of real words bought for an evasion nobody writes. The other three
// swaps have no such collision and are read throughout.
interface SubstitutionFamily {
  from: string;
  to: string;
  where: "anywhere" | "wordStart";
}

const SUBSTITUTION_FAMILIES: readonly SubstitutionFamily[] = [
  { from: "v", to: "u", where: "anywhere" },
  { from: "z", to: "s", where: "anywhere" },
  { from: "k", to: "c", where: "wordStart" },
  { from: "q", to: "g", where: "anywhere" },
];

// Every subset of the families, so a name combining two of them ("kvnt") is
// still read correctly. The first reading is the empty one: the plain text.
const SUBSTITUTION_READINGS: readonly (readonly SubstitutionFamily[])[] =
  SUBSTITUTION_FAMILIES.reduce<SubstitutionFamily[][]>(
    (readings, family) => [...readings, ...readings.map((reading) => [...reading, family])],
    [[]],
  );

// A word-initial family replaces the leading RUN rather than one letter, so the
// repeated-letter trick cannot be stacked on top of the substitution ("kkunt").
const leadingRunPatterns = new Map(
  SUBSTITUTION_FAMILIES
    .filter((family) => family.where === "wordStart")
    .map((family) => [family.from, new RegExp(`^${family.from}+`)]),
);

const applyReading = (token: string, reading: readonly SubstitutionFamily[]): string => {
  let result = token;
  for (const family of reading) {
    const leadingRun = leadingRunPatterns.get(family.from);
    result = leadingRun === undefined
      ? result.replaceAll(family.from, family.to)
      : result.replace(leadingRun, family.to);
  }
  return result;
};

// ---------------------------------------------------------------------------
// PATTERNS
// ---------------------------------------------------------------------------

// Every letter of a term becomes `letter+`, which is how repeated-letter
// evasion ("fuuuck", "assss") is defeated without collapsing the text itself.
const termPattern = (term: string): string =>
  [...normalizeWord(term)].map((letter) => `${letter}+`).join("");

// The tiers are compiled into one alternation each. Matching now runs once per
// reading rather than once per term per reading, which is what keeps the extra
// readings affordable on a check that runs on every read as well as every write.
const anyOf = (patterns: readonly string[]): RegExp => new RegExp(patterns.join("|"));
const wholeWordAnyOf = (patterns: readonly string[]): RegExp =>
  new RegExp(`^(?:${patterns.join("|")})$`);

const VOWELS = "aeiou";

// Vowel elision, tier 1 only: "nigger" is also written "niggr", "wigger" as
// "wiggr", "faggot" as "faggt". A variant drops exactly ONE interior vowel and
// is kept only when all three guards below hold. Every one of them was put
// there by the dictionary audit, because a tier-1 pattern matches anywhere
// inside a name and a sloppy variant is therefore a very expensive mistake.
//
//  1. The elided vowel must follow a DOUBLED consonant. That is both the shape
//     people actually write and the shape that survives matching anywhere: the
//     surviving cluster ("ggr", "ggt", "ffr") is rare in English. Dropping the
//     other vowels instead produces "ngger", "nglet", and "baner", which — with
//     the repeated-letter rule on top — reject "Tenggerese", "ringlet",
//     "singlet", "winglet", "banner", and "habanera".
//  2. At least five letters must survive, so "coon" cannot become "cn" and
//     "gook" cannot become "gk".
//  3. A vowel must survive, so "chink" cannot become "chnk".
const MINIMUM_ELIDED_LENGTH = 5;

const elidedVariants = (term: string): string[] => {
  const letters = [...normalizeWord(term)];
  const variants = new Set<string>();
  for (let index = 2; index < letters.length - 1; index += 1) {
    if (!VOWELS.includes(letters[index])) continue;
    if (letters[index - 1] !== letters[index - 2]) continue;
    const variant = [...letters.slice(0, index), ...letters.slice(index + 1)].join("");
    if (variant.length < MINIMUM_ELIDED_LENGTH) continue;
    if (![...variant].some((letter) => VOWELS.includes(letter))) continue;
    variants.add(variant);
  }
  return [...variants];
};

// A whole-word term optionally wrapped in one listed compound part, so
// "badass", "asshat", and "dickwad" match while "class", "bass", "assassin",
// and "Massachusetts" do not. A term with no COMPOUNDS entry keeps exactly the
// old whole-word pattern.
const compoundOf = (term: string): CompoundTerm | undefined =>
  COMPOUNDS.find((entry) => normalizeWord(entry.term) === normalizeWord(term));

const optionalGroup = (parts: readonly string[]): string =>
  parts.length === 0 ? "" : `(?:${parts.map(termPattern).join("|")})?`;

const wordTermPattern = (term: string): string => {
  const compound = compoundOf(term);
  if (compound === undefined) return termPattern(term);
  return `${optionalGroup(compound.before)}${termPattern(term)}${optionalGroup(compound.after)}`;
};

const SEVERE_PATTERN = anyOf(
  SEVERE_SLURS.flatMap((term) => [termPattern(term), ...elidedVariants(term).map(termPattern)]),
);
const PROFANITY_ANYWHERE_PATTERN = anyOf(
  PROFANITY.filter((entry) => entry.mode === "anywhere").map((entry) => termPattern(entry.term)),
);
const PROFANITY_WORD_PATTERN = wholeWordAnyOf(
  PROFANITY.filter((entry) => entry.mode === "word").map((entry) => wordTermPattern(entry.term)),
);

const allowedWords = new Set(ALLOWLIST.map(normalizeWord));
const allowedSuffixes = ["s", "es", "ed", "ing", "er", "ers", "y", "ies", "ly", "ness", "ish"];
const allowedPrefixes = ["un", "in", "non", "re", "pre", "over", "under", "semi", "super", "mis"];

// An allowlist entry is listed as its base word. A token also matches with one
// common prefix and/or one common suffix removed, trying both the bare stem and
// the stem with its dropped silent "e" restored, so listing "spice" also covers
// "spicy", "spiced", "spices", "spicing", and "unspiced". Only a stem that is
// itself an allowlist entry is ever accepted, so this can never turn an
// affixed profanity into an innocent word.
const isAllowedStem = (token: string): boolean => {
  if (allowedWords.has(token)) return true;
  for (const suffix of allowedSuffixes) {
    if (token.length <= suffix.length || !token.endsWith(suffix)) continue;
    const stem = token.slice(0, -suffix.length);
    if (allowedWords.has(stem) || allowedWords.has(`${stem}e`)) return true;
  }
  return false;
};

const isAllowedWord = (token: string): boolean => {
  if (isAllowedStem(token)) return true;
  for (const prefix of allowedPrefixes) {
    if (token.length > prefix.length && token.startsWith(prefix)
      && isAllowedStem(token.slice(prefix.length))) {
      return true;
    }
  }
  return false;
};

// Runs of two or more single-letter tokens become one word. Only single letters
// are joined, so this reconstructs "f u c k" and "a-s-s" without inventing a
// word boundary anywhere a participant did not put one.
const mergeSingleLetterRuns = (tokens: readonly string[]): string[] => {
  const merged: string[] = [];
  let run: string[] = [];
  const flush = (): void => {
    if (run.length > 1) merged.push(run.join(""));
    else if (run.length === 1) merged.push(run[0]);
    run = [];
  };
  for (const token of tokens) {
    if (token.length === 1) {
      run.push(token);
      continue;
    }
    flush();
    merged.push(token);
  }
  flush();
  return merged;
};

// ---------------------------------------------------------------------------
// PREDICATE
// ---------------------------------------------------------------------------

// One reading of the name, in every substitution reading of that reading:
// allowlist-scrubbed tokens, the same tokens with single-letter runs merged,
// and the separator-stripped concatenation.
//
// Substitutions map one letter to one letter, so they never move a token
// boundary and the substituted tokens stay index-aligned with the plain ones.
// That alignment is what lets a token be scrubbed when EITHER spelling is
// allowlisted, which is what stops the "k"->"c" reading from reading "spick"
// and "spike" as the slur they are not.
const isAllowedReading = (value: string, ambiguousAs: "i" | "l"): boolean => {
  const tokens = normalize(value, ambiguousAs)
    .split(/[^a-z]+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return true;

  // Most names contain no "v", "z", "k", or "q", so every reading collapses
  // onto the plain one and the extra readings cost nothing.
  const alreadyRead = new Set<string>();
  for (const reading of SUBSTITUTION_READINGS) {
    const read = tokens.map((token) => applyReading(token, reading));
    const key = read.join(" ");
    if (alreadyRead.has(key)) continue;
    alreadyRead.add(key);

    const scrubbed = read.filter(
      (token, index) => !isAllowedWord(token) && !isAllowedWord(tokens[index]),
    );
    if (scrubbed.length === 0) continue;

    const stripped = scrubbed.join("");
    if (SEVERE_PATTERN.test(stripped)) return false;
    if (PROFANITY_ANYWHERE_PATTERN.test(stripped)) return false;
    const words = [...scrubbed, ...mergeSingleLetterRuns(scrubbed), stripped];
    if (words.some((word) => PROFANITY_WORD_PATTERN.test(word))) return false;
  }
  return true;
};

// Returns whether this name may be stored and shown. It reports only the
// decision: which term matched, and whether it was the alphabet rule or a
// wordlist that refused, is never returned, thrown, or logged.
export const isAllowedDuckName = (value: string): boolean => {
  if (typeof value !== "string") return false;
  // The cheapest and broadest rule first: a name written in symbols or emoji is
  // refused before any folding, so no confusable table has to chase it.
  if (!hasSupportedDuckNameCharacters(value)) return false;
  if (!isAllowedReading(value, "i")) return false;
  // The second reading only differs when an ambiguous character is present.
  return normalize(value, "i") === normalize(value, "l") || isAllowedReading(value, "l");
};

// The read-time safety net. Every projection of a stored duck name goes through
// this, which matters for two real cases: rows written before duck names became
// public, and names that only become disallowed later when the wordlists above
// are extended. A suppressed name becomes `null`, and every surface falls back
// to the canonical "Duck #N".
//
// Names are at most 40 characters, so re-checking one on each read is cheap.
export const publicDuckName = (value: string | null | undefined): string | null => {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(/\s+/g, " ");
  if (cleaned.length === 0) return null;
  // Defensive: a stored value predating the write-time rule could still carry
  // characters that hide or reorder text on someone else's screen.
  if (/[\p{Cc}\p{Cf}]/u.test(cleaned)) return null;
  return isAllowedDuckName(cleaned) ? cleaned : null;
};
