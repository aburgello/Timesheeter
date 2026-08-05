import { supabase } from "./supabaseClient";
import { setRuntimeAliases } from "../utils/countryCodes";

// Loads the curated aliases (Administration → Translation Countries) into the
// resolver's runtime overlay.
//
// Deliberately fire-and-forget: countryCodes.js starts with an empty overlay
// and its built-in table already resolves everything it did yesterday, so a
// failed or slow load costs the curated corrections and nothing else. Nothing
// waits on this, and nothing breaks without it.
//
// Rows are small (an alias and a territory name) and change rarely, so this is
// one select per session, refreshed explicitly by the editor after a write.

let loaded = false;
let inflight = null;

export async function loadCountryAliases({ force = false } = {}) {
  if (loaded && !force) return;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const { data, error } = await supabase
        .from("country_aliases")
        .select("alias,territory");
      if (error) return;
      setRuntimeAliases(data || []);
      loaded = true;
    } catch {
      /* offline / table missing → built-in aliases carry on alone */
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}
