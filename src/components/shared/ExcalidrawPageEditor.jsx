import React, { useRef, useCallback, useEffect, useState } from "react";
import { Excalidraw, getSceneVersion } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { supabase } from "../../lib/supabaseClient";
import { reportError } from "../../lib/monitoring";

// ---------------------------------------------------------------------------
// ExcalidrawPageEditor — the "sketch" counterpart to RichNoteEditor. Loaded
// via React.lazy from Canvas.js so its (sizeable) bundle and CSS only cost
// anything once a sketch page is actually opened.
//
// Storage shape: { elements, appState: { viewBackgroundColor }, filesPath }.
//
// `filesPath` — not `files` — is the important part. Excalidraw hands back a
// `files` map holding every embedded image as a base64 data URL, and the
// first version of this component wrote that straight into the page's jsonb
// column. One sketch with a couple of screenshots reached 2.3 MB in a single
// row, against ~400 bytes for a text note, and Postgres rewrites a row whole
// on every UPDATE — so each autosave rewrote all 2.3 MB (plus its TOAST and
// WAL), left a 2.3 MB dead tuple behind, and took a row lock while doing it.
// That showed up as lock contention, statement timeouts, and a table carrying
// ~10x bloat. The blobs now live in Storage (same bucket as note images) and
// the row keeps only a path, so a save moves kilobytes instead of megabytes.
// ---------------------------------------------------------------------------

const BUCKET = "notes-images";
const filesPathFor = (pageId) => `sketches/${pageId}.json`;
// Images are added/removed rarely; drawing never changes this. Comparing the
// id set is enough to know whether the blobs need re-uploading at all.
const filesKeyOf = (files) => Object.keys(files || {}).sort().join(",");

async function downloadFiles(path) {
  if (!path) return {};
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error || !data) return {};
  try {
    return JSON.parse(await data.text());
  } catch {
    return {};
  }
}

async function uploadFiles(path, files) {
  const blob = new Blob([JSON.stringify(files)], { type: "application/json" });
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, blob, { upsert: true, cacheControl: "3600" });
  return !error;
}

