import { useState, useEffect, useCallback } from "react";
import { supabase } from "../lib/supabaseClient";

/**
 * Shared job_number -> Job Book record lookup.
 *
 * Tracker and Legacy both guess job/film/client info from raw Wrike data
 * (folder tree-climbing, title parsing) — fragile by nature. The `jobs`
 * table is the authoritative, admin-curated source once a job has been
 * seen: any correction made in Management > Job Book should be trusted
 * over a fresh Wrike guess everywhere else.
 *
 * This hook also self-populates `jobs` the first time a job number is
 * encountered, so Job Book fills in from real usage instead of requiring
 * manual entry, while never overwriting a row that's already there.
 *
 * IMPORTANT — the lookup is keyed on the XY CODE (e.g. "XY025716"), not the
 * full "Film Title : XY025716, Description" string. A single job surfaces in
 * three inconsistent shapes: the admin panel writes the full canonical string,
 * DEFAULT_JOBS carries the full string, but a raw Wrike timelog often carries
 * only the bare code. Keying on the code lets a bare-code pull inherit the
 * curated film/client from a full-string Job Book row (and vice versa), and
 * stops the same job being registered twice under two different keys.
 */

// Normalise any job-number shape down to its XY code for matching; fall back to
// the trimmed string when there's no code (e.g. a free-text internal job).
const jobKey = (jobNumber) => {
  if (!jobNumber) return "";
  const m = jobNumber.match(/XY\d{5,6}/i);
  return m ? m[0].toUpperCase() : jobNumber.trim();
};

// When two rows collapse onto the same code (e.g. a curated full-string row and
// a leftover bare-code auto-registration), keep the richer one: a filled
// film_title/client and the canonical "Film : CODE, Desc" form each count.
const rowScore = (j) =>
  (j.film_title ? 1 : 0) +
  (j.client ? 1 : 0) +
  ((j.job_number || "").includes(" : ") ? 1 : 0);

export function useJobLookup() {
  const [jobMap, setJobMap] = useState({});

  const load = useCallback(async () => {
    const { data } = await supabase.from("jobs").select("*");
    const map = {};
    (data || []).forEach((j) => {
      if (!j.job_number) return;
      const key = jobKey(j.job_number);
      const existing = map[key];
      if (!existing || rowScore(j) > rowScore(existing)) map[key] = j;
    });
    setJobMap(map);
  }, []);

  useEffect(() => { load(); }, [load]);

  const getJob = useCallback((jobNumber) => jobMap[jobKey(jobNumber)] || null, [jobMap]);

  // Register a job number the first time it's seen, or fill in blank fields on an
  // existing row (e.g. one backfilled without a client). Never overwrites a field
  // that's already set — once Job Book has a value, that's the source of truth.
  const ensureJob = useCallback(async (jobNumber, guess = {}) => {
    if (!jobNumber || jobNumber === "⚠️ Unassigned") return;
    const key = jobKey(jobNumber);
    const existing = jobMap[key];

    if (!existing) {
      const payload = {
        job_number: jobNumber,
        film_title: guess.filmTitle || null,
        client: guess.client || null,
      };
      // Optimistic local add so repeated calls this session don't re-insert
      setJobMap((prev) => (prev[key] ? prev : { ...prev, [key]: payload }));
      const { error } = await supabase.from("jobs").insert(payload);
      // 23505 = unique_violation — another tab/component already registered it, fine to ignore
      if (error && error.code !== "23505") {
        console.warn("Failed to register job in Job Book:", error.message);
      }
      return;
    }

    // Fill gaps only — build a patch of just the blank fields we can now fill
    const patch = {};
    if (!existing.film_title && guess.filmTitle) patch.film_title = guess.filmTitle;
    if (!existing.client && guess.client) patch.client = guess.client;
    if (Object.keys(patch).length === 0) return;

    setJobMap((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
    // Update the exact stored row by its real job_number, not the code key.
    const { error } = await supabase.from("jobs").update(patch).eq("job_number", existing.job_number);
    if (error) console.warn("Failed to fill in Job Book gaps:", error.message);
  }, [jobMap]);

  return { getJob, ensureJob };
}
