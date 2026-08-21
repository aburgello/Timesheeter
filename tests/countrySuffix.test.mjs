import { countriesFromTaskName, countriesFromFolderNames } from "../src/utils/countryCodes.js";

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

// ---------------------------------------------------------------------------
// The batch slot, when the name is spaced out rather than underscored
// ---------------------------------------------------------------------------
// From the real task: Studio > Paramount > Paw_Patrol_The_Dino_Movie > Digital
// > INTL > XY026036_AUS_DOOH_Campaign > "PP3 - AUS - DOOH - Batch 1 TMRW".
// PP3 is a known film code and AUS is in the batch slot, so the outdoor
// convention is written exactly as agreed — but the split keeps each "-" as its
// own token, so the rule read a dash at index 1 and gave up. The Country field
// on that task is empty and the job folder carries the market mid-name, so
// nothing else could catch it either: the row pulled with no market at all.
check(
  "the batch slot is read through the separators",
  countriesFromTaskName("PP3 - AUS - DOOH - Batch 1 TMRW"),
  ["Australia"]
);
check(
  "the localisation example in this file's own comments",
  countriesFromTaskName("PP3 - CHI - DOOH - Batch 1 - POST"),
  ["Chile"]
);

// The underscored form, which always worked and must keep working identically.
check("underscored batch names are unchanged", countriesFromTaskName("ODY_CN_EmperorCinema"), ["China"]);
check("TT in the batch slot is still Trinidad", countriesFromTaskName("ODY_TT_Something"), ["Trinidad"]);

// The guard the batch rule exists to keep. Stepping over punctuation must not
// become a way to smuggle an ambiguous English word into the slot — this is the
// exact name cited at the top of this file as what the old scanner got wrong.
check("hyphens don't smuggle IN past the guard", countriesFromTaskName("ODY - IN - Progress"), []);
check("nor NO", countriesFromTaskName("ODY - NO - Changes"), []);
check("nor IT", countriesFromTaskName("ODY - IT - Deck"), []);
check("underscored, same refusal", countriesFromTaskName("ODYSSEY_IN_PROGRESS"), []);

// Slot 0 still has to be a film code, so a market in slot 1 of an ordinary
// sentence proves nothing.
check("no film code, no batch read", countriesFromTaskName("Batch - AUS - Thing"), []);

// ---------------------------------------------------------------------------
// The market in a JOB folder — rule 3 for campaign jobs
// ---------------------------------------------------------------------------
// Localisation campaigns get a folder per market ("Chile 🇨🇱"); campaign jobs
// get a folder per JOB with the market in position 2. The folder rule only
// read the end of a name, so the second shape resolved to nothing at all.
check(
  "a job folder names its market",
  countriesFromFolderNames(["XY026036_AUS_DOOH_Campaign"]),
  ["Australia"]
);
check(
  "and the rest of the name is still never scanned",
  countriesFromFolderNames(["XY024840_UK_QA_Holding_Slides"]),
  ["UK"]
);
check(
  "a market spelled in full",
  countriesFromFolderNames(["XY025716_Germany_Launch_Assets"]),
  ["Germany"]
);
check(
  "a two-token market survives the split",
  countriesFromFolderNames(["XY026100_Hong_Kong_Assets"]),
  ["Hong Kong"]
);

// The market folder is still nearest-first and still wins over anything above.
check(
  "a market folder beats the job folder above it",
  countriesFromFolderNames(["Chile 🇨🇱", "XY026036_AUS_DOOH_Campaign"]),
  ["Chile"]
);

// A named market outranks a suffix exception in the same folder name, exactly
// as it does inside a task name.
check(
  "a market campaign is that market, not Multiple",
  countriesFromFolderNames(["XY026036_AUS_DOOH_Campaign_Markets"]),
  ["Australia"]
);
check(
  "a campaign root with no market still means Multiple",
  countriesFromFolderNames(["XY025832_INTL_PRINT_Outdoor_Campaign_Markets"]),
  ["_Multiple_"]
);

// What slot 2 must refuse.
check(
  "an ambiguous English word is not a market",
  countriesFromFolderNames(["XY026100_IN_Progress_Assets"]),
  []
);
check(
  "nor is a suffix exception",
  countriesFromFolderNames(["XY025832_Masters_Delivery_Assets"]),
  []
);
check(
  "a job folder that describes work names no market",
  countriesFromFolderNames(["XY021012_DIGITAL_SCREENS_ODEON"]),
  []
);
check(
  "nor does one with nothing after the code",
  countriesFromFolderNames(["XY024904_Packshots"]),
  []
);

// Only folders. A task tagged with a job number is saying which job it belongs
// to, not which market it is for.
check(
  "the job-folder read does not apply to task names",
  countriesFromTaskName("XY026036_AUS_DOOH_Campaign"),
  []
);

// PAN is MAGI's code for Panama and this account has never used it that way:
// all 59 folders carrying PAN as a token are "Pan_Regional" jobs, and none ends
// in "_PAN". Reading slot 2 without this guard turned 15 pan-regional campaigns
// into Panama ones.
check(
  "Pan_Regional is not Panama",
  countriesFromFolderNames(["XY024793_Pan_Regional"]),
  []
);
check(
  "Panama written as PA in the slot still resolves",
  countriesFromFolderNames(["XY024793_PA_Outdoor_Campaign"]),
  ["Panama"]
);
check(
  "and a task deliberately named _PAN is still Panama",
  countriesFromTaskName("TAD_Print_PAN"),
  ["Panama"]
);

