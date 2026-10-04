import { mergeFilmMappings, isFilmCode, normalizeFilmCode } from "../src/lib/filmCodes.js";

check("film codes: discovery adds to what's known",
  mergeFilmMappings({ ODY: "Odyssey" }, { ZAL: "Zalo" }), { ODY: "Odyssey", ZAL: "Zalo" });
check("film codes: a corrected name beats a rediscovered one",
  mergeFilmMappings({ ODY: "Odyssey" }, { ODY: "Odyssey Trailer" }, { ODY: "The Odyssey" }), { ODY: "The Odyssey" });
check("film codes: a removed code stays removed",
  mergeFilmMappings({ FILM: "Film" }, { FILM: "Film" }, { FILM: null }), {});
check("film codes: a hand-added code appears", mergeFilmMappings({}, {}, { NEWF: "New Film" }), { NEWF: "New Film" });
check("film codes: shape", [isFilmCode("ODY"), isFilmCode("O"), isFilmCode("1AB"), isFilmCode(normalizeFilmCode(" wk2 "))], [true, false, false, true]);
