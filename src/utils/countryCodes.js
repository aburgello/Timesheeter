import {
  FILM_MAPPINGS,
  TERRITORIES,
  REGION_ALIASES,
  MAGI_MARKET_CODES,
  COUNTRY_SUFFIX_EXCEPTIONS,
} from "../constants";

// Resolving a country from a Wrike task, as agreed with production on
// 4 Aug 2026.
//
// The old rule scanned every scrap of text on a task — title, project name,
// /Volumes path, notes, custom fields, and the timelog comment — joined into
// one string, and kept whichever country matched at the lowest character
// index. That made position, not authorship, the deciding factor, and since 44
// of the ~120 short codes are two letters (six of them ordinary English words:
// IT, AT, BE, IN, NO, US) it read countries out of plain prose:
//
//     "ODYSSEY_IN_PROGRESS"             -> India
//     "Trailer edit — fixed it at the"  -> Italy
//     "No changes needed"               -> Norway
//
// The fix isn't a better-ranked scan, it's to stop scanning. A country code is
// only read where someone deliberately put one: the LAST token of the task
// name. The same alias table is now safe precisely because it's anchored — a
// task called "…_IT_Deck" is unaffected, only "…_IT" resolves.
//
// The trade production accepted with this: a task whose name carries no
// suffix now gets NO country rather than a guessed one. The row still pulls,
// the country is simply left empty for the person to fill in. Tasks without a
// suffix get phased out naturally as templates are updated, instead of anyone
// backfilling them.

