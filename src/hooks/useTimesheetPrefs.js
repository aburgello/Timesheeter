import { useState, useEffect, useCallback } from "react";
import { supabase } from "../lib/supabaseClient";

const CACHE_KEY = "xyi_timesheet_prefs";
const CHANGED_EVENT = "xyi:timesheet-prefs-changed";

// How a member wants their pulled timesheet rows to arrive:
//
//   defaultCategory    the category pulled rows land on. null = never chosen,
//                      which is NOT the same as "" — only null lets the pull
//                      fall back to its PRINT/REVISION keyword guess.
//   groupMultiCountry  merge rows that differ only by market into one entry.
//
// Stored on profiles (see migrations/20260812120000_timesheet_prefs_per_member.sql)
// because both describe the person, not the browser — on localStorage alone
// they would reset on a second machine. localStorage is still used here as a
// first-frame cache so a pull triggered before the profile row resolves doesn't
// silently run with the wrong preference.
const EMPTY = { defaultCategory: null, groupMultiCountry: false };

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw);
    return {
      defaultCategory: parsed?.defaultCategory ?? null,
      groupMultiCountry: !!parsed?.groupMultiCountry,
    };
  } catch {
    // A malformed cache is not worth failing a page load over — the profile
    // row below is the real source and overwrites this within a tick.
    return EMPTY;
  }
}

function writeCache(prefs) {
  localStorage.setItem(CACHE_KEY, JSON.stringify(prefs));
  // Profile → Settings and the Legacy grid's own dropdown both edit these, and
  // both can be mounted at once. A custom event keeps every mounted instance
  // showing the same values without a reload, the same way useDepartment keeps
  // its preview in step across App/Home/Rail.
  window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
}

// Read-only access for non-React callers (the pull path reads the live value at
// the moment the button is pressed rather than closing over a render-time one).
export function getTimesheetPrefs() {
  return readCache();
}

export function useTimesheetPrefs() {
  const [prefs, setPrefsState] = useState(readCache);

  useEffect(() => {
    const uid = localStorage.getItem("wrike_user_id");
    if (!uid) return;
    let cancelled = false;
    supabase
      .from("profiles")
      .select("default_category, group_multi_country")
      .eq("wrike_user_id", uid)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled || error || !data) return;
        const next = {
          defaultCategory: data.default_category ?? null,
          groupMultiCountry: !!data.group_multi_country,
        };
        localStorage.setItem(CACHE_KEY, JSON.stringify(next));
        setPrefsState(next);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onChange = () => setPrefsState(readCache());
    window.addEventListener(CHANGED_EVENT, onChange);
    return () => window.removeEventListener(CHANGED_EVENT, onChange);
  }, []);

  // Optimistic: the cache and every mounted instance update immediately, then
  // the write lands. A failed write leaves the cache ahead of the row, which
  // the next load corrects — acceptable for a preference, and much better than
  // a toggle that visibly lags a round trip on every click.
  const setPrefs = useCallback(async (patch) => {
    const next = { ...readCache(), ...patch };
    writeCache(next);
    setPrefsState(next);

    const uid = localStorage.getItem("wrike_user_id");
    if (!uid) return;
    await supabase
      .from("profiles")
      .update({
        default_category: next.defaultCategory,
        group_multi_country: next.groupMultiCountry,
      })
      .eq("wrike_user_id", uid);
  }, []);

  return { ...prefs, setPrefs };
}
