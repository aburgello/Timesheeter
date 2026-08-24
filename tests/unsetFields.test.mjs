import { isUnset, UNASSIGNED } from "../src/constants.js";
import { splitTerritories } from "../src/utils/territories.js";

// The rule both row pickers use to decide whether to go red. It lives in one
// place because country and category have to agree: a person scanning the grid
// for gaps shouldn't find that one column flags a pulled row and the other
// doesn't.

// The obvious cases.
check("empty string is unset", isUnset(""), true);
check("whitespace is unset", isUnset("   "), true);
check("null is unset", isUnset(null), true);
check("undefined is unset", isUnset(undefined), true);

// The case a plain emptiness test got wrong. guessFieldsFromTask writes this
// string, not "", so every pulled row looked answered.
check("the pull's placeholder is unset", isUnset(UNASSIGNED), true);
check("...even padded", isUnset("  ⚠️ Unassigned  "), true);

// Real answers stay answered.
check("a country is set", isUnset("Chile"), false);
check("a category is set", isUnset("Print - Retouching"), false);
check("so is a house value", isUnset("_Masters_"), false);
check("and OV", isUnset("OV"), false);

// The country cell tests every territory in the list, because the value is a
// comma-joined string. An empty list is unanswered ([].every is true); one real
// market among them means the row has been answered.
const countryNeedsAttention = (v) => splitTerritories(v).every(isUnset);
check("no country at all", countryNeedsAttention(""), true);
check("placeholder country", countryNeedsAttention(UNASSIGNED), true);
check("one real country", countryNeedsAttention("Chile"), false);
check("several real countries", countryNeedsAttention("Belgium, France"), false);
