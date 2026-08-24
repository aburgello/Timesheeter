import { resolveJobNumber } from "../src/utils/wrikeHelpers.js";

// The Job Number field cascaded into Wrike now carries the whole folder name
// ("XY026179_ITM_Print_Custom_Lobby_Display"), not the bare code. Everything
// that reads it back has to survive that, and this is the funnel they all go
// through.

const OPTIONS = [
  "Street Fighter : XY026179, ITM Print Custom Lobby Display",
  "Street Fighter : XY025998, DOM Print WWE Title Treatment",
];

// A registered code resolves to the Job Book's own string whatever suffix rode
// in with it — the suffix adds nothing the registered option doesn't say.
check(
  "full nomenclature resolves to the registered job",
  resolveJobNumber("XY026179_ITM_Print_Custom_Lobby_Display", OPTIONS),
  OPTIONS[0]
);
check(
  "and the bare code resolves to the same one",
  resolveJobNumber("XY026179", OPTIONS),
  OPTIONS[0]
);

// Unregistered: the bare code, never the suffixed string. This is what stops a
// folder name leaking into the job column as though it were a job number.
check(
  "an unknown code comes back bare",
  resolveJobNumber("XY099999_DOM_Print_Something", OPTIONS),
  "XY099999"
);

// The shape the field regex in guessFieldsFromTask has to match, checked here
// because the value it now receives is longer and underscore-heavy.
const FIELD_RE = /(XY\d{5,6}(?:_[A-Za-z0-9]+)*)/i;
check(
  "the field regex captures the whole nomenclature",
  "XY026179_ITM_Print_Custom_Lobby_Display".match(FIELD_RE)[1],
  "XY026179_ITM_Print_Custom_Lobby_Display"
);
check(
  "a trailing underscore doesn't drag in an empty segment",
  "XY026179_".match(FIELD_RE)[1],
  "XY026179"
);

// Free-text internal jobs carry no code and must pass through untouched.
check("no code at all is left alone", resolveJobNumber("Internal Showreel", OPTIONS), "Internal Showreel");
