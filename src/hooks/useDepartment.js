import { useState, useEffect } from "react";
import { supabase } from "../lib/supabaseClient";

const CACHE_KEY = "xyi_department";
const PREVIEW_KEY = "xyi_department_preview";
const PREVIEW_EVENT = "xyi:department-preview-changed";

// Admin-only "view as" tool (see DepartmentPreviewBanner + AdminModal) — lets
// an admin see Home/Rail/command-palette/the board exactly as a chosen
// department would, without touching their own real profiles.department row.
// Stored under a separate key so the real cached department is never at risk
// of being overwritten, and a custom event lets every mounted useDepartment()
// instance (App, Home, Rail each call it independently) react immediately
// when the preview changes, without a page reload.
export function getDepartmentPreview() {
  return localStorage.getItem(PREVIEW_KEY) || null;
}

export function setDepartmentPreview(dept) {
  if (dept) localStorage.setItem(PREVIEW_KEY, dept);
  else localStorage.removeItem(PREVIEW_KEY);
  window.dispatchEvent(new CustomEvent(PREVIEW_EVENT));
}

// The signed-in member's department (profiles.department: PM | Motion |
// Digital | AM | Operations | Print, or null), or — while an admin preview is
// active — whichever department they're previewing. Drives which pages Home,
// the Rail, and the command palette offer — see src/lib/departments.js.
//
// localStorage-cached so navigation renders with the right page set on the
// first frame; the profiles row is still consulted in the background so a
// department change in Administration takes effect on the next load. A
// preview override always wins over both the cached and freshly-fetched real
// value, so an admin poking at "what would PM see" doesn't get silently
// reverted mid-session by their own real profile resolving in the background.
export function useDepartment() {
  const [realDepartment, setRealDepartment] = useState(
    () => localStorage.getItem(CACHE_KEY) || null
  );
  const [department, setDepartment] = useState(
    () => getDepartmentPreview() || localStorage.getItem(CACHE_KEY) || null
  );

  useEffect(() => {
    const uid = localStorage.getItem("wrike_user_id");
    if (!uid) return;
    let cancelled = false;
    supabase
      .from("profiles")
      .select("department")
      .eq("wrike_user_id", uid)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        const dept = data?.department || null;
        if (dept) localStorage.setItem(CACHE_KEY, dept);
        else localStorage.removeItem(CACHE_KEY);
        setRealDepartment(dept);
        if (!getDepartmentPreview()) setDepartment(dept);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onPreviewChange = () => {
      setDepartment(getDepartmentPreview() || realDepartment);
    };
    window.addEventListener(PREVIEW_EVENT, onPreviewChange);
    return () => window.removeEventListener(PREVIEW_EVENT, onPreviewChange);
  }, [realDepartment]);

  return department;
}

// For UI that needs to know it's in preview mode specifically (the banner,
// the admin switcher) rather than just the effective department everything
// else consumes.
export function useDepartmentPreviewState() {
  const [preview, setPreview] = useState(getDepartmentPreview);

  useEffect(() => {
    const onChange = () => setPreview(getDepartmentPreview());
    window.addEventListener(PREVIEW_EVENT, onChange);
    return () => window.removeEventListener(PREVIEW_EVENT, onChange);
  }, []);

  return preview;
}
