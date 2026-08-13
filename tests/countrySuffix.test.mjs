import { countriesFromTaskName } from "../src/utils/countryCodes.js";

// The reported bug, from the real task: Studio > Paramount > Tad_and_the_Magic_Lamp
// > Print > INTL > XY025832_..._Markets > _MAGI_Masters > TAD_Masters_Chile.
// It resolved to ["_Masters_", "Chile"], putting two chips on one timesheet row
// — and _Masters_ exports as "OV Suite Build (Masters)", which is what the
// studio saw selected alongside the market.
check("a masters build for a market logs as the market", countriesFromTaskName("TAD_Masters_Chile"), ["Chile"]);

// Same task named the other way round. These used to differ only in which chip
// came first, which is not a distinction anybody intended to make.
check("order doesn't change the answer", countriesFromTaskName("TAD_Chile_Masters"), ["Chile"]);
check("nor does OV instead of Masters", countriesFromTaskName("TAD_OV_Chile"), ["Chile"]);

// The cases the exceptions were added for are untouched: with no market in the
// name there is nothing more specific to prefer.
check("masters alone still means Masters", countriesFromTaskName("TAD_Masters"), ["_Masters_"]);
check("OV alone still means OV", countriesFromTaskName("TAD_Teaser_OV"), ["OV"]);
check(
  "a campaign root still means Multiple",
  countriesFromTaskName("XY025832_INTL_PRINT_Outdoor_Campaign_Markets"),
  ["_Multiple_"]
);

// Genuine multi-market names must keep every market — this is the behaviour the
// collecting walk exists for, and the fix must not touch it.
check("two real markets are both kept", countriesFromTaskName("TAD_Print_1SHT_CL_AR"), ["Chile", "Argentina"]);

// An ordinary single-market task, unchanged.
check("a plain market", countriesFromTaskName("TAD_Print_Chile"), ["Chile"]);

// Nothing to say stays nothing to say — never a guess.
check("no market named", countriesFromTaskName("TAD_Print_Teaser"), []);