const codeKey = (s) =>
  String(s || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

// One lookup, built once. Order matters where keys collide, weakest first:
//
//   territory names  <  REGION_ALIASES  <  MAGI_MARKET_CODES  <  exceptions
//
// MAGI outranks the hand-grown alias table because it's the list production
// actually writes against — where the two disagree, theirs is the real one.
// The agreed exceptions sit above even MAGI so "OV" and "Markets" can never be
// shadowed by a same-spelled country code.
//
// Note codeKey strips punctuation, so MAGI's "BE-FL" and "ME_AR" are stored as
// BEFL and MEAR — which is also how they'd arrive off the end of a task name
// however someone punctuated them.
// Codes this studio's own naming already uses for something else, blocked in
// the one position where the two collide.
//
// "TT" is Teaser Titles across this account — 55 tasks and 88 folders END in
// it ("EBZR_CMYK_Teaser_TT_Deck", "XY022627_Odeon_TT") — and it is also MAGI's
// code for Trinidad, which production confirmed is real work (outdoor orders
// and launches, Guillaume 5 Aug 2026). Both are true, so this can't be settled
// by picking one.
//
// It's settled by position instead, which the data separates cleanly:
//
//   at the END of a name   -> Teaser Titles. 55 tasks, 88 folders. Blocked.
//   in the batch slot      -> Trinidad. "ODY_TT_Something", the outdoor
//     (2nd token)             convention. ZERO tasks use TT there today, so
//                             the slot is free for it to mean the market.
//   a market FOLDER        -> unaffected: those are named in full,
//                             "Trinidad 🇹🇹" / "AQPD1_ Trinidad 🇹🇹".
//   the Country field      -> unaffected: that field is identified by id, so
//                             "TT" in it can only mean the market.
//
// So Trinidad keeps working everywhere it's actually written, and Teaser
// Titles stops being read as a country. An earlier version of this deleted TT
// from the lookup outright, which was blunter than it needed to be: it also
// blocked the field and the batch slot, where there was never any ambiguity.
const SUFFIX_BLOCKED = new Set(["TT"]);

const CODE_LOOKUP = (() => {
  const map = new Map();
  const add = (obj) => {
    for (const [alias, target] of Object.entries(obj)) {
      const k = codeKey(alias);
      if (k) map.set(k, target);
    }
  };
  for (const name of TERRITORIES) {
    const k = codeKey(name);
    if (k) map.set(k, name);
  }
  add(REGION_ALIASES);
  add(MAGI_MARKET_CODES);
  add(COUNTRY_SUFFIX_EXCEPTIONS);
  return map;
})();

// Aliases curated in Administration → Translation Countries, layered over the
// built-ins above. Empty until lib/countryAliases.js loads them, so every
// reader works untouched before (and if) that fetch lands — the table adds to
// this file, it never becomes a dependency of it.
//
// Consulted FIRST, so a curated row can correct a built-in as well as extend
// it. That includes re-enabling something this file removed: adding TT ->
// Trinidad here brings it back for an account that really does bill Trinidad,
// without editing NEVER_A_CODE.
let RUNTIME_ALIASES = new Map();

/**
 * Replace the runtime overlay. Takes [{ alias, territory }] and keeps only
 * rows whose territory is one we actually know — a typo'd territory would
 * otherwise resolve to a string nothing else in the app recognises, which is
 * worse than the alias simply not working.
 */
export const setRuntimeAliases = (rows) => {
  const next = new Map();
  for (const { alias, territory } of rows || []) {
    const key = codeKey(alias);
    const name = String(territory || "").trim();
    if (!key || !TERRITORIES.includes(name)) continue;
    next.set(key, name);
  }
  RUNTIME_ALIASES = next;
};

/** What the overlay currently holds, for the editor's "already taken" checks. */
export const runtimeAliasCount = () => RUNTIME_ALIASES.size;

/**
 * A single token -> its canonical territory, or null. Whole-token equality
 * only: "IT" resolves, "ITINERARY" does not.
 */
export const resolveCountryCode = (token) => {
  const key = codeKey(token);
  return RUNTIME_ALIASES.get(key) || CODE_LOOKUP.get(key) || null;
};

/**
 * Every built-in alias for a territory, for display beside the editable ones.
 *
 * Read from the source tables rather than from CODE_LOOKUP, because the lookup
 * is keyed by the NORMALISED alias — punctuation stripped — and showing those
 * keys turned MAGI's "IN-HI" into "INHI" on screen. The hyphen is real: it's
 * how the code is written on their sheet and how someone types it into a task
 * name, so it's what the panel has to show.
 *
 * Each candidate is still put back through resolveCountryCode, so what's listed
 * is what actually resolves today — an alias a curated row has re-pointed
 * elsewhere won't appear under a country it no longer means. SUFFIX_BLOCKED
 * codes DO appear (TT under Trinidad), because they still resolve in the batch
 * slot and the Country field; only the end-of-name position refuses them.
 */
const ALIAS_SOURCES = [REGION_ALIASES, MAGI_MARKET_CODES, COUNTRY_SUFFIX_EXCEPTIONS];

// What the exceptions resolve TO ("_Multiple_", "_Masters_", "OV") rather than
// the suffixes people write ("MARKETS", "MASTERS", "OV") — these are compared
// against resolved output. Derived from the map so adding an exception in
// constants.js needs no edit here.
const SUFFIX_EXCEPTION_VALUES = new Set(Object.values(COUNTRY_SUFFIX_EXCEPTIONS));

export const builtInAliasesFor = (territory) => {
  const seen = new Set([codeKey(territory)]);
  const out = [];
  for (const source of ALIAS_SOURCES) {
    for (const [alias, target] of Object.entries(source)) {
      const key = codeKey(alias);
      if (target !== territory || seen.has(key)) continue;
      if (resolveCountryCode(alias) !== territory) continue;
      seen.add(key);
      out.push(alias);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
};

/**
 * The country codes written at the END of a task name.
 *
 * Trailing tokens are taken while they keep resolving, so a name can carry
 * more than one market ("..._Teaser_FRA_GER" -> France, Germany) without the
 * walk ever reaching into the descriptive part of the name — the first token
 * that isn't a code stops it. That single rule is what makes the two-letter
 * codes usable again: they only count where the convention says they live.
 *
 * Returns canonical names in the order they were written, de-duplicated.
 */
export const countriesFromTaskName = (name) => {
  const tokens = String(name || "")
    .trim()
    .split(/[_\s|]+/)
    .filter(Boolean);

  const found = [];
  for (let i = tokens.length - 1; i >= 0; i--) {
    // Tokens that carry no letters or digits at all — the flag emoji on
    // "Chile 🇨🇱", the dashes in "PP3 - CHI" — are punctuation, not a failed
    // code, so they're stepped over rather than ending the walk. A token that
    // has content but doesn't resolve still stops it: that's the descriptive
    // part of the name beginning, and nothing beyond it is a country.
    if (!codeKey(tokens[i])) continue;

    // A code this account spells for something else stops the walk, exactly as
    // a descriptive word would — "..._Teaser_TT" is a titles asset, not
    // Trinidad. Only this position is affected; see SUFFIX_BLOCKED.
    if (SUFFIX_BLOCKED.has(codeKey(tokens[i]))) break;

    // Several MAGI codes have an underscore inside them — CAN_FR, ME_AR,
    // MENA_EN — which the split above has already torn in two. Try rejoining
    // with the previous token before reading this one alone, or "..._ME_AR"
    // resolves on its trailing "AR" and lands on Argentina.
    let prev = i - 1;
    while (prev >= 0 && !codeKey(tokens[prev])) prev--;
    const joined =
      prev >= 0 ? resolveCountryCode(tokens[prev] + tokens[i]) : null;
    if (joined) {
      found.unshift(joined);
      i = prev; // the loop's own i-- then steps past the pair
      continue;
    }

    const resolved = resolveCountryCode(tokens[i]);
    if (!resolved) break;
    found.unshift(resolved);
  }
  // A NAMED MARKET BEATS A SUFFIX EXCEPTION IN THE SAME NAME.
  //
  // The exceptions (_Multiple_, _Masters_, OV) are read exactly like country
  // codes, which is what lets "..._Markets" mean something deliberate. But the
  // walk collects every consecutive token that resolves, so a name carrying
  // both — "TAD_Masters_Chile", the masters build for the Chile market — came
  // back as ["_Masters_", "Chile"] and put two chips on one timesheet row, one
  // of which exports as "OV Suite Build (Masters)". They are mutually
  // exclusive by definition: an exception means "this row isn't for one
  // market", so it cannot be true alongside one.
  //
  // Where both appear, the market is the more specific statement and the
  // exception is describing the work. Order doesn't matter — "TAD_Chile_
  // Masters" is the same task named the other way round, and used to differ
  // only in which chip came first.
  //
  // An exception ALONE is untouched, which is the case it was added for.
  if (found.length) {
    const unique = [...new Set(found)];
    const markets = unique.filter((c) => !SUFFIX_EXCEPTION_VALUES.has(c));
    return markets.length ? markets : unique;
  }

  return batchPositionCountry(tokens);
};

const FILM_CODES = new Set(Object.keys(FILM_MAPPINGS).map(codeKey));

/**
 * The outdoor convention: a batch parent task carries the market SECOND, right
 * after the film code — "ODY_CN_EmperorCinema" — not at the end (Guillaume,
 * 5 Aug 2026). The suffix walk can never see it, because the descriptive part
 * of the name comes after it and stops the walk immediately.
 *
 * Read only in that one slot, and only behind a known film code, so this stays
 * a convention rather than the free-text scan this file exists to abolish. Two
 * fixed positions either side of a closed list is about as anchored as a
 * mid-name read can get.
 *
 * The eight English-word codes are refused here even though they're trusted at
 * the end of a name. "ODYSSEY_IN_PROGRESS" is the exact shape the old scanner
 * read India out of — it's cited at the top of this file — and position 2
 * genuinely cannot tell it from a market. A batch that really is Indian will
 * still resolve from its folder, or from "_IN" written where the convention
 * says codes live.
 */
function batchPositionCountry(tokens) {
  // Position is counted over the tokens that CARRY something, because the
  // convention is written both ways: "ODY_CN_EmperorCinema" and
  // "PP3 - AUS - DOOH - Batch 1". The split above keeps each "-" as a token of
  // its own, so the market in the hyphenated form sits at index 2 and reading
  // index 1 found a dash — the batch rule was blind to every name production
  // spaces out, which is most of the outdoor ones. The suffix walk already
  // steps over these same tokens (see the loop above); this is that rule
  // applied to a fixed position instead of a moving one.
  const real = tokens.filter((t) => codeKey(t));

  // Needs film + code + something after it. A bare "ODY_CN" ends on the code,
  // so the walk above has already taken it.
  if (real.length < 3) return [];
  if (!FILM_CODES.has(codeKey(real[0]))) return [];

  const key = codeKey(real[1]);
  if (!key || AMBIGUOUS_WORD_CODES.has(key)) return [];

  const resolved = resolveCountryCode(real[1]);
  return resolved ? [resolved] : [];
}

/**
 * The market named in a JOB folder — "XY026036_AUS_DOOH_Campaign".
 *
 * The folder rule above was written for the localisation shape, one folder per
 * market ("Chile 🇨🇱"), and reads it through countriesFromTaskName — which only
 * looks at the END of a name. Campaign jobs don't have a market folder at all:
 * the push names one folder per JOB and puts the market in position 2, right
 * after the code, with the rest of the name describing the work. So
 * "XY026036_AUS_DOOH_Campaign" ends on "Campaign", the suffix walk stops there,
 * and rule 3 was silently off for every campaign job in the account:
 *
 *     XY026036_AUS_DOOH_Campaign      ->  []
 *     XY024840_UK_QA_Holding_Slides   ->  []
 *     XY025716_Germany_Launch_Assets  ->  []
 *
 * This is the same anchored read as batchPositionCountry, with the job code in
 * place of the film code: a closed pattern in slot 0 (XY + 5-6 digits, which
 * nothing else in a folder name looks like) and one fixed slot after it. It is
 * still not a scan — nothing in the descriptive tail is ever read.
 *
 * Deliberately folder-only. A TASK named "XY026036_AUS_something" is not the
 * same statement: the job tag on a task says which job the work belongs to, not
 * which market the work is for, and tasks are where the free-text scan did its
 * damage. The folder is named once, by the push, to a fixed pattern.
 *
 * The refusals matter more than the rule:
 *   · the ambiguous English words, for the reason batchPositionCountry refuses
 *     them — "XY026100_IN_Progress_Assets" is not India.
 *   · the non-markets, so a folder called "XY025832_Masters_Delivery" doesn't
 *     put "_Masters_" on a row as though it were a market, and a house job
 *     ("XY022180_XYi_Order_Of_Service") doesn't put "_XYi_" there. Slot 2 means
 *     a market or it means nothing; "_Markets" at the END still means Multiple,
 *     which is where that statement actually lives.
 *   · PAN, below.
 */
const JOB_CODE = /^XY\d{5,6}$/i;

// MAGI lists PAN for Panama, and in this account it has never once meant that.
// Every one of the 59 folders carrying PAN as a token is a "Pan_Regional" job —
// pan-regional work, no market named — and ZERO folders end in "_PAN". Panama
// is written PA where it's written at all.
//
// Same shape as SUFFIX_BLOCKED and settled the same way, by position: reading
// slot 2 without this turns 15 pan-regional campaigns into Panama campaigns,
// which is precisely the invented-market failure this file exists to prevent.
// Blocked only here — a task deliberately named "..._PAN" is still Panama,
// because that is someone writing a code where codes go.
const JOB_SLOT_BLOCKED = new Set(["PAN"]);

// TERRITORIES carries a few entries that are not markets at all — the
// underscore-wrapped house values ("_XYi_", "_Masters_", "_Multiple_") and the
// OV pair. They are legitimate answers from a suffix someone wrote on purpose;
// none of them is a thing slot 2 can be saying.
const isMarket = (t) => !t.startsWith("_") && !SUFFIX_EXCEPTION_VALUES.has(t);

const jobFolderCountry = (name) => {
  const real = String(name || "")
    .trim()
    .split(/[_\s|]+/)
    .filter((t) => codeKey(t));

  // Code + market + something after it, matching the batch rule: a folder that
  // ENDS on its market is already read by the suffix walk.
  if (real.length < 3) return [];
  if (!JOB_CODE.test(real[0])) return [];

  // Two-token markets — "Hong_Kong", "New_Zealand", "South_Africa" — are torn
  // in two by the split, so the pair is tried before the single. Needs a fourth
  // token, or the pair is the end of the name and the suffix walk has it.
  const candidates =
    real.length >= 4 ? [real[1] + real[2], real[1]] : [real[1]];

  for (const candidate of candidates) {
    const key = codeKey(candidate);
    if (!key || AMBIGUOUS_WORD_CODES.has(key) || JOB_SLOT_BLOCKED.has(key))
      continue;
    const resolved = resolveCountryCode(candidate);
    if (resolved && isMarket(resolved)) return [resolved];
  }
  return [];
};

/**
 * The country named by the folder a task lives in.
 *
 * Localisation campaigns don't put the market in the task name at all — they
 * put it in the tree, one folder per market:
 *
 *     XY025995_INTL_DIGITAL_Outdoor_Campaign_Markets
 *       ├── Chile 🇨🇱
 *       │     └── PP3 - CHI - DOOH - Batch 1 - POST
 *       └── Colombia 🇨🇴
 *
 * The folder name is as deliberate a statement as a suffix — it just isn't on
 * the task — so it is read the same way, and the campaign root resolving to
 * "_Multiple_" via its own "_Markets" ending falls out for free. (The task in
 * that sketch now also resolves on its own, from the batch slot; it did not
 * when this rule was written, which is why the tree was the only way in.)
 *
 * Two shapes are read, because production names campaigns two ways: the market
 * FOLDER above, and the market slot of a JOB folder — see jobFolderCountry.
 *
 * `names` must be ordered nearest folder first; the first that resolves wins,
 * so a market folder always beats the campaign root above it.
 */
export const countriesFromFolderNames = (names) => {
  for (const name of names || []) {
    const suffix = countriesFromTaskName(name);

    // A NAMED MARKET BEATS A SUFFIX EXCEPTION, across the two reads of one
    // folder name as well as within one. "XY026036_AUS_DOOH_Campaign_Markets"
    // is a market campaign, not an unspecified one — same call the walk makes
    // for "TAD_Masters_Chile", for the same reason.
    if (suffix.length && !suffix.every((c) => SUFFIX_EXCEPTION_VALUES.has(c)))
      return suffix;

    const fromJob = jobFolderCountry(name);
    if (fromJob.length) return fromJob;
    if (suffix.length) return suffix;
  }
  return [];
};

// The eight codes that are also ordinary English words. They are perfectly safe
// everywhere a human anchored them — a task name or folder ending in "_IT" is
// someone saying Italy — and dangerous in exactly one place: an UNIDENTIFIED
// custom field, where "No" from a boolean dropdown is indistinguishable from
// "NO" on a Country field. Used only by the unpinned reader below.
const AMBIGUOUS_WORD_CODES = new Set([
  "NO", "IN", "IT", "AT", "BE", "US", "IS", "MY",
]);

// One field value → the countries it states, or [] if it doesn't state any.
//
// All-or-nothing: a value holding "Belgium, France" is a market statement, a
// value holding "Belgium brief approved" is prose that happens to open with a
// country name. Requiring EVERY token to resolve tells them apart, and it's
// what makes a pinned field safe to read even though 161 distinct values live
// in it and some of them ("approved") are junk.
const countriesFromValue = (raw, { trustAmbiguousWords }) => {
  if (!raw || typeof raw !== "string") return [];
  const tokens = raw.split(/[,/;|]+/).map((t) => t.trim()).filter(Boolean);
  if (!tokens.length) return [];

  // A lone ambiguous word proves nothing about which field it came from, so an
  // unpinned read refuses it. A pinned read doesn't need to: we know this is
  // the Country field, so "NO" in it means Norway — which is the whole point of
  // pinning, since the account has 49 tasks whose Country field holds exactly
  // IN / AT / IT / NO and the guard would throw all of them away.
  if (
    !trustAmbiguousWords &&
    tokens.length === 1 &&
    AMBIGUOUS_WORD_CODES.has(codeKey(tokens[0]))
  )
    return [];

  const resolved = tokens.map(resolveCountryCode);
  return resolved.every(Boolean) ? [...new Set(resolved)] : [];
};

/**
 * The Country custom field on the task.
 *
 * Two modes, and which one runs is the difference between reading a field and
 * guessing at one:
 *
 *   PINNED (fieldIds given, from lib/countryField.js) — read those fields, in
 *   order, and nothing else. Every other field on the task is invisible, so no
 *   boolean, status or comment field can contribute a country however it's
 *   spelled. This is the mode that should run in production.
 *
 *   UNPINNED (no ids — discovery hasn't run, or Wrike wouldn't say) — the old
 *   shape-based sweep over every field, with the ambiguous-word guard on. It
 *   can still be wrong; it is a floor, not the design.
 *
 * Multi-country values are supported in both, since this field is the one
 * upstream source that can express "Belgium, France" as a single row.
 */
export const countriesFromCustomFields = (customFields, fieldIds) => {
  if (!Array.isArray(customFields)) return [];

  if (fieldIds?.length) {
    for (const id of fieldIds) {
      const found = countriesFromValue(
        customFields.find((cf) => cf?.id === id)?.value,
        { trustAmbiguousWords: true }
      );
      if (found.length) return found;
    }
    // Deliberately no fall-through to the sweep. Knowing which field to read
    // and finding it empty is an answer: nobody said.
    return [];
  }

  for (const cf of customFields) {
    const found = countriesFromValue(cf?.value, { trustAmbiguousWords: false });
    if (found.length) return found;
  }
  return [];
};

/**
 * The agreed resolution order, in one place. Most deliberate statement first:
 *
 *   1. the code ending the task's own name     "..._62s_CN"
 *   2. the code ending its parent TASK's name  (Guillaume's parent-task rule)
 *   3. the FOLDER the task sits in             (a market folder in a
 *                                               localisation campaign, or the
 *                                               market slot of a job folder)
 *   4. the pinned Country custom field         (launches)
 *
 * Nothing else is consulted — not the /Volumes path, not the notes, not the
 * timelog comment. An empty array means "nobody said", which callers surface
 * as an empty country for the person to fill, never as a guess.
 *
 * Every rule is anchored to a place a human deliberately put a market: the end
 * of a name, a folder someone filed the task into, a field someone chose. None
 * of them scans prose, and none of them ranks by position. That's what keeps
 * two-letter codes usable.
 *
 * Order is by authorship, not by reliability: the person who named THIS asset
 * "_CN" was saying something more specific than the folder it was filed in,
 * even though the folder is the more reliably-populated of the two. Where they
 * disagree the name wins — and `source` below is what makes that traceable
 * afterwards instead of a mystery.
 *
 * Inputs the caller is responsible for supplying, because they need I/O this
 * can't do from inside render:
 *   · task.folderCountries or superTaskParentIds → the folder climb
 *     (LegacyTimesheets resolves these; the Tracker's cache bakes them in)
 *   · opts.countryFieldIds → which field rule 4 may read (lib/countryField.js).
 *     Absent, rule 4 degrades to the shape-based sweep rather than turning off.
 */
export const resolveCountriesWithSource = (
  task,
  parentTaskName = "",
  { countryFieldIds } = {}
) => {
  if (!task) return { countries: [], source: "" };

  const fromOwn = countriesFromTaskName(task.title);
  if (fromOwn.length) return { countries: fromOwn, source: "task-name" };

  const fromParentTask = countriesFromTaskName(parentTaskName);
  if (fromParentTask.length)
    return { countries: fromParentTask, source: "parent-task-name" };

  if (task.folderCountries?.length)
    return { countries: task.folderCountries, source: "folder" };

  const fromField = countriesFromCustomFields(task.customFields, countryFieldIds);
  if (fromField.length)
    return {
      countries: fromField,
      source: countryFieldIds?.length ? "country-field" : "custom-field-sweep",
    };

  return { countries: [], source: "" };
};

/** The countries alone, for the callers that don't care where they came from. */
export const resolveCountries = (task, parentTaskName = "", opts) =>
  resolveCountriesWithSource(task, parentTaskName, opts).countries;
