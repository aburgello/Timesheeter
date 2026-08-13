import React, { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { useEditor, EditorContent, NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import { Node, mergeAttributes } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { TextStyle } from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import { Image } from "@tiptap/extension-image";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import * as Y from "yjs";
import { supabase } from "../../lib/supabaseClient";
import { createSupabaseYProvider } from "../../lib/yjsSupabaseProvider";
import { reportError } from "../../lib/monitoring";
import {
  Bold as BoldIcon, Italic as ItalicIcon, Underline as UnderlineIcon, Strikethrough,
  Heading2, Heading3, List, ListOrdered, ListChecks, Quote, Code2, Link as LinkIcon, GripVertical,
  Palette, Image as ImageIcon,
} from "lucide-react";

// Images and videos live in the public "notes-images" Supabase Storage bucket
// rather than inline (base64) in the note's JSON — the same pattern DOOH specs
// use (Canvas.js's "dooh-specs" bucket) — so a page full of screenshots doesn't
// balloon the jsonb column and every save doesn't have to round-trip the
// media bytes. For video this is not merely an optimisation: the note travels
// through the Yjs document on every keystroke, and a <video> can only stream
// and seek from a real URL — never from an embedded data URI, which the
// browser must download in full before it will play a single frame.

// Supabase's per-file upload ceiling on the free plan. Checked here so an
// oversized drop fails with an explanation instead of a silent no-op.
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const isImageFile = (f) => f.type.startsWith("image/");
// Not every video/* file actually plays in a browser — an iPhone .mov is
// usually HEVC, which Chrome and Firefox won't decode. We can't transcode
// client-side, so those upload fine and then show an empty player; the
// canPlayType probe below warns at pick time rather than after the upload.
const isVideoFile = (f) => f.type.startsWith("video/");
const isMediaFile = (f) => isImageFile(f) || isVideoFile(f);

function videoPlayabilityWarning(file) {
  const probe = document.createElement("video");
  // "" = definitely not supported, "maybe"/"probably" = worth attempting.
  return probe.canPlayType(file.type) === ""
    ? `${file.name} uses a format this browser can't play (${file.type || "unknown"}). It will upload, but the player may stay blank — re-encode to MP4 (H.264) or WebM first.`
    : null;
}

async function uploadNoteMedia(file) {
  if (file.size > MAX_UPLOAD_BYTES) {
    reportError(new Error(`Note upload too large: ${file.name} is ${(file.size / 1024 / 1024).toFixed(1)}MB (limit ${MAX_UPLOAD_BYTES / 1024 / 1024}MB)`));
    return null;
  }
  const fallbackExt = isVideoFile(file) ? "mp4" : "png";
  const ext = (file.name.split(".").pop() || fallbackExt).toLowerCase();
  const path = `${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage
    .from("notes-images")
    .upload(path, file, { cacheControl: "3600", upsert: false, contentType: file.type || undefined });
  if (error) {
    reportError(error);
    return null;
  }
  const { data } = supabase.storage.from("notes-images").getPublicUrl(path);
  return data.publicUrl;
}

async function insertUploadedMedia(view, file, atPos) {
  const url = await uploadNoteMedia(file);
  if (!url) return;
  const { state, dispatch } = view;
  const pos = atPos ?? state.selection.from;
  const node = state.schema.nodes[isVideoFile(file) ? "video" : "image"].create({ src: url });
  dispatch(state.tr.insert(pos, node));
}

// Drag-to-resize handle on the bottom-right corner, shown only while the
// media node is the current ProseMirror selection. Width is stored as a
// node attribute (part of the doc JSON, so it round-trips through
// save/load like any other content) rather than as transient DOM state.
// Shared by the image and video node views — the gesture is identical, only
// the element being measured differs.
function useDragResize(elRef, updateAttributes) {
  return useCallback((e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = elRef.current.getBoundingClientRect().width;
    // The drag is measured against the media's own parent, so a width dragged
    // out here stays proportional when the pane is resized later — dropping a
    // fixed pixel count in would pin it to whatever this window happens to be.
    const trackWidth = elRef.current.parentElement?.parentElement?.getBoundingClientRect().width || startWidth;
    const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    const onMove = (ev) => {
      const dx = (ev.clientX - startX) / zoom;
      const pct = ((startWidth + dx) / trackWidth) * 100;
      updateAttributes({ width: `${Math.min(100, Math.max(15, Math.round(pct)))}%` });
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, [elRef, updateAttributes]);
}

// Video defaults to filling the text column: left to its intrinsic size a
// clip exported at some arbitrary resolution sets its own width, so a note
// with several of them looked ragged for no reason the author could see.
// Images keep their intrinsic size ("auto") — notes are full of small
// screenshots and pasted logos, and blowing those up to the column width
// would upscale them into a blur.
const DEFAULT_VIDEO_WIDTH = "100%";
const DEFAULT_IMAGE_WIDTH = "auto";

// The presets are what make a row of clips possible: two halves or three
// thirds sit side by side because the node views are inline-block, so they
// flow like words and wrap when they run out of room. The subtracted pixels
// leave the gutter between them.
const WIDTH_PRESETS = [
  { label: "Full", title: "Full column width", value: "100%" },
  { label: "½", title: "Half width — two fit side by side", value: "calc(50% - 5px)" },
  { label: "⅓", title: "Third width — three fit side by side", value: "calc(33.333% - 7px)" },
];

// Widths were once plain pixel numbers. Those notes still exist, so a number
// keeps meaning pixels; everything written since is a CSS length.
const cssWidth = (width, fallback = DEFAULT_VIDEO_WIDTH) => {
  if (width == null || width === "") return fallback;
  return typeof width === "number" ? `${width}px` : width;
};

function ResizeHandle({ onPointerDown }) {
  return (
    <span
      onPointerDown={onPointerDown}
      title="Drag to resize"
      style={{
        position: "absolute", right: -5, bottom: -5, width: 14, height: 14, borderRadius: 4,
        background: "var(--rne-accent)", border: "2px solid #fff", boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
        cursor: "nwse-resize", touchAction: "none", zIndex: 2,
      }}
    />
  );
}

// Width presets, shown above the media while it's selected. Sits inside the
// node view rather than in a portal like the text toolbars: it's anchored to
// the node, so it has no reason to escape the node's own box.
function WidthPresets({ current, defaultWidth, onPick }) {
  return (
    <span
      contentEditable={false}
      style={{
        position: "absolute", top: -14, left: 0, zIndex: 3, display: "flex", gap: 2, padding: 2,
        borderRadius: 8, background: "var(--rne-surface, #fff)", border: "1px solid var(--rne-rule, #e3e8ef)",
        boxShadow: "0 2px 8px rgba(0,0,0,0.12)", lineHeight: 1,
      }}
    >
      {WIDTH_PRESETS.map((p) => {
        const active = cssWidth(current, defaultWidth) === p.value;
        return (
          <button
            key={p.label}
            type="button"
            title={p.title}
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onPick(p.value); }}
            style={{
              minWidth: 24, height: 20, padding: "0 6px", borderRadius: 6, border: "none", cursor: "pointer",
              fontSize: 11, fontWeight: 700, fontFamily: "inherit",
              background: active ? "var(--rne-accent)" : "transparent",
              color: active ? "#fff" : "var(--rne-muted, #64748b)",
            }}
          >
            {p.label}
          </button>
        );
      })}
    </span>
  );
}

function MediaFrame({ width, defaultWidth, selected, editable, updateAttributes, onResizeStart, children }) {
  const resolved = cssWidth(width, defaultWidth);
  const intrinsic = resolved === "auto";
  return (
    <NodeViewWrapper
      as="span"
      className="rne-media"
      // data-intrinsic lets the CSS hand sizing back to the media's own
      // dimensions; an explicit width always wins over it.
      data-intrinsic={intrinsic ? "true" : undefined}
      style={{ width: intrinsic ? undefined : resolved, outline: selected ? "2px solid var(--rne-accent)" : "none", outlineOffset: 2 }}
    >
      {children}
      {selected && editable && (
        <>
          <WidthPresets
            current={width}
            defaultWidth={defaultWidth}
            onPick={(value) => updateAttributes({ width: value })}
          />
          <ResizeHandle onPointerDown={onResizeStart} />
        </>
      )}
    </NodeViewWrapper>
  );
}

function ImageResizeView({ node, updateAttributes, selected, editor }) {
  const { src, alt, width } = node.attrs;
  const imgRef = useRef(null);
  const onResizeStart = useDragResize(imgRef, updateAttributes);

  return (
    <MediaFrame
      width={width}
      defaultWidth={DEFAULT_IMAGE_WIDTH}
      selected={selected}
      editable={editor.isEditable}
      updateAttributes={updateAttributes}
      onResizeStart={onResizeStart}
    >
      <img ref={imgRef} src={src} alt={alt || ""} draggable={false} className="rne-img" />
    </MediaFrame>
  );
}

function VideoResizeView({ node, updateAttributes, selected, editor }) {
  const { src, width } = node.attrs;
  const videoRef = useRef(null);
  const onResizeStart = useDragResize(videoRef, updateAttributes);

  return (
    <MediaFrame
      width={width}
      defaultWidth={DEFAULT_VIDEO_WIDTH}
      selected={selected}
      editable={editor.isEditable}
      updateAttributes={updateAttributes}
      onResizeStart={onResizeStart}
    >
      <video
        ref={videoRef}
        src={src}
        controls
        // metadata only: the poster frame and duration appear immediately, but
        // nothing downloads the body of the file until someone hits play. A
        // note with several clips would otherwise pull tens of megabytes of
        // Storage egress just by being opened.
        preload="metadata"
        playsInline
        draggable={false}
        className="rne-video"
        // The controls are real DOM inside an atom node view. Without this,
        // ProseMirror treats a pointerdown on the scrubber as the start of a
        // node drag and the timeline can't be dragged.
        onPointerDown={(e) => e.stopPropagation()}
      />
    </MediaFrame>
  );
}

const ResizableImage = Image.extend({
  // The base Image extension knows only src/alt/title, and TipTap drops
  // attributes a node hasn't declared — so every image resize was being
  // thrown away on save, however carefully the node view stored it. Declaring
  // width here is what actually makes it survive a reload.
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        renderHTML: ({ width }) => (width ? { style: `width: ${cssWidth(width)}` } : {}),
        parseHTML: (el) => el.style.width || null,
      },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageResizeView);
  },
});

// TipTap ships no video node, so this is the minimal one: an atom block
// holding a Storage URL plus the same width attribute images carry. renderHTML
// matters even though the node view owns the on-screen rendering — it is what
// gets produced when a note is copied out or serialised to HTML.
const Video = Node.create({
  name: "video",
  group: "block",
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      src: { default: null },
      width: {
        default: null,
        renderHTML: ({ width }) => (width ? { style: `width: ${cssWidth(width)}` } : {}),
        parseHTML: (el) => el.style.width || null,
      },
    };
  },

  parseHTML() {
    return [{ tag: "video[src]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["video", mergeAttributes(HTMLAttributes, { controls: "true", preload: "metadata", class: "rne-video" })];
  },

  addCommands() {
    return {
      setVideo:
        (options) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: options }),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(VideoResizeView);
  },
});

const encodeYState = (doc) => {
  const bytes = Y.encodeStateAsUpdate(doc);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
};

const decodeYState = (str) => {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

// Does this stored note actually hold anything? Covers both shapes the column
// has held: TipTap's {type:"doc",content:[...]} and the bare arrays left over
// from the BlockNote era. An empty doc is a single empty paragraph, which has
// a content array but no text in it.
const hasContent = (content) => {
  if (!content) return false;
  const json = JSON.stringify(content);
  return json.includes('"text"') || json.includes('"image"') || json.includes('"video"');
};

const TEXT_COLORS = [
  { label: "Default", value: null },
  { label: "Gray", value: "#78716c" },
  { label: "Red", value: "#dc2626" },
  { label: "Orange", value: "#ea580c" },
  { label: "Amber", value: "#d97706" },
  { label: "Green", value: "#16a34a" },
  { label: "Teal", value: "#0d9488" },
  { label: "Blue", value: "#2563eb" },
  { label: "Purple", value: "#9333ea" },
  { label: "Pink", value: "#db2777" },
];

// ---------------------------------------------------------------------------
// RichNoteEditor — shared TipTap-based rich text editor for Notes Canvas and
// End of Campaign notes (replaces the previous BlockNote integration).
//
// BlockNote positioned its block "+"/drag handles internally, and that broke
// the moment our layout put the editor inside a scroll container BlockNote
// didn't expect — we had no way to fix it short of restructuring around the
// library's assumptions. Here every floating control (selection toolbar,
// slash menu, drag handle) is positioned by us from plain viewport
// coordinates and rendered through a portal to <body>, so it can't be thrown
// off by an ancestor's scroll, transform, or overflow — regardless of how
// this component ends up nested in the future.
// ---------------------------------------------------------------------------

const SLASH_COMMANDS = [
  { title: "Text", kw: "text paragraph", ic: "¶", run: (e) => e.chain().focus().setParagraph().run() },
  { title: "Heading", kw: "heading h2 title section", ic: "H2", run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run() },
  { title: "Subheading", kw: "heading h3 subtitle", ic: "H3", run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run() },
  { title: "Bullet list", kw: "bullet list ul", ic: "•", run: (e) => e.chain().focus().toggleBulletList().run() },
  { title: "Numbered list", kw: "numbered ordered list", ic: "1.", run: (e) => e.chain().focus().toggleOrderedList().run() },
  { title: "Checklist", kw: "task checklist todo checkbox", ic: "☑", run: (e) => e.chain().focus().toggleTaskList().run() },
  { title: "Quote", kw: "quote blockquote", ic: "❝", run: (e) => e.chain().focus().toggleBlockquote().run() },
  { title: "Code block", kw: "code block", ic: "</>", run: (e) => e.chain().focus().toggleCodeBlock().run() },
  { title: "Divider", kw: "divider hr rule line", ic: "—", run: (e) => e.chain().focus().setHorizontalRule().run() },
  { title: "Image", kw: "image picture photo upload embed", ic: "🖼", run: (_e, helpers) => helpers?.openImagePicker() },
  { title: "Video", kw: "video movie clip film upload embed mp4", ic: "🎬", run: (_e, helpers) => helpers?.openVideoPicker() },
];

// depth 1 = the top-level block (paragraph/heading/list/etc.) directly under
// the document root — this is what a "block" means for drag/reorder purposes.
// A resolved position at the very start/end of the doc (or exactly on a
// top-level boundary) has depth 0 — there is no "before(1)" for it, and
// forcing depth to 1 anyway throws. Those spots simply have no block to
// offer a handle for.
function blockInfoAt(doc, pos) {
  const $pos = doc.resolve(pos);
  if ($pos.depth < 1) return null;
  const from = $pos.before(1);
  const node = doc.nodeAt(from);
  return node ? { node, from, to: from + node.nodeSize } : null;
}

function NoteEditor({
  content,
  onChange,
  accent = "#c2410d",
  placeholder = "Type “/” for commands, or just start writing…",
  className = "",
  wide = false,
  // Fill the container instead of holding a centred reading column. For the
  // editor used as a short field inside a panel (End of Campaign sections),
  // where the reading measure would centre a little text in a wide box.
  fill = false,
  // Smaller type and tighter rhythm, for an editor being read rather than
  // written in — a wall of 16px/1.7 body text is right for a page you are
  // composing and far too loose for a grid of short answers you are scanning.
  compact = false,
  // Read-only rendering: the note shows with all its formatting but can't be
  // typed into, and the editing chrome (bubble menu, slash menu, drag handles)
  // never appears. Used where a note belongs to someone else.
  editable = true,
  collab = null, // { doc, provider, seed } — see RichNoteEditor below
  collabUser = null, // { name, color } — identifies this editor to peers
}) {
  const [bubble, setBubble] = useState(null); // {top,left}
  const [slash, setSlash] = useState(null); // {top,left,query,index}
  const [dragHandle, setDragHandle] = useState(null); // {top,left,from,to}
  const [dropIndicator, setDropIndicator] = useState(null); // { top } in wrap coords
  const [colorPicker, setColorPicker] = useState(false);
  const saveTimerRef = useRef(null);
  const slashRangeRef = useRef(null);
  const dragFromRef = useRef(null);
  const wrapRef = useRef(null);
  const imageInputRef = useRef(null);
  const videoInputRef = useRef(null);
  // Has this editor ever displayed content in this session? Gates the
  // empty-save guard in onUpdate — see there.
  const sawContentRef = useRef(false);
  // The save the debounce hasn't fired yet, as a thunk. Unmount used to just
  // clearTimeout — silently discarding the last second-or-so of typing
  // whenever someone edited and immediately switched pages. Held as a thunk
  // rather than a value so the flush reads the document at unmount time, not
  // as it was when the timer was scheduled.
  const pendingSaveRef = useRef(null);
  // Latest onChange, so the unmount flush doesn't call a stale closure from
  // whatever render scheduled the timer.
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; });

  // All floating UI (bubble menu, slash menu, drag handle, drop indicator) is
  // position:fixed and rendered through a portal to <body>. It has to be a
  // real portal, not just absolutely positioned inside this editor's own
  // wrapper: a wrapper-relative element is a normal descendant of whatever
  // card holds this editor, so it's subject to that card's own stacking order
  // and `overflow: hidden` clipping — a sibling panel painting later (or the
  // card's own clipped bounds) can sit on top of or cut off a merely-absolute
  // bubble menu, which is exactly "goes below elements, invisible and
  // unclickable". Escaping to <body> with a high z-index guarantees it always
  // paints above the rest of the page, regardless of how this editor ends up
  // nested.
  //
  // The app applies `html { zoom: 1.1 }` globally (src/tailwind.css). Under a
  // non-1 CSS `zoom`, getBoundingClientRect()/coordsAtPos()/clientX/Y all
  // report already-zoomed VISUAL pixels, but an inline `style.top`/`left`
  // value is a LAYOUT length that the browser zooms AGAIN before painting —
  // and that applies equally whether the element is fixed-and-portaled or
  // absolute-in-place, since `zoom` scales the whole document including
  // portaled fixed children of <body>. So every raw viewport-pixel value
  // still needs dividing by the zoom factor before it's assigned as a style
  // value; only the portal (for stacking/clipping) is the new piece here.
  const zoomFactor = () => parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
  const toFixed = (v) => v / zoomFactor();

  const checkSlash = useCallback((editor) => {
    const { $from } = editor.state.selection;
    const textBefore = $from.parent.textBetween(0, $from.parentOffset, "￼", "￼");
    const match = textBefore.match(/\/([a-z0-9 ]*)$/i);
    if (match) {
      const query = match[1].trim().toLowerCase();
      const from = $from.pos - match[0].length;
      slashRangeRef.current = { from, to: $from.pos };
      const coords = editor.view.coordsAtPos(from);
      setSlash({ top: toFixed(coords.bottom), left: toFixed(coords.left), query, index: 0 });
    } else {
      slashRangeRef.current = null;
      setSlash(null);
    }
  }, []);

  const updateBubble = useCallback((editor) => {
    const { from, to, empty } = editor.state.selection;
    if (empty) { setBubble(null); setColorPicker(false); return; }
    const start = editor.view.coordsAtPos(from);
    const end = editor.view.coordsAtPos(to);
    setBubble({ top: toFixed(Math.min(start.top, end.top)), left: toFixed((start.left + end.left) / 2) });
  }, []);

  const editor = useEditor({
    editable,
    extensions: [
      // StarterKit v3 already bundles Underline and Link — configure Link here
      // rather than re-adding the extensions (which triggers duplicate-name
      // errors). Underline/Link commands (toggleUnderline, setLink) still work.
      StarterKit.configure({
        heading: { levels: [2, 3] },
        link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" } },
        // Yjs owns undo/redo when collaborating: StarterKit's history is
        // per-editor, so leaving it on would let one person's ctrl-Z revert a
        // colleague's edit. Collaboration ships a history that only undoes
        // your own changes.
        ...(collab ? { undoRedo: false } : {}),
      }),
      Placeholder.configure({ placeholder }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TextStyle,
      Color,
      ResizableImage.configure({ inline: false }),
      Video,
      ...(collab
        ? [
            Collaboration.configure({ document: collab.doc }),
            // `user` is not optional in practice: the extension unconditionally
            // does setLocalStateField("user", options.user) when its plugin
            // mounts, so omitting it overwrites the identity the provider set
            // with {name: null, color: null}. y-prosemirror then invents a
            // fallback — an orange caret labelled "User: <clientId>" — which is
            // what shipped instead of anyone's actual name.
            CollaborationCaret.configure({
              provider: collab.provider,
              user: collabUser,
            }),
          ]
        : []),
    ],
    // Never hand `content` to a collaborative editor. Collaboration builds the
    // document from the Y.Doc and ignores this option entirely — passing a
    // note's JSON here looked like seeding but did nothing, so the editor came
    // up empty and the autosave below wrote that emptiness over the real note.
    // That destroyed one. Seeding now happens in onCreate, against the actual
    // editor, where the result can be observed.
    content: collab
      ? undefined
      : (content && (Array.isArray(content) ? content.length : Object.keys(content).length) ? content : ""),
    onCreate: ({ editor }) => {
      // Seeding a virgin doc from its JSON happens in the deferred,
      // race-guarded effect below, not here — see it for why. This only
      // records the save-guard baseline: an editor that has shown content may
      // later legitimately be emptied by its author, but one that never did
      // must not be persisted. This runs for BOTH paths — a non-collab editor
      // is populated from the `content` option at construction, and skipping
      // it here meant the guard in onUpdate misread a legitimate
      // select-all-delete (as the session's first edit) as a failed load and
      // silently refused the save.
      if (!editor.isEmpty) sawContentRef.current = true;
    },
    editorProps: {
      handleKeyDown(view, event) {
        if (!slashRangeRef.current) return false;
        if (event.key === "ArrowDown") { setSlash((s) => (s ? { ...s, index: s.index + 1 } : s)); event.preventDefault(); return true; }
        if (event.key === "ArrowUp") { setSlash((s) => (s ? { ...s, index: s.index - 1 } : s)); event.preventDefault(); return true; }
        if (event.key === "Enter" || event.key === "Escape") { event.preventDefault(); return true; }
        return false;
      },
      handlePaste(view, event) {
        const files = Array.from(event.clipboardData?.files || []).filter(isMediaFile);
        if (!files.length) return false;
        event.preventDefault();
        files.forEach((file) => insertUploadedMedia(view, file));
        return true;
      },
      handleDrop(view, event) {
        const files = Array.from(event.dataTransfer?.files || []).filter(isMediaFile);
        if (!files.length) return false;
        event.preventDefault();
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.from;
        files.forEach((file) => insertUploadedMedia(view, file, pos));
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      checkSlash(editor);

      if (!editor.isEmpty) sawContentRef.current = true;

      // The guard that should have existed before any of this shipped. An
      // author emptying their own note is legitimate — but they must have seen
      // the note's contents first. An editor that has never once been
      // non-empty, for a note the database says has text, means loading or
      // seeding failed, and persisting that would destroy the note. It already
      // did once. Refusing the write costs a stale projection until the next
      // real edit; allowing it costs the note.
      if (editor.isEmpty && !sawContentRef.current && hasContent(content)) {
        console.error(
          "[RichNoteEditor] refusing to save an empty document over a note that has content — " +
          "the note failed to load rather than being emptied by its author."
        );
        reportError(new Error("Blocked empty-document save over non-empty note"), {
          collab: !!collab,
          seeded: collab?.seed,
        });
        return;
      }

      clearTimeout(saveTimerRef.current);
      // Collaborating peers all hold the same converged document, so whoever
      // stops typing first writes it — last-write-wins is safe here precisely
      // because a CRDT can't diverge. A slightly longer debounce keeps the
      // duplicate writes down without risking data (peers still have it).
      //
      // A non-collab save passes ydoc: null — not undefined — on purpose: it
      // must INVALIDATE any stored CRDT state, because that state no longer
      // describes this content. Leaving it in place set a trap: edit a note
      // with collaboration off, re-enable collaboration later, and the editor
      // would load the stale ydoc (which parses fine, so no re-seed), show the
      // old text, and persist the revert on the next keystroke. Nulling it
      // means the next collaborative open re-seeds from the JSON, which is the
      // newest truth.
      const payload = () => [
        editor.getJSON(),
        collab ? encodeYState(collab.doc) : null,
      ];
      pendingSaveRef.current = payload;
      saveTimerRef.current = setTimeout(() => {
        pendingSaveRef.current = null;
        // Optional: a read-only editor has no onChange, and a programmatic
        // content change shouldn't throw its way out of a timer.
        onChangeRef.current?.(...payload());
      }, collab ? 1500 : 800);
    },
    onSelectionUpdate: ({ editor }) => { checkSlash(editor); updateBubble(editor); },
    onBlur: () => { setTimeout(() => { setBubble(null); setSlash(null); slashRangeRef.current = null; setColorPicker(false); }, 150); },
  }, []);

  // Deferred seeding for a note with JSON content but no CRDT state. Seeding
  // immediately in onCreate raced other clients: everyone whose page list
  // predated the first collaborative save believed the note was virgin, seeded
  // its own copy, and Yjs faithfully merged them — the note's body, twice.
  // (Reproduced on the live UI, not hypothesised.) Three defences, outermost
  // first: the wrapper below refetches the authoritative ydoc at mount, so a
  // stale page list can't manufacture a seeder; this effect then waits out a
  // grace period, during which a real peer's state arriving makes the doc
  // non-empty and cancels seeding; and if peers are present but the doc is
  // still empty — genuinely simultaneous first opens — only the lowest client
  // id seeds, so there is exactly one seeder by construction. The empty-save
  // guard holds throughout the wait, so nothing can persist the interim blank.
  useEffect(() => {
    if (!editor || !collab?.seed || !hasContent(content)) return;
    const t = setTimeout(() => {
      if (editor.isDestroyed) return;
      if (!editor.isEmpty) { sawContentRef.current = true; return; } // a peer's state arrived
      const aw = collab.provider.awareness;
      const others = [...aw.getStates().keys()].filter((id) => id !== aw.clientID);
      if (others.some((id) => id < aw.clientID)) return; // that peer seeds; its update reaches us
      editor.commands.setContent(content);
      sawContentRef.current = true;
    }, 900);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, collab]);

  // Flush, don't discard: if a save is still waiting out its debounce when
  // this editor unmounts (page switch, board switch), fire it now. This
  // cleanup runs before useEditor's own destroy (effects clean up in reverse
  // mount order), so the editor is still readable.
  useEffect(() => () => {
    clearTimeout(saveTimerRef.current);
    if (pendingSaveRef.current) {
      const payload = pendingSaveRef.current;
      pendingSaveRef.current = null;
      try { onChangeRef.current?.(...payload()); } catch { /* editor already gone — nothing to flush */ }
    }
  }, []);

  // Slash menu: run/close on Enter/Escape (handleKeyDown above only stops the
  // default editor behavior; the actual action happens here where component
  // state — the filtered list + selected index — is in scope).
  useEffect(() => {
    if (!slash) return;
    const filtered = SLASH_COMMANDS.filter((c) => !slash.query || c.kw.includes(slash.query));
    const onKey = (e) => {
      if (e.key === "Enter") {
        const cmd = filtered[((slash.index % filtered.length) + filtered.length) % filtered.length];
        if (cmd && slashRangeRef.current) {
          const { from, to } = slashRangeRef.current;
          editor.chain().focus().deleteRange({ from, to }).run();
          cmd.run(editor);
        }
        slashRangeRef.current = null;
        setSlash(null);
      } else if (e.key === "Escape") {
        slashRangeRef.current = null;
        setSlash(null);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [slash, editor]);

  // --- Drag handle: track the hovered top-level block, offer a handle,
  // reorder via a delete+insert transaction on drop.
  //
  // Every early-return below explicitly clears dragHandle rather than
  // leaving it as-is. The previous version returned early on a miss without
  // clearing state, so the moment the mouse crossed ANY position that didn't
  // resolve cleanly (a margin, a gap between blocks, a doc-boundary position
  // that made blockInfoAt throw) the handle was left showing wherever it
  // last successfully computed — visibly stuck on some earlier row instead
  // of tracking the cursor. */
  const handleMouseMove = useCallback((e) => {
    // While a drag is in flight, leave the handle anchored on the block that
    // was actually picked up. Native mousemove keeps firing on the wrapper
    // for the same pointer movement the document-level drag listeners are
    // tracking, so without this guard the handle icon re-targets to whatever
    // row is currently under the cursor — and since it has an opaque
    // background, once it lands on the same row the drop-indicator line is
    // drawn on, it paints right over that thin line, making the indicator
    // look like it vanished rather than just being covered.
    if (dragFromRef.current) return;
    if (!editor || slash) { setDragHandle(null); return; }
    const wrap = wrapRef.current;
    const pmDom = editor.view.dom;
    if (!wrap || !pmDom) { setDragHandle(null); return; }
    const wrapRect = wrap.getBoundingClientRect();
    // Match by row (Y) across the whole wrapper width, not by exact hit on the
    // text glyphs — requiring the cursor to land squarely on a paragraph made
    // the handle only appear a "few digits in", and the gutter itself (where
    // the handle actually sits) was dead space. Any X within the wrapper now
    // counts, so moving straight at the handle keeps the row's hover alive.
    if (e.clientX < wrapRect.left || e.clientX > wrapRect.right) { setDragHandle(null); return; }
    try {
      let match = null;
      for (const child of pmDom.children) {
        const r = child.getBoundingClientRect();
        if (r.height > 0 && e.clientY >= r.top && e.clientY <= r.bottom) { match = { el: child, rect: r }; break; }
      }
      if (!match) { setDragHandle(null); return; }
      const info = blockInfoAt(editor.state.doc, editor.view.posAtDOM(match.el, 0));
      if (!info) { setDragHandle(null); return; }
      // Position/size the handle strip to match the row's own top+height
      // exactly, at the wrapper's left edge (fixed-positioned now, so that
      // edge must be measured explicitly rather than implied by nesting).
      // top/left/height all go through the same zoom correction — a raw
      // viewport-pixel value fed straight into style.top/left/height gets
      // zoomed a second time by the browser otherwise.
      setDragHandle({
        top: toFixed(match.rect.top),
        left: toFixed(wrapRect.left),
        height: toFixed(match.rect.height),
        from: info.from, to: info.to,
      });
    } catch {
      setDragHandle(null);
    }
  }, [editor, slash]);

  // Pointer-based block reorder. Native HTML5 drag over a ProseMirror editable
  // is swallowed by PM's own drop handling and never reorders; a manual pointer
  // drag is reliable and lets us draw a clear insertion line.
  //
  // Row-matched by Y across the whole wrapper width — same approach as the
  // hover handler above, and for the same reason: `document.elementFromPoint`
  // only resolves to real editor content, but the gutter column the handle
  // itself lives in (deliberately outside the text's centered, max-width
  // content box, so the handle doesn't crowd the prose) has nothing under it
  // to hit. That made dragging straight down through the gutter — the
  // natural way to drag a handle — never find a drop target; only straying
  // over the actual paragraph text resolved anything.
  const blockUnderPointer = useCallback((clientX, clientY) => {
    const wrap = wrapRef.current;
    const pmDom = editor.view.dom;
    if (!wrap || !pmDom) return null;
    const wrapRect = wrap.getBoundingClientRect();
    if (clientX < wrapRect.left || clientX > wrapRect.right) return null;
    let match = null;
    for (const child of pmDom.children) {
      const r = child.getBoundingClientRect();
      if (r.height > 0 && clientY >= r.top && clientY <= r.bottom) { match = { el: child, rect: r }; break; }
    }
    if (!match) return null;
    const info = blockInfoAt(editor.state.doc, editor.view.posAtDOM(match.el, 0));
    if (!info) return null;
    return { info, rect: match.rect, after: clientY > match.rect.top + match.rect.height / 2 };
  }, [editor]);

  const onDragPointerMove = useCallback((e) => {
    const t = blockUnderPointer(e.clientX, e.clientY);
    const wrap = wrapRef.current;
    if (!t || !wrap) { setDropIndicator(null); return; }
    const wrapRect = wrap.getBoundingClientRect();
    setDropIndicator({
      top: toFixed(t.after ? t.rect.bottom : t.rect.top),
      left: toFixed(wrapRect.left) + 20,
      width: toFixed(wrapRect.width) - 40,
    });
  }, [blockUnderPointer]);

  const onDragPointerUp = useCallback((e) => {
    document.removeEventListener("pointermove", onDragPointerMove);
    document.removeEventListener("pointerup", onDragPointerUp);
    document.body.style.userSelect = "";
    const src = dragFromRef.current;
    dragFromRef.current = null;
    setDropIndicator(null);
    setDragHandle(null);
    if (!src) return;
    const t = blockUnderPointer(e.clientX, e.clientY);
    if (!t) return;
    const { from, to } = src;
    let insertAt = t.after ? t.info.to : t.info.from;
    if (insertAt >= from && insertAt <= to) return; // dropped within itself
    const slice = editor.state.doc.slice(from, to);
    editor.chain().command(({ tr }) => {
      tr.delete(from, to);
      if (insertAt > from) insertAt -= (to - from);
      tr.insert(insertAt, slice.content);
      return true;
    }).run();
  }, [editor, blockUnderPointer, onDragPointerMove]);

  const startDrag = useCallback((e) => {
    if (!dragHandle) return;
    e.preventDefault();
    dragFromRef.current = { from: dragHandle.from, to: dragHandle.to };
    document.body.style.userSelect = "none";
    document.addEventListener("pointermove", onDragPointerMove);
    document.addEventListener("pointerup", onDragPointerUp);
  }, [dragHandle, onDragPointerMove, onDragPointerUp]);

  // Clear the hover handle when the editor scrolls or resizes (e.g. entering
  // full-width expand) so it never sticks at a stale spot.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const clear = () => { setDragHandle(null); setDropIndicator(null); };
    wrap.addEventListener("scroll", clear);
    const ro = new ResizeObserver(clear);
    ro.observe(wrap);
    return () => { wrap.removeEventListener("scroll", clear); ro.disconnect(); };
  }, []);

  if (!editor) return null;

  const filteredSlash = slash
    ? SLASH_COMMANDS.filter((c) => !slash.query || c.kw.includes(slash.query))
    : [];
  const slashIndex = filteredSlash.length ? ((slash.index % filteredSlash.length) + filteredSlash.length) % filteredSlash.length : 0;

  const runSlash = (cmd) => {
    if (!slashRangeRef.current) return;
    const { from, to } = slashRangeRef.current;
    editor.chain().focus().deleteRange({ from, to }).run();
    cmd.run(editor, {
      openImagePicker: () => imageInputRef.current?.click(),
      openVideoPicker: () => videoInputRef.current?.click(),
    });
    slashRangeRef.current = null;
    setSlash(null);
  };

  const onImageFileChosen = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const url = await uploadNoteMedia(file);
    if (url) editor.chain().focus().setImage({ src: url }).run();
  };

  const onVideoFileChosen = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const warning = videoPlayabilityWarning(file);
    if (warning && !window.confirm(`${warning}\n\nUpload anyway?`)) return;
    const url = await uploadNoteMedia(file);
    if (url) editor.chain().focus().setVideo({ src: url }).run();
  };

  // Right-click anywhere on a block's row opens the slash menu for that
  // block, without requiring the user to type "/". This reuses
  // blockUnderPointer's row-matched (Y-only, full wrapper width) hit test
  // rather than requiring the right-click to land on the 34px drag-handle
  // button itself — an earlier version tied this to the handle directly,
  // which only actually has a rendered hitbox exactly where the hover state
  // last put it, making right-clicks a couple pixels off (or with no
  // recent hover) fall through to the browser's native context menu
  // instead. Matching on the whole row removes that precision requirement.
  // A zero-length slashRangeRef makes runSlash's deleteRange({from, to}) a
  // no-op, so it behaves exactly like invoking the menu by typing, just
  // without anything to delete.
  const onEditorContextMenu = useCallback((e) => {
    if (!editor) return;
    const t = blockUnderPointer(e.clientX, e.clientY);
    if (!t) return; // outside any block — let the native menu show
    e.preventDefault();
    const pos = Math.min(t.info.from + 1, t.info.to);
    editor.chain().focus().setTextSelection(pos).run();
    const coords = editor.view.coordsAtPos(pos);
    slashRangeRef.current = { from: pos, to: pos };
    setSlash({ top: toFixed(coords.bottom), left: toFixed(coords.left), query: "", index: 0 });
  }, [editor, blockUnderPointer]);

  return (
    <div
      ref={wrapRef}
      className={`rne-root ${fill ? "rne-fill" : ""} ${compact ? "rne-compact" : ""} ${className}`}
      style={{
        "--rne-accent": accent,
        // `fill` hands the width back to the container. The measure exists for
        // a full-page note, where a 46rem column is the readable line length —
        // but the editor is also used as a short field inside a panel, and
        // there a centred 46rem column inside a wider box just pushes the text
        // into the middle with nothing beside it.
        "--rne-measure": fill ? "100%" : wide ? "62rem" : "46rem",
        position: "relative",
      }}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => { if (!dragFromRef.current) setDragHandle(null); }}
      onContextMenu={onEditorContextMenu}
    >
      <style>{`
        .rne-root .ProseMirror { outline: none; font-size: 16px; line-height: 1.7; color: var(--rne-fg); max-width: var(--rne-measure, 46rem); margin-inline: auto; padding: 4px 14px 48px; transition: max-width 0.2s ease; }
        @media (min-width: 640px) { .rne-root .ProseMirror { padding: 4px 22px 48px; } }
        /* A field, not a page: flush left, and without the 48px of trailing
           click-target space that a full-page note wants at its foot — in a
           short field that reads as a gap rather than as room to write. */
        .rne-root.rne-fill .ProseMirror { margin-inline: 0; padding: 4px 14px 10px; }
        @media (min-width: 640px) { .rne-root.rne-fill .ProseMirror { padding: 4px 16px 10px; } }
        /* Reading size. Every length here scales together — type, leading and
           the gaps between blocks — because shrinking the font alone leaves
           paragraph margins sized for the old one and the text ends up small
           and still sparse. */
        .rne-root.rne-compact .ProseMirror { font-size: 13px; line-height: 1.5; padding: 2px 14px 4px; }
        @media (min-width: 640px) { .rne-root.rne-compact .ProseMirror { padding: 2px 16px 4px; } }
        .rne-root.rne-compact p { margin: 0 0 5px; }
        .rne-root.rne-compact h2 { font-size: 1.05rem; margin: 0 0 5px; }
        .rne-root.rne-compact h3 { font-size: 0.95rem; margin: 8px 0 4px; }
        .rne-root.rne-compact ul, .rne-root.rne-compact ol { padding-left: 17px; margin: 0 0 5px; }
        .rne-root.rne-compact li { margin: 0 0 2px; }
        .rne-root h2 { font-size: 1.55rem; font-weight: 750; letter-spacing: -0.01em; margin: 0 0 10px; }
        .rne-root h3 { font-size: 1.28rem; font-weight: 750; letter-spacing: -0.01em; margin: 18px 0 8px; }
        .rne-root p { margin: 0 0 12px; }
        .rne-root .ProseMirror p.is-editor-empty:first-child::before { content: attr(data-placeholder); float: left; color: var(--rne-faint); pointer-events: none; height: 0; }
        .rne-root ul, .rne-root ol { padding-left: 22px; margin: 0 0 12px; }
        .rne-root ul { list-style: disc outside; }
        .rne-root ol { list-style: decimal outside; }
        .rne-root li { margin-bottom: 5px; }
        .rne-root li::marker { color: var(--rne-muted); }
        .rne-root blockquote { border-left: 3px solid var(--rne-accent); margin: 0 0 12px; padding: 2px 0 2px 14px; color: var(--rne-muted); font-style: italic; }
        .rne-root pre { background: var(--rne-code-bg); color: var(--rne-code-fg); border-radius: 10px; padding: 12px 14px; overflow-x: auto; margin: 0 0 12px; font-size: 13px; }
        .rne-root code { background: color-mix(in srgb, var(--rne-accent) 10%, transparent); color: var(--rne-accent); border-radius: 4px; padding: 1px 5px; font-size: 13px; font-family: ui-monospace, monospace; }
        .rne-root pre code { background: none; color: inherit; padding: 0; }
        .rne-root ul[data-type="taskList"] { list-style: none; padding-left: 2px; }
        .rne-root ul[data-type="taskList"] li { display: flex; align-items: flex-start; gap: 8px; }
        .rne-root ul[data-type="taskList"] li > label { margin-top: 3px; }
        .rne-root ul[data-type="taskList"] input[type="checkbox"] { width: 15px; height: 15px; accent-color: var(--rne-accent); cursor: pointer; }
        .rne-root hr { border: none; border-top: 1px solid var(--rne-rule); margin: 18px 0; }
        /* Media flows inline-block rather than as its own block row, which is
           what lets two half-width or three third-width items sit side by
           side and wrap onto the next line on their own when the pane is too
           narrow — no grid, no wrapper node, just normal inline flow. */
        .rne-root .rne-media { display: inline-block; position: relative; vertical-align: top; max-width: 100%; line-height: 0; margin: 4px 8px 14px 0; }
        .rne-root .rne-media > img, .rne-root .rne-media > video { width: 100%; height: auto; display: block; border-radius: 10px; }
        .rne-root .rne-media[data-intrinsic] > img { width: auto; max-width: 100%; }
        .rne-root img.rne-img { cursor: pointer; }
        .rne-root video.rne-video { background: #000; }
        /* Below the phone breakpoint a half or a third is unreadable, so every
           item takes the full column regardless of the width it was given. */
        @media (max-width: 640px) { .rne-root .rne-media { width: 100% !important; margin-right: 0; } }
        /* Collaborator carets. The name hangs BELOW the cursor and stays put —
           above-on-hover meant you had to go find a cursor and hover it to learn
           who was typing. Below-and-always keeps the name attached to the
           playhead where you're already looking, and the pill's pointed
           top-left corner reads as dangling from the caret. */
        .rne-root .collaboration-carets__caret { position: relative; border-left: 1px solid; border-right: 1px solid; margin-left: -1px; margin-right: -1px; pointer-events: none; word-break: normal; }
        .rne-root .collaboration-carets__label { position: absolute; top: 100%; left: -1px; margin-top: 1px; font-size: 10.5px; font-weight: 700; line-height: 1; white-space: nowrap; border-radius: 0 4px 4px 4px; padding: 2px 5px; color: #fff; pointer-events: none; user-select: none; box-shadow: 0 1px 3px rgba(0,0,0,0.15); z-index: 20; }
        .rne-root a { color: var(--rne-accent); text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
        .rne-root .ProseMirror { caret-color: var(--rne-accent); }
        .rne-root .rne-drag-handle-icon {
          width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;
          background: var(--rne-surface); border: 1px solid var(--rne-rule); color: var(--rne-muted); border-radius: 7px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.08); transition: color 0.12s, border-color 0.12s;
        }
        .rne-root .rne-drag-handle:hover .rne-drag-handle-icon,
        .rne-root .rne-drag-handle:active .rne-drag-handle-icon {
          color: var(--rne-accent); border-color: color-mix(in srgb, var(--rne-accent) 40%, var(--rne-rule));
        }
      `}</style>
      <EditorContent editor={editor} />

      <input ref={imageInputRef} type="file" accept="image/*" onChange={onImageFileChosen} style={{ display: "none" }} />
      <input ref={videoInputRef} type="file" accept="video/*" onChange={onVideoFileChosen} style={{ display: "none" }} />

      {dropIndicator && createPortal(
        <div
          style={{
            position: "fixed", left: dropIndicator.left, width: dropIndicator.width, top: dropIndicator.top - 1, height: 2,
            background: "var(--rne-accent)", borderRadius: 2, zIndex: 139, pointerEvents: "none",
            boxShadow: "0 0 0 2px color-mix(in srgb, var(--rne-accent) 20%, transparent)",
          }}
        />,
        document.body
      )}

      {editable && dragHandle && createPortal(
        // The whole gutter column for this row is the drag target — not just
        // the visible icon — so starting a drag doesn't require pinpointing a
        // 26px square. The icon is centered inside via flex, so it always
        // lines up with the row regardless of the block's own height
        // (heading vs paragraph vs checklist item).
        <button
          className="rne-drag-handle"
          onPointerDown={startDrag}
          title="Drag to move · Right-click for the block menu"
          style={{
            position: "fixed", top: dragHandle.top, left: dragHandle.left, width: 34, height: dragHandle.height,
            display: "flex", alignItems: "center", justifyContent: "center", cursor: "grab", touchAction: "none",
            background: "transparent", border: "none", padding: 0, zIndex: 140,
          }}
        >
          <span className="rne-drag-handle-icon">
            <GripVertical size={15} />
          </span>
        </button>,
        document.body
      )}

      {editable && bubble && createPortal(
        <div
          style={{
            position: "fixed", top: bubble.top, left: bubble.left, transform: "translate(-50%, calc(-100% - 8px))",
            display: "flex", alignItems: "center", gap: 2, background: "var(--rne-surface)", border: "1px solid var(--rne-rule)",
            borderRadius: 11, boxShadow: "0 10px 28px -12px rgba(0,0,0,0.25)", padding: 5, zIndex: 150,
          }}
        >
          {[
            { Icon: BoldIcon, active: () => editor.isActive("bold"), run: () => editor.chain().focus().toggleBold().run(), title: "Bold" },
            { Icon: ItalicIcon, active: () => editor.isActive("italic"), run: () => editor.chain().focus().toggleItalic().run(), title: "Italic" },
            { Icon: UnderlineIcon, active: () => editor.isActive("underline"), run: () => editor.chain().focus().toggleUnderline().run(), title: "Underline" },
            { Icon: Strikethrough, active: () => editor.isActive("strike"), run: () => editor.chain().focus().toggleStrike().run(), title: "Strikethrough" },
            { Icon: LinkIcon, active: () => editor.isActive("link"), run: () => {
                if (editor.isActive("link")) { editor.chain().focus().unsetLink().run(); return; }
                const prev = editor.getAttributes("link").href || "https://";
                const url = window.prompt("Link URL", prev);
                if (url === null) return;
                if (url === "") { editor.chain().focus().unsetLink().run(); return; }
                editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
              }, title: "Link" },
            { Icon: Code2, active: () => editor.isActive("code"), run: () => editor.chain().focus().toggleCode().run(), title: "Inline code" },
            { Icon: Palette, active: () => colorPicker || !!editor.getAttributes("textStyle").color, run: () => setColorPicker((v) => !v), title: "Text color" },
            null, // separator
            { Icon: Heading2, active: () => editor.isActive("heading", { level: 2 }), run: () => editor.chain().focus().toggleHeading({ level: 2 }).run(), title: "Heading" },
            { Icon: Heading3, active: () => editor.isActive("heading", { level: 3 }), run: () => editor.chain().focus().toggleHeading({ level: 3 }).run(), title: "Subheading" },
            { Icon: List, active: () => editor.isActive("bulletList"), run: () => editor.chain().focus().toggleBulletList().run(), title: "Bullet list" },
            { Icon: ListOrdered, active: () => editor.isActive("orderedList"), run: () => editor.chain().focus().toggleOrderedList().run(), title: "Numbered list" },
            { Icon: ListChecks, active: () => editor.isActive("taskList"), run: () => editor.chain().focus().toggleTaskList().run(), title: "Checklist" },
            { Icon: Quote, active: () => editor.isActive("blockquote"), run: () => editor.chain().focus().toggleBlockquote().run(), title: "Quote" },
          ].map((item, i) =>
            item === null ? (
              <span key={`sep-${i}`} style={{ width: 1, height: 18, background: "var(--rne-rule)", margin: "0 3px" }} />
            ) : (
              <button
                key={item.title}
                title={item.title}
                onMouseDown={(e) => e.preventDefault()}
                onClick={item.run}
                style={{
                  width: 28, height: 28, border: "none", borderRadius: 7, cursor: "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: item.active() ? "var(--rne-accent, #c2410d)" : "transparent",
                  color: item.active() ? "#fff" : "var(--rne-muted)",
                }}
              >
                <item.Icon size={15} />
              </button>
            )
          )}

          {colorPicker && (
            <div
              onMouseDown={(e) => e.preventDefault()}
              style={{
                position: "absolute", top: "calc(100% + 6px)", left: 0, display: "flex", flexWrap: "wrap", gap: 6,
                background: "var(--rne-surface)", border: "1px solid var(--rne-rule)", borderRadius: 10,
                boxShadow: "0 10px 28px -12px rgba(0,0,0,0.25)", padding: 8, width: 172,
              }}
            >
              {TEXT_COLORS.map((c) => (
                <button
                  key={c.label}
                  title={c.label}
                  onClick={() => {
                    if (c.value) editor.chain().focus().setColor(c.value).run();
                    else editor.chain().focus().unsetColor().run();
                    setColorPicker(false);
                  }}
                  style={{
                    width: 22, height: 22, borderRadius: "50%", cursor: "pointer",
                    background: c.value || "#fff",
                    border: c.value ? "1px solid rgba(0,0,0,0.08)" : "1px dashed var(--rne-faint)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                >
                  {!c.value && <span style={{ fontSize: 9, color: "var(--rne-muted)" }}>×</span>}
                </button>
              ))}
            </div>
          )}
        </div>,
        document.body
      )}

      {editable && slash && createPortal(
        <div
          style={{
            position: "fixed", top: slash.top, left: slash.left, width: 210, background: "var(--rne-surface)",
            border: "1px solid var(--rne-rule)", borderRadius: 11, boxShadow: "0 10px 28px -12px rgba(0,0,0,0.25)",
            padding: 6, zIndex: 150, display: "flex", flexDirection: "column", marginTop: 8,
          }}
        >
          {filteredSlash.length === 0 && (
            <div style={{ padding: "8px 9px", fontSize: 12.5, color: "var(--rne-faint)" }}>No matching block</div>
          )}
          {filteredSlash.map((c, i) => (
            <div
              key={c.title}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => runSlash(c)}
              style={{
                display: "flex", alignItems: "center", gap: 10, padding: "7px 9px", borderRadius: 8, cursor: "pointer",
                fontSize: 13, fontWeight: 600, background: i === slashIndex ? "color-mix(in srgb, var(--rne-accent) 10%, transparent)" : "transparent",
              }}
            >
              <span style={{
                width: 22, height: 22, borderRadius: 6, background: "color-mix(in srgb, var(--rne-accent) 10%, transparent)",
                color: "var(--rne-accent)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800, flexShrink: 0,
              }}>{c.ic}</span>
              {c.title}
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// RichNoteEditor — the exported entry point.
//
// Without collabRoom this is just NoteEditor, unchanged. With it, the Y.Doc
// and its provider have to exist *before* the editor is constructed, since
// TipTap takes the document when it builds the Collaboration extension and
// can't be handed one later. So this gates rendering until both are ready
// rather than trying to attach them after mount.
// ---------------------------------------------------------------------------
export default function RichNoteEditor(props) {
  const { collabRoom } = props;
  if (!collabRoom) return <NoteEditor {...props} />;
  return <CollaborativeNoteEditor {...props} />;
}

function CollaborativeNoteEditor(props) {
  const { collabRoom, ydoc, collabUser, onCollabReady, fetchLatestYdoc } = props;
  const [collab, setCollab] = useState(null);

  // Held in refs so a caller passing inline callbacks can't retrigger the
  // effect below — which is keyed on the room alone, on purpose (see there).
  const onReadyRef = useRef(onCollabReady);
  const fetchYdocRef = useRef(fetchLatestYdoc);
  useEffect(() => { onReadyRef.current = onCollabReady; fetchYdocRef.current = fetchLatestYdoc; });

  useEffect(() => {
    let cancelled = false;
    let provider = null;
    let doc = null;

    (async () => {
      // The prop's ydoc is a snapshot from whenever the page list was fetched
      // — possibly hours ago. Trusting it manufactured phantom seeders: a tab
      // whose list predated the note's first collaborative save still saw
      // "no CRDT state", seeded its own copy on open, and the merge doubled
      // the note. One cheap authoritative read at mount closes that entirely;
      // the stale prop remains only as the fallback if the read fails.
      let latestYdoc = ydoc;
      if (fetchYdocRef.current) {
        try {
          latestYdoc = await fetchYdocRef.current();
        } catch {
          /* offline or DB down — the prop is the best we have */
        }
      }
      if (cancelled) return;

      doc = new Y.Doc();
      // `seed` marks a doc with no usable CRDT state, whose old plain-JSON
      // form may need converting (deferred seeding effect in NoteEditor).
      // Once state exists, the JSON is a stale projection and applying it
      // would duplicate the note's contents.
      let seed = true;
      if (latestYdoc) {
        try {
          Y.applyUpdate(doc, decodeYState(latestYdoc));
          seed = false;
        } catch {
          seed = true; // unreadable state — fall back to the JSON projection
        }
      }
      provider = createSupabaseYProvider({ doc, room: collabRoom, user: collabUser });
      setCollab({ doc, provider, seed });
      // Hand the provider up so a caller can render presence off its
      // awareness. Awareness has to be read from outside the editor: the
      // "who's here" chip lives in the note's doc-head, this component's
      // sibling.
      onReadyRef.current?.(provider);
    })();

    return () => {
      cancelled = true;
      onReadyRef.current?.(null);
      provider?.destroy();
      doc?.destroy();
      setCollab(null);
    };
    // Deliberately keyed on the room alone. `ydoc` is the state we loaded
    // from the database and is rewritten by our own saves, and `collabUser` is
    // an object literal from the caller — including either would tear down the
    // document and its channel on every save or re-render, dropping the live
    // session repeatedly. Both are only ever needed at mount, and the caller
    // remounts this component per page (key={page.id}), so the room changing
    // and this component remounting are the same event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collabRoom]);

  if (!collab) return <div className={props.className} />;
  return <NoteEditor {...props} collab={collab} />;
}
