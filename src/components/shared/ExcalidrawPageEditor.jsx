import React, { useRef, useCallback, useEffect, useState } from "react";
import {
  Excalidraw,
  getSceneVersion,
  restoreElements,
  viewportCoordsToSceneCoords,
} from "@excalidraw/excalidraw";
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

// --- Video on the canvas -----------------------------------------------
//
// Excalidraw has no video element, but it does have "embeddable" — an iframe
// it treats as a first-class object: freely placed, resized, and (the reason
// this works at all) in its list of *bindable* types, so arrows attach to a
// clip and stay attached when it moves. Excalidraw's URL resolver falls
// through to a generic iframe for any link that passes validateEmbeddable,
// and an iframe pointing at an .mp4 is the browser's own video player.
//
// Videos deliberately do NOT go through the `files` map that images use.
// That map is serialised to Storage as one JSON blob holding every image as
// base64 — fine for screenshots, ruinous for a 10 MB clip, which would be
// re-encoded and re-uploaded whole on every scene change. An embeddable
// carries only its URL, so a video costs the scene a few hundred bytes and
// the save path never touches the media.
const STORAGE_PREFIX = `${supabase.storage.from(BUCKET).getPublicUrl("").data.publicUrl}`;

// Clips are framed through our own /api/embed/video page rather than pointed
// straight at the .mp4. A raw media URL in an iframe renders Chrome's built-in
// media document, which decides for itself whether to start playing; our
// wrapper sets `controls` and no autoplay, so a board opens silent and still.
const EMBED_PREFIX = "/api/embed/video?src=";
const embedUrlFor = (fileUrl) => `${EMBED_PREFIX}${encodeURIComponent(fileUrl)}`;

// Boards saved before the wrapper existed hold links straight to the .mp4,
// and those are exactly the ones that render Chrome's media document and
// start playing the moment the board opens. Rewriting them on load fixes
// every existing board without a migration. It's deliberately not a write:
// the element's `version` is untouched, so getSceneVersion is unchanged and
// this triggers no save — it just means a legacy link never reaches the
// renderer as a bare media URL again.
const withWrappedVideoLinks = (elements) =>
  (elements || []).map((el) =>
    el?.type === "embeddable" && typeof el.link === "string" && el.link.startsWith(STORAGE_PREFIX)
      ? { ...el, link: embedUrlFor(el.link) }
      : el
  );

// Only our own embed page may be framed. Excalidraw's default allowlist (of
// YouTube, Figma and friends) is replaced entirely by this, so a board can't
// become a vector for embedding an arbitrary third-party page. Boards written
// before the wrapper existed still hold direct Storage URLs, so those stay
// valid too.
const validateEmbeddable = (url) => {
  if (typeof url !== "string") return false;
  if (url.startsWith(STORAGE_PREFIX)) return true;
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.origin === window.location.origin && parsed.pathname === "/api/embed/video";
  } catch {
    return false;
  }
};

const VIDEO_FALLBACK_SIZE = { width: 480, height: 270 };

// Read the clip's real dimensions so the element lands with the right aspect
// ratio instead of a guessed box the author has to reshape by hand.
function probeVideoSize(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const probe = document.createElement("video");
    const done = (size) => { URL.revokeObjectURL(url); resolve(size); };
    probe.onloadedmetadata = () => {
      const { videoWidth: w, videoHeight: h } = probe;
      if (!w || !h) return done(VIDEO_FALLBACK_SIZE);
      // Normalise to a sensible on-canvas size rather than the file's pixel
      // dimensions — a 4K clip would otherwise arrive as a 3840px monster.
      const scale = Math.min(1, 480 / w);
      done({ width: Math.round(w * scale), height: Math.round(h * scale) });
    };
    probe.onerror = () => done(VIDEO_FALLBACK_SIZE);
    probe.preload = "metadata";
    probe.src = url;
  });
}

