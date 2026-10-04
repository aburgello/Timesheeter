// The discovered film-code dictionary (wrike_sync_meta.film_code_mappings) and
// the hand edits on top of it (film_code_overrides: a name sets a code, null
// removes it). Edits are reapplied after every merge, so discovery never
// undoes them.

export function mergeFilmMappings(existing = {}, found = {}, overrides = {}) {
  const out = { ...existing, ...found };
  for (const [code, name] of Object.entries(overrides || {})) {
    if (name) out[code] = name;
    else delete out[code];
  }
  return out;
}

export const normalizeFilmCode = (code) => String(code || "").trim().toUpperCase();

// Codes the way the scans find them: 2-8 letters and digits, starting with a letter.
export const isFilmCode = (code) => /^[A-Z][A-Z0-9]{1,7}$/.test(code);
