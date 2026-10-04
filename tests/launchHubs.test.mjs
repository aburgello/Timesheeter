// Which Print launch hubs the Launch Tracker shows: those that belong to a
// film. Cases are real hubs from the shared cache (October 2026).
import { belongsToFilm } from "../src/lib/wrikeEnrich.js";

const hub = (title, projectName, projectNameSource = null) => ({ title, projectName, projectNameSource });

const shown = [
  hub("FID_INTL_Bungi_Launch_Markets", "Forgotten Island"),           // film from folders
  hub("EX2_Teaser_Launch_Markets", "The Exorcist Martyrs", "path"),
  hub("TRSC_Brandon_Launch_Markets", "Trsc", "prefix"),              // code, not yet translated
  hub("MRI_Confetti_Launch_Markets", "Mri", "prefix"),
  hub("TG40th_INTL_MultipleArtwork_Launch_Markets", "Tg40th", "prefix"),
  hub("EX2_Teaser_Launch_Markets_Instagram - TEST", "Ex2"),
];
const hidden = [
  hub("3._ArtworkName_Launch_Markets", "3."),                         // template copies
  hub("4._ArtworkName_Launch_Print_Requests", "4."),
  hub("_Launch_Markets", ""),
  hub("_Launch_Markets", "", "prefix"),
];

check("launch hubs: real ones shown", shown.map(belongsToFilm), shown.map(() => true));
check("launch hubs: template copies hidden", hidden.map(belongsToFilm), hidden.map(() => false));