async function uploadCanvasVideo(file) {
  const ext = (file.name.split(".").pop() || "mp4").toLowerCase();
  const path = `sketch-media/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { cacheControl: "3600", upsert: false, contentType: file.type || undefined });
  if (error) {
    reportError(error, { where: "sketch video upload" });
    return null;
  }
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
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
  const apiRef = useRef(null);
  const videoInputRef = useRef(null);
  const [busy, setBusy] = useState(false);

  // Drop a clip onto the canvas and it lands where the pointer let go; use
  // the toolbar button and it lands in the middle of what you're looking at.
  const insertVideo = useCallback(async (file, at) => {
    if (!apiRef.current) return;
    setBusy(true);
    try {
      const [url, size] = await Promise.all([uploadCanvasVideo(file), probeVideoSize(file)]);
      if (!url) return;
      const state = apiRef.current.getAppState();
      const origin = at
        ? viewportCoordsToSceneCoords({ clientX: at.clientX, clientY: at.clientY }, state)
        : viewportCoordsToSceneCoords(
            { clientX: state.offsetLeft + state.width / 2, clientY: state.offsetTop + state.height / 2 },
            state
          );
      // restoreElements, not convertToExcalidrawElements. The latter passes
      // embeddable/iframe/freedraw skeletons through untouched —
      // `case "embeddable": { s = l; break }` — filling in none of the fields
      // every element is required to carry. The half-built element reached
      // the renderer without id/seed/groupIds/boundElements and it read
      // .length off one of them. restoreElements is the supported normaliser
      // and fills the whole shape.
      const [element] = restoreElements(
        [
          {
            type: "embeddable",
            x: origin.x - size.width / 2,
            y: origin.y - size.height / 2,
            width: size.width,
            height: size.height,
            link: embedUrlFor(url),
          },
        ],
        null
      );
      if (!element) {
        reportError(new Error("Sketch video: element failed to restore"), { url });
        return;
      }
      apiRef.current.updateScene({
        elements: [...apiRef.current.getSceneElements(), element],
        // Select it on arrival, so it can be moved or arrowed to straight
        // away without hunting for it.
        appState: { selectedElementIds: { [element.id]: true } },
      });
    } finally {
      setBusy(false);
    }
  }, []);

  // Excalidraw handles dropped images itself but ignores video files, so this
  // listens on the capture phase: video is claimed before Excalidraw sees the
  // event, anything else falls through to its own handling untouched.
  const onDropCapture = useCallback((e) => {
    const file = Array.from(e.dataTransfer?.files || []).find((f) => f.type.startsWith("video/"));
    if (!file) return;
    e.preventDefault();
    e.stopPropagation();
    insertVideo(file, { clientX: e.clientX, clientY: e.clientY });
  }, [insertVideo]);

  const onVideoChosen = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) await insertVideo(file);
  };

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
        elements: withWrappedVideoLinks(content?.elements),
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
      <div
        style={{ position: "absolute", top: 0, left: 0, width: "110%", height: "110%", zoom: 1 / 1.1 }}
        onDropCapture={onDropCapture}
      >
        <Excalidraw
          initialData={initialData}
          onChange={handleChange}
          excalidrawAPI={(api) => { apiRef.current = api; }}
          validateEmbeddable={validateEmbeddable}
          renderTopRightUI={() => (
            <button
              type="button"
              onClick={() => videoInputRef.current?.click()}
              disabled={busy}
              title="Add a video to this board"
              style={{
                display: "flex", alignItems: "center", gap: 6, height: 32, padding: "0 10px",
                borderRadius: 8, border: "1px solid var(--default-border-color, #e3e8ef)",
                background: "var(--island-bg-color, #fff)", color: "var(--text-primary-color, #1b1b1f)",
                fontSize: 12, fontWeight: 600, cursor: busy ? "wait" : "pointer",
                opacity: busy ? 0.6 : 1, whiteSpace: "nowrap",
              }}
            >
              {busy ? "Uploading…" : "🎬 Video"}
            </button>
          )}
        />
      </div>
      <input
        ref={videoInputRef}
        type="file"
        accept="video/*"
        onChange={onVideoChosen}
        style={{ display: "none" }}
      />
    </div>
  );
}