// A house job is not a market.
check(
  "a house job names no market",
  countriesFromFolderNames(["XY022180_XYi_Order_Of_Service_Lou"]),
  []
);

// ---------------------------------------------------------------------------
// Market FOLDER names, read whole (MAGI FOLDER NAMINGS, 21 Aug 2026)
// ---------------------------------------------------------------------------
// MAGI's sheet gives a folder name as well as a file code for all 94 markets,
// and qualifies eleven of them in brackets. The suffix walk reads the LAST
// token of a name, so every one of those died on the bracket: "FLEMISH" isn't
// a code, so the walk stopped before it ever reached "Belgium".
check(
  "a language-qualified market folder is still that market",
  countriesFromFolderNames(["Belgium (Flemish)"]),
  ["Belgium"]
);
check(
  "and the other half of the same split",
  countriesFromFolderNames(["Belgium (French)"]),
  ["Belgium"]
);
check(
  "all three Swiss folders are Switzerland",
  [
    ...countriesFromFolderNames(["Switzerland (French)"]),
    ...countriesFromFolderNames(["Switzerland (German)"]),
    ...countriesFromFolderNames(["Switzerland (Italian)"]),
  ],
  ["Switzerland", "Switzerland", "Switzerland"]
);
check(
  "Thailand (English) is Thailand",
  countriesFromFolderNames(["Thailand (English)"]),
  ["Thailand"]
);

// The worst of them, because it half-worked: "Arabic" is a territory in its own
// right, so the walk resolved the bracket and collected it as a SECOND market —
// a language chip riding along on the row beside the country.
check(
  "a language qualifier is not a second market",
  countriesFromFolderNames(["Middle East (Arabic)"]),
  ["Middle East"]
);
check(
  "nor on the UAE folder, which used to come back as two",
  countriesFromFolderNames(["Middle East & SA & UAE (Arabic)"]),
  ["United Arab Emirates"]
);
check(
  "and the English half resolves at all now",
  countriesFromFolderNames(["Middle East & SA & UAE (English)"]),
  ["United Arab Emirates"]
);

// Names MAGI writes differently from us. Matching the whole name is what makes
// these one lookup rather than a spelling problem.
check("Canada - French", countriesFromFolderNames(["Canada - French"]), ["Canadian-French"]);
check("North Macedonia", countriesFromFolderNames(["North Macedonia"]), ["Macedonia"]);
check("Lat-Am", countriesFromFolderNames(["Lat-Am"]), ["Latam / Las"]);
check("International OV", countriesFromFolderNames(["International OV"]), ["OV"]);
// MAGI spells it Telegu, the timesheet site spells it Telugu.
check("India Telegu", countriesFromFolderNames(["India Telegu"]), ["India - Telugu"]);

// Multi-word territory names were never readable by the walk either — "Kong"
// and "Montenegro" are not codes — so these folders resolved to nothing at all,
// flag or no flag.
check("Hong Kong", countriesFromFolderNames(["Hong Kong"]), ["Hong Kong"]);
check("Serbia & Montenegro", countriesFromFolderNames(["Serbia & Montenegro"]), ["Serbia & Montenegro"]);
check(
  "a flag emoji on the folder is punctuation, not a failed code",
  countriesFromFolderNames(["Switzerland (French) 🇨🇭"]),
  ["Switzerland"]
);
// Same bug, opposite outcome: this one resolved, to the wrong thing, because
// "Domestic" is a territory and it was the last token.
check(
  "Puerto Rico is Puerto Rico, not Domestic",
  countriesFromFolderNames(["Puerto Rico (Domestic)"]),
  ["Puerto Rico (Domestic)"]
);

// The whole-name match is whole-string equality against a closed list, so it
// cannot reach into a job folder and invent a market the way a scan would.
check(
  "a job folder is not a market folder",
  countriesFromFolderNames(["XY025995_INTL_DIGITAL_Outdoor_Campaign"]),
  []
);
check(
  "and the job-slot rule still runs behind it",
  countriesFromFolderNames(["XY026036_AUS_DOOH_Campaign"]),
  ["Australia"]
);

// ---------------------------------------------------------------------------
// Markets the sheet lists that we only half-had
// ---------------------------------------------------------------------------
// MDV and NPL used to resolve to "Maldives"/"Nepal" via REGION_ALIASES while
// TERRITORIES held neither — a chip with no flag, absent from the picker, and
// no checkbox on the timesheet site. Both are real territories now, and the
// 2-letter halves MAGI lists resolve too.
check("Maldives, three letters", countriesFromTaskName("TAD_Print_MDV"), ["Maldives"]);
check("Maldives, two letters", countriesFromTaskName("TAD_Print_MV"), ["Maldives"]);
check("Nepal, three letters", countriesFromTaskName("TAD_Print_NPL"), ["Nepal"]);
check("Nepal, two letters", countriesFromTaskName("TAD_Print_NP"), ["Nepal"]);
check("and as market folders", countriesFromFolderNames(["Nepal"]), ["Nepal"]);

// "CA" is gone from MAGI's sheet — it listed Canada-FR against it, and now
// lists CAN-FR alone. With the override dropped it falls back to REGION_ALIASES.
check("CA is plain Canada again", countriesFromTaskName("TAD_Print_CA"), ["Canada"]);
check("CAN-FR is still Canadian-French", countriesFromTaskName("TAD_Print_CAN-FR"), ["Canadian-French"]);