export default function ExcalidrawPageEditor({ pageId, content, onChange }) {
  const saveTimerRef = useRef(null);
  const sceneVersionRef = useRef(null);
  const filesKeyRef = useRef(null);   // last files map we've seen
  const uploadedKeyRef = useRef(null); // files map currently in Storage
  const filesPathRef = useRef(content?.filesPath || null);
  // The commit the debounce hasn't run yet, so unmount can flush it instead
  // of discarding it.
  const pendingRef = useRef(null);
  const [initialData, setInitialData] = useState(null);

  // Resolve the scene's images before handing Excalidraw its initialData —
  // it takes that once, on mount, so there's nothing to hand it later.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Rows written by the original version keep their images inline. Read
      // those, then migrate them out on the spot: one write now shrinks the
      // row permanently, instead of leaving a multi-megabyte row to be
      // rewritten by every future save.
      const legacyFiles =
        content?.files && Object.keys(content.files).length ? content.files : null;
      const files = legacyFiles || (await downloadFiles(content?.filesPath));
      if (cancelled) return;

      sceneVersionRef.current = getSceneVersion(content?.elements || []);
      filesKeyRef.current = filesKeyOf(files);
      uploadedKeyRef.current = legacyFiles ? null : filesKeyOf(files);

      if (legacyFiles) {
        const path = filesPathFor(pageId);
        if (await uploadFiles(path, legacyFiles)) {
          if (cancelled) return;
          filesPathRef.current = path;
          uploadedKeyRef.current = filesKeyRef.current;
          onChange({
            elements: content.elements || [],
            appState: { viewBackgroundColor: content.appState?.viewBackgroundColor },
            filesPath: path,
          });
        }
      }

      setInitialData({
        elements: content?.elements || [],
        // Zoom isn't persisted, so every open starts from the same explicit
        // 50% — sketches tend to be wider than the panel, and starting zoomed
        // out shows the whole board instead of a cropped-in corner.
        appState: { ...(content?.appState || {}), zoom: { value: 0.5 } },
        files,
        scrollToContent: !!(content?.elements?.length || Object.keys(files).length),
      });
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);

  const handleChange = useCallback((elements, appState, files) => {
    const version = getSceneVersion(elements);
    const filesKey = filesKeyOf(files);

    // Excalidraw fires onChange on pointer movement and selection changes, not
    // just real edits — so without this guard, idly moving the mouse across a
    // sketch queued a full row rewrite every debounce window. getSceneVersion
    // only advances when an element actually changes.
    if (version === sceneVersionRef.current && filesKey === filesKeyRef.current) return;
    sceneVersionRef.current = version;
    filesKeyRef.current = filesKey;

    const commit = async () => {
      pendingRef.current = null;
      if (filesKey !== uploadedKeyRef.current) {
        if (Object.keys(files || {}).length) {
          const path = filesPathFor(pageId);
          if (await uploadFiles(path, files)) {
            filesPathRef.current = path;
            uploadedKeyRef.current = filesKey;
          } else {
            // The blobs didn't make it to Storage, so a row pointing at (or
            // worse, away from) them must not be written: for a sketch whose
            // images were still inline, filesPath is null here, and saving
            // would overwrite the only copy of those images with a row that
            // has neither the blobs nor a path to them. Skip this save
            // entirely and rewind the change-detector so the next edit
            // retries the upload. This account has actually returned Storage
            // errors under quota pressure — this path is not hypothetical.
            filesKeyRef.current = uploadedKeyRef.current;
            reportError(new Error("Sketch save skipped: image upload failed"), { pageId });
            console.error("[ExcalidrawPageEditor] image upload failed — save skipped, will retry on next edit");
            return;
          }
        } else {
          filesPathRef.current = null;
          uploadedKeyRef.current = filesKey;
        }
      }
      onChange({
        elements,
        appState: { viewBackgroundColor: appState.viewBackgroundColor },
        filesPath: filesPathRef.current,
      });
    };

    pendingRef.current = commit;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(commit, 1200);
  }, [pageId, onChange]);

  // Flush, don't discard: drawing and immediately switching pages used to
  // throw away the last 1.2s of work when the unmount cleared the timer.
  useEffect(() => () => {
    clearTimeout(saveTimerRef.current);
    if (pendingRef.current) {
      const commit = pendingRef.current;
      pendingRef.current = null;
      commit(); // fire-and-forget: the save talks to Supabase, not this component
    }
  }, []);

  if (!initialData) {
    return <div className="h-full min-h-[640px] bg-[#faf7f2] animate-pulse" />;
  }

  return (
    // The app runs at a deliberate, app-wide `zoom: 1.1` (src/tailwind.css).
    // Excalidraw does its own screen-to-canvas coordinate math internally —
    // it has no idea an ancestor is scaling the page, so every click/draw
    // lands 10% off from where the cursor visually is (worse the further
    // from the origin). We can't patch Excalidraw's internals the way
    // RichNoteEditor's own hand-rolled positioning was fixed; instead this
    // inner layer applies the exact inverse zoom (1/1.1), so the NET zoom
    // Excalidraw's subtree experiences is 1.1 × (1/1.1) = 1 — a genuine,
    // un-zoomed 100% as far as Excalidraw can tell. The 110% width/height
    // compensates the visual shrink that same inverse zoom would otherwise
    // cause, so the canvas still fills the outer box edge-to-edge instead of
    // rendering undersized inside it.
    <div style={{ height: "100%", minHeight: 640, position: "relative", overflow: "hidden" }}>
      <div style={{ position: "absolute", top: 0, left: 0, width: "110%", height: "110%", zoom: 1 / 1.1 }}>
        <Excalidraw initialData={initialData} onChange={handleChange} />
      </div>
    </div>
  );
}
