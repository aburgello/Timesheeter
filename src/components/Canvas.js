import React, { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { supabase } from "../lib/supabaseClient";
import { toggleDarkMode } from "../lib/theme";
import { useColumnResize } from "../lib/useColumnResize";
import { getFilmName, PRINT_HUB_RE } from "../lib/wrikeEnrich";
import { fetchTasksByIds } from "../hooks/useWrikeCache";
import RichNoteEditor from "./shared/RichNoteEditor";
import PresenceStack from "./shared/PresenceStack";
// Lazy — Excalidraw is a sizeable bundle + its own CSS; only a sketch page
// being opened should pay for it, not every Notes Canvas visit.
const ExcalidrawPageEditor = lazy(() => import("./shared/ExcalidrawPageEditor"));
import PageHeader, { pageHeaderActionClass } from "./shared/PageHeader";
import HubRow from "./shared/HubRow";
import { useDepartment } from "../hooks/useDepartment";
import { boardLabelFor } from "../lib/departments";
import { PAGE_GRADIENTS } from "../lib/pageGradients";
import { reportError } from "../lib/monitoring";
import { FILM_MAPPINGS } from "../constants.js";
import { docToPlainText, docHasText } from "../utils/tiptapText";
import {
  Layout,
  Sparkles,
  X,
  ExternalLink,
  Plus,
  FileText,
  Film,
  Edit2,
  Trash2,
  Check,
  Link2,
  Copy,
  Folder,
  ImagePlus,
  Bold,
  Italic,
  Search,
  Command,
  Zap,
  Moon,
  Pin,
  Globe,
  Upload,
  AlertTriangle,
  ChevronLeft,
  Loader2,
  Image as ImageIcon,
  FolderPlus,
  ChevronRight,
  Download,
  Star,
  LayoutGrid,
  List,
  RefreshCw,
  Users,
  Share2,
  User,
  Maximize2,
  Minimize2,
  Printer,
  PenTool,
} from "lucide-react";

// --- DOOH country → region grouping ---
const COUNTRY_REGION = {
  // Europe
  Austria: "Europe", Denmark: "Europe", Finland: "Europe", France: "Europe",
  Germany: "Europe", Ireland: "Europe", Italy: "Europe", Norway: "Europe",
  Poland: "Europe", Portugal: "Europe", Slovenia: "Europe", Spain: "Europe",
  Sweden: "Europe", Turkey: "Europe", UK: "Europe", Ukraine: "Europe",
  // Asia-Pacific
  Australia: "Asia-Pacific", China: "Asia-Pacific", "Hong Kong": "Asia-Pacific",
  India: "Asia-Pacific", Indonesia: "Asia-Pacific", Japan: "Asia-Pacific",
  Kazakhstan: "Asia-Pacific", Korea: "Asia-Pacific", Kyrgyzstan: "Asia-Pacific",
  Malaysia: "Asia-Pacific", Philippines: "Asia-Pacific", Singapore: "Asia-Pacific",
  Taiwan: "Asia-Pacific", Thailand: "Asia-Pacific", Vietnam: "Asia-Pacific",
  // Americas
  Argentina: "Americas", Brazil: "Americas", Chile: "Americas",
  Colombia: "Americas", Paraguay: "Americas", Peru: "Americas",
  // Middle East & Africa
  "South Africa": "Middle East & Africa", UAE_MiddleEast: "Middle East & Africa",
  MENA: "Middle East & Africa",
};
const REGION_ORDER = ["Europe", "Asia-Pacific", "Americas", "Middle East & Africa", "Global / Other"];
const regionOf = (name) => COUNTRY_REGION[name] || "Global / Other";

// Convert a 2-letter ISO country code (e.g. "GB", "PL") into its flag emoji.
const codeToFlag = (cc) => {
  const code = (cc || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return "";
  return code.replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
};

// Reverse: pull the 2-letter code back out of a flag emoji (regional indicators).
// Returns "" for non-flag emojis (🏠 🌍 🌐 ⚽ 🎵) so they render as-is.
const flagToCode = (flag) => {
  if (!flag) return "";
  const cps = [...flag].map((ch) => ch.codePointAt(0));
  if (cps.length === 2 && cps.every((cp) => cp >= 127462 && cp <= 127487)) {
    return cps.map((cp) => String.fromCharCode(cp - 127397)).join("").toLowerCase();
  }
  return "";
};

// Render a country flag as a real image (cross-platform — Windows can't draw
// regional-indicator emoji). Falls back to the 2-letter code, or the raw emoji
// for non-country entries.
function CountryFlag({ flag, imgClass = "w-11 h-[30px]", textClass = "text-3xl" }) {
  const code = flagToCode(flag);
  if (!code) return <span className={`${textClass} leading-none`}>{flag}</span>;
  return (
    <span className={`relative inline-flex items-center justify-center shrink-0 ${imgClass}`}>
      <img
        src={`https://flagcdn.com/w160/${code}.png`}
        alt=""
        loading="lazy"
        className={`${imgClass} rounded-[5px] object-cover ring-1 ring-black/10 shadow-sm`}
        onError={(e) => {
          e.currentTarget.style.display = "none";
          const s = e.currentTarget.nextElementSibling;
          if (s) s.style.display = "flex";
        }}
      />
      <span
        style={{ display: "none" }}
        className={`absolute inset-0 rounded-[5px] bg-white/15 text-white items-center justify-center text-[11px] font-black tracking-wider`}
      >
        {code.toUpperCase()}
      </span>
    </span>
  );
}

// --- Relative time formatter: "just now", "3m ago", "2h ago", "5d ago", "12/07" ---
function relativeTime(dateStr) {
  if (!dateStr) return "";
  const d = new Date(typeof dateStr === "string" ? dateStr : null);
  if (isNaN(d.getTime())) return "";
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  if (s < 604800) return `${Math.floor(s/86400)}d ago`;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit" });
}

// --- Save status indicator: "Saving…" / "Saved ✓" / "Last edited Xm ago" ---
function SaveStatus({ state, lastSavedAt }) {
  const [now, setNow] = useState(Date.now());
  // Re-render every 30s so "Xm ago" stays fresh while the card is open.
  useEffect(() => {
    if (state === "saving") return;
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, [state]);
  if (state === "saving") {
    return (
      <span className="flex items-center gap-1.5 text-[11px] font-bold text-[#768994]">
        <Loader2 className="w-3 h-3 animate-spin" /> Saving…
      </span>
    );
  }
  if (state === "saved") {
    return (
      <span className="flex items-center gap-1.5 text-[11px] font-bold text-[#1baf7a]">
        <Check className="w-3 h-3" /> Saved
      </span>
    );
  }
  // A write can fail — a schema the client is ahead of, a dropped connection,
  // RLS. Reporting "Saved" regardless is worse than not reporting at all: the
  // author walks away believing the note is filed.
  if (state === "error") {
    return (
      <span className="flex items-center gap-1.5 text-[11px] font-bold text-rose-500" title="Your note is still in the editor — reload only after this clears.">
        <AlertTriangle className="w-3 h-3" /> Not saved
      </span>
    );
  }
  const rel = lastSavedAt ? relativeTime(lastSavedAt) : "";
  return rel ? (
    <span className="text-[11px] font-semibold text-[#94a3b8]">Last edited {rel}</span>
  ) : null;
}

// The page accent, matching the Campaign Canvas header gradient (see
// src/lib/pageGradients.js) — used everywhere this file used to hardcode blue.
const CANVAS_GRADIENT = "from-amber-600 to-orange-700";

// Shared expandable menu-card shell for the three Reference sections (DOOH
// Specs, End of Campaign, Notes Canvas). Same "collapsed card → expands in
// place, way bigger, on click" idiom as Management's AdminHub, so these read
// as one deliberate navigation pattern instead of three small stacked panels.
function CollapsibleCard({ icon: Icon, title, subtitle, isOpen, onToggle, children }) {
  return (
    <div className="rounded-3xl bg-white border border-[#dce4ec] shadow-sm overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-500">
      <HubRow
        section={{ label: title, desc: subtitle, icon: Icon, gradient: CANVAS_GRADIENT }}
        onClick={onToggle}
        open={isOpen}
        first
      />
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            initial={{ gridTemplateRows: "0fr", opacity: 0 }}
            animate={{ gridTemplateRows: "1fr", opacity: 1 }}
            exit={{ gridTemplateRows: "0fr", opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            className="grid bg-slate-50 border-t border-[#dce4ec] transition-[grid-template-rows,opacity]"
          >
            <div className="min-h-0 overflow-hidden">
              <div className="p-6 sm:p-8 min-h-[460px]">{children}</div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// End of Campaign notes are stored as a JSON-stringified TipTap document in
// `content` (text column) — parsed/stringified at the call site since
// RichNoteEditor itself is storage-format-agnostic.

// --- Reference > End of Campaign Notes: pick a campaign, write wrap-up notes ---
// Notes are per (campaign, department) — Print's wrap-up on a campaign is a
// separate note from Motion's, sharing only the campaign picker.
// A stored note can be a non-empty string holding an empty document: TipTap
// serialises two blank paragraphs as 68 characters of JSON, and simply opening
// a campaign was enough to save one. Judging on the string being non-empty
// counted six such blanks as six wrap-ups. Test for actual content instead —
// the same check RichNoteEditor makes before persisting.
// Distinct from every personal colour (which come from profiles) and from the
// team board's terracotta, so "Shared with me" doesn't read as someone's space.
const SHARED_ACCENT = "#0d9488";

// Deep link to a single note/sketch: "#canvas/note-<uuid>".
//
// The second hash segment is safe to hang this on. App.jsx routes on the
// FIRST segment only (pageFromHash splits on "/"), and it rewrites the hash
// solely when that first segment disagrees with the active page — so "canvas"
// still resolves the page and the note id survives instead of being stamped
// out by the app's own hash bookkeeping.
const NOTE_LINK_RE = /^#?canvas\/note-([0-9a-fA-F-]{36})/;
const notePageIdFromHash = () => (window.location.hash.match(NOTE_LINK_RE) || [])[1] || null;
const noteLinkFor = (pageId) =>
  `${window.location.origin}${window.location.pathname}#canvas/note-${pageId}`;

// Deep link to one campaign's End of Campaign notes: "#canvas/eoc-<campaignId>".
//
// Same second-hash-segment trick as note links above, for the same reason —
// App.jsx routes on the first segment only, so "canvas" still resolves the page
// and this survives the app's own hash bookkeeping.
//
// Encoded because a campaign id is derived from its title
// ("wrike-paw-patrol-the-dino-movie"): today that is always url-safe, but the
// derivation is not ours to guarantee and a stray character would silently
// truncate the link rather than fail loudly.
const EOC_LINK_RE = /^#?canvas\/eoc-(.+)$/;
const eocCampaignIdFromHash = () => {
  const raw = (window.location.hash.match(EOC_LINK_RE) || [])[1];
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};
const eocLinkFor = (campaignId) =>
  `${window.location.origin}${window.location.pathname}#canvas/eoc-${encodeURIComponent(campaignId)}`;

// The debrief format the studio runs to. The prompt is the placeholder, so the
// question is in front of you while you answer it and disappears once you do —
// rather than being a heading everyone has to remember to type, which is what
// made the old free page impossible to pull apart afterwards.
//
// The keys are the column names in campaign_eoc_notes; see
// migrations/20260813120000_eoc_notes_three_sections.sql.
const EOC_SECTIONS = [
  {
    key: "positives",
    label: "Positives",
    prompt: "What worked well? Any specific shout outs?",
  },
  {
    key: "negatives",
    label: "Negatives & Solutions",
    prompt: "What didn't work well? What solution do you propose?",
  },
  {
    key: "improvements",
    label: "Additional Improvements",
    prompt: "Do you have additional solutions or improvements to highlight?",
  },
];

const EOC_EMPTY_NOTE = { positives: "", negatives: "", improvements: "" };

// Whether a row holds a write-up at all — any one of the three sections having
// real text in it.
//
// docHasText, not a substring test on the raw JSON. TipTap serialises two blank
// paragraphs as 68 characters of non-empty JSON, and merely opening a campaign
// was enough to save one — so the old `!!raw && raw.includes('"text"')` counted
// blanks as write-ups. Parsing and looking for actual text cannot be fooled
// that way, and it is the same check the export uses to decide whether to print
// a section, so the badge and the agenda always agree.
const hasNoteContent = (row) =>
  EOC_SECTIONS.some((s) => docHasText(row?.[s.key]));

// onOpenCampaign fires when a campaign is picked, so the page can fold the
// Notes Canvas browser above out of the way — writing a wrap-up shouldn't mean
// scrolling past the whole notes tree to reach it.
function EndOfCampaignNotesCard({ campaigns, department, onOpenCampaign, covers, focusCampaign }) {
  const [search, setSearch] = useState("");
  const [selectedCampaignId, setSelectedCampaignId] = useState(null);
  const [notes, setNotes] = useState([]);          // every author's note on this campaign
  const [profiles, setProfiles] = useState([]);
  // { positives, negatives, improvements } — each a JSON-stringified TipTap
  // document, or "" for a section not written in.
  const [myContent, setMyContent] = useState(EOC_EMPTY_NOTE);
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState("idle");
  const [lastSavedAt, setLastSavedAt] = useState(null);
  const [noteMeta, setNoteMeta] = useState({});
  const skipNextSaveRef = useRef(false);
  const savedTimerRef = useRef(null);

  // Whether you're currently in your own box. Typing or clicking into it opens
  // it up; a few seconds after you stop, it settles back to the size of the
  // others. Longer than the 800ms save debounce on purpose — the box shouldn't
  // shrink out from under someone who's merely thinking mid-sentence.
  const [writing, setWriting] = useState(false);
  const idleTimerRef = useRef(null);
  const noteActivity = useCallback(() => {
    setWriting(true);
    clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => setWriting(false), 4000);
  }, []);
  useEffect(() => () => clearTimeout(idleTimerRef.current), []);
  // A different campaign is a fresh start: collapsed until you write in it.
  useEffect(() => { setWriting(false); clearTimeout(idleTimerRef.current); }, [selectedCampaignId]);

  // Same identity the rest of Canvas uses for "who am I" (see NotesCanvasCard).
  const myId = useMemo(() => localStorage.getItem("wrike_user_id") || null, []);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("profiles")
        .select("wrike_user_id, first_name, last_name, canvas_color");
      setProfiles(data || []);
    })();
  }, []);

  const profileFor = useCallback(
    (id) => profiles.find((p) => p.wrike_user_id === id),
    [profiles]
  );
  const nameFor = useCallback(
    (id) => {
      const p = profileFor(id);
      if (!p) return "Someone";
      return [p.first_name, p.last_name].filter(Boolean).join(" ") || "Someone";
    },
    [profileFor]
  );
  const colorFor = useCallback(
    (id) => profileFor(id)?.canvas_color || hashColor(id),
    [profileFor]
  );

  // Which campaigns have been written up at all, and when last. Now that a
  // campaign can hold several notes, the list shows the freshest of them —
  // "when did anyone last add to this" is the useful signal, not per-author.
  const refreshNoteMeta = useCallback(async () => {
    // content comes back too, because "has this been written up" can't be
    // answered without looking inside — see hasNoteContent. One department's
    // wrap-up notes, so the extra payload is small.
    const { data } = await supabase
      .from("campaign_eoc_notes")
      .select("campaign_id, author_id, updated_at, positives, negatives, improvements")
      .eq("department", department);
    if (!data) return;
    // { campaignId: { at, authors: [id] } } — the freshest write-up on the
    // campaign, plus who has contributed one, so the list can show at a glance
    // whether a campaign is waiting on you rather than only that somebody
    // touched it.
    const meta = {};
    for (const r of data) {
      if (!hasNoteContent(r)) continue;
      const entry = (meta[r.campaign_id] ||= { at: null, authors: [] });
      if (!entry.at || new Date(r.updated_at) > new Date(entry.at)) entry.at = r.updated_at;
      if (r.author_id && !entry.authors.includes(r.author_id)) entry.authors.push(r.author_id);
    }
    setNoteMeta(meta);
  }, [department]);

  useEffect(() => { refreshNoteMeta(); }, [refreshNoteMeta]);

  // Arriving on a shared link. Waits for `campaigns` to load and checks the id
  // is real — a link to a campaign this department can't see would otherwise
  // select an id that matches nothing and leave the panel stuck on "Loading".
  //
  // APPLIED ONCE PER LINK, tracked by a ref. `campaigns` is refetched in the
  // background and gets a new identity each time, so without this the effect
  // would re-run and drag the selection back to the linked campaign every time
  // the list refreshed — you'd click another film and be bounced back.
  const appliedFocusRef = useRef(null);
  useEffect(() => {
    if (!focusCampaign?.id || !campaigns.length) return;
    const token = `${focusCampaign.id}#${focusCampaign.n}`;
    if (appliedFocusRef.current === token) return;
    if (!campaigns.some((c) => c.id === focusCampaign.id)) return;
    appliedFocusRef.current = token;
    setSelectedCampaignId(focusCampaign.id);
    onOpenCampaign?.();
  }, [focusCampaign, campaigns, onOpenCampaign]);

  useEffect(() => {
    if (!selectedCampaignId) { setNotes([]); setMyContent(EOC_EMPTY_NOTE); setLoaded(false); setSaveState("idle"); setLastSavedAt(null); return; }
    setLoaded(false);
    (async () => {
      const { data } = await supabase
        .from("campaign_eoc_notes")
        .select("author_id, updated_at, positives, negatives, improvements")
        .eq("campaign_id", selectedCampaignId)
        .eq("department", department);
      const rows = data || [];
      setNotes(rows);
      const mine = rows.find((r) => r.author_id === myId);
      // The editors are remounted per campaign (keyed below), so the first
      // change they report is the load itself, not the author typing.
      skipNextSaveRef.current = true;
      setMyContent({
        positives: mine?.positives || "",
        negatives: mine?.negatives || "",
        improvements: mine?.improvements || "",
      });
      setLastSavedAt(mine?.updated_at || null);
      setLoaded(true);
    })();
  }, [selectedCampaignId, department, myId]);

  useEffect(() => {
    if (!selectedCampaignId || !loaded || !myId) return;
    if (skipNextSaveRef.current) { skipNextSaveRef.current = false; return; }
    setSaveState("saving");
    const t = setTimeout(async () => {
      const { error } = await supabase.from("campaign_eoc_notes").upsert(
        {
          campaign_id: selectedCampaignId,
          department,
          author_id: myId,
          positives: myContent.positives,
          negatives: myContent.negatives,
          improvements: myContent.improvements,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "campaign_id,department,author_id" }
      );
      if (error) {
        // Stays on screen — no timer clearing it back to idle — because the
        // note only exists in this editor until the write lands.
        reportError(error, { scope: "eoc-note-save", campaignId: selectedCampaignId });
        setSaveState("error");
        return;
      }
      setSaveState("saved");
      setLastSavedAt(new Date().toISOString());
      refreshNoteMeta();
      savedTimerRef.current = setTimeout(() => setSaveState("idle"), 2000);
    }, 800);
    return () => { clearTimeout(t); clearTimeout(savedTimerRef.current); };
  }, [myContent, selectedCampaignId, department, loaded, myId, refreshNoteMeta]);

  // Campaigns that already have a wrap-up come first, most recently written at
  // the top — that's the thread of what the team has been adding to. Everything
  // still blank follows on its own recency (lastMatrixUpdate, the same signal
  // the Studios gallery sorts by), so the campaign most likely to need writing
  // up next sits directly under the ones already written.
  const sortedFilteredCampaigns = useMemo(() => {
    const q = search.trim().toLowerCase();
    return campaigns
      .filter((c) => !q || c.title.toLowerCase().includes(q))
      .sort((a, b) => {
        const aAt = noteMeta[a.id]?.at, bAt = noteMeta[b.id]?.at;
        if (aAt && bAt) return new Date(bAt) - new Date(aAt);
        if (aAt) return -1;
        if (bAt) return 1;
        return (b.lastMatrixUpdate || 0) - (a.lastMatrixUpdate || 0);
      });
  }, [campaigns, search, noteMeta]);

  const writtenUp = useMemo(
    () => campaigns.filter((c) => noteMeta[c.id]).length,
    [campaigns, noteMeta]
  );

  const selected = campaigns.find((c) => c.id === selectedCampaignId);
  const parseDoc = (raw) => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } };

  // Boxes in the bento, in reading order: the legacy shared note if this
  // campaign has one, then everyone else's, then yours. Yours is last so it
  // sits closest to where you stopped reading, and widest because it's the one
  // you type into.
  // The legacy shared note (author_id === "") and the old free-form `content`
  // column are no longer rendered anywhere — a write-up is the three sections
  // now. Both are still in the database, untouched, so nothing anyone wrote is
  // lost; see the migration for why they were not auto-filed into a section.
  const otherNotes = notes
    .filter((n) => n.author_id && n.author_id !== myId && hasNoteContent(n))
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

  // What the export reads. `notes` is only refreshed on load, so my own row in
  // it is stale the moment I type — the live editor state has to win, or you
  // copy an agenda missing the sentence you just wrote.
  const exportRows = useMemo(() => {
    const others = notes.filter((n) => n.author_id && n.author_id !== myId);
    const mineLive = myId ? [{ author_id: myId, ...myContent }] : [];
    return [...mineLive, ...others].filter(hasNoteContent);
  }, [notes, myId, myContent]);

  // Two shapes, because the two readings are genuinely different jobs. By
  // section is the debrief agenda — every Positive together, so one topic is
  // discussed at a time. By person is the record of who said what.
  const buildExport = useCallback(
    (mode) => {
      const title = selected?.title || "Campaign";
      const head = `END OF CAMPAIGN — ${title.toUpperCase()} (${department})`;
      const out = [head, "=".repeat(head.length), ""];

      if (!exportRows.length) {
        out.push("No notes written up yet.");
        return out.join("\n");
      }

      if (mode === "section") {
        for (const section of EOC_SECTIONS) {
          const written = exportRows
            .map((r) => ({ name: nameFor(r.author_id), text: docToPlainText(r[section.key]) }))
            .filter((r) => r.text);
          if (!written.length) continue;
          out.push(section.label.toUpperCase(), "");
          for (const { name, text } of written) {
            out.push(`  ${name}`);
            out.push(...text.split("\n").map((l) => (l ? `    ${l}` : "")));
            out.push("");
          }
        }
      } else {
        for (const row of exportRows) {
          out.push(nameFor(row.author_id).toUpperCase(), "");
          for (const section of EOC_SECTIONS) {
            const text = docToPlainText(row[section.key]);
            if (!text) continue;
            out.push(`  ${section.label}`);
            out.push(...text.split("\n").map((l) => (l ? `    ${l}` : "")));
            out.push("");
          }
        }
      }

      return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    },
    [exportRows, selected, department, nameFor]
  );

  const [copied, setCopied] = useState("");
  const flagCopied = useCallback((what) => {
    setCopied(what);
    setTimeout(() => setCopied(""), 2000);
  }, []);

  const copyExport = useCallback(
    async (mode) => {
      try {
        await navigator.clipboard.writeText(buildExport(mode));
        flagCopied(mode);
      } catch (err) {
        reportError(err, { scope: "eoc-export-copy" });
      }
    },
    [buildExport, flagCopied]
  );

  // Share the campaign itself, so "add your notes" comes with somewhere to go.
  // Falls back to a prompt: clipboard access needs a secure context and a user
  // gesture, and a silent failure here looks like the button does nothing.
  const copyCampaignLink = useCallback(async () => {
    if (!selectedCampaignId) return;
    const url = eocLinkFor(selectedCampaignId);
    try {
      await navigator.clipboard.writeText(url);
      flagCopied("link");
    } catch {
      window.prompt("Copy this link:", url);
    }
  }, [selectedCampaignId, flagCopied]);

  return (
    <section className="mt-10">
      {/* A standing band rather than another collapsed card. It sits under the
          team's notes because it's the same act — writing something down for
          everyone — and a note nobody can see they're allowed to write in never
          gets written in. */}
      <div className="rounded-3xl border border-[#dce4ec] bg-white shadow-sm overflow-hidden">
        <div className={`bg-gradient-to-br ${CANVAS_GRADIENT} px-6 py-5 flex items-center gap-4`}>
          <div className="shrink-0 w-12 h-12 rounded-2xl bg-white/15 border border-white/20 backdrop-blur-sm flex items-center justify-center">
            <FileText className="w-6 h-6 text-white" strokeWidth={1.75} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-lg font-bold text-white tracking-tight">End of Campaign Notes</h2>
            <p className="text-xs text-white/80 font-medium mt-0.5">
              What we enjoyed and what we'd do differently next time.
            </p>
          </div>
          <div className="hidden sm:block shrink-0 text-right">
            <p className="font-display text-2xl font-bold text-white tabular-nums leading-none">{writtenUp}</p>
            <p className="text-[10px] font-black uppercase tracking-widest text-white/70 mt-1">
              written up
            </p>
          </div>
        </div>

        <div className="flex flex-col lg:flex-row gap-5 p-5 sm:p-6 bg-slate-50 border-t border-[#dce4ec]">
          {/* Film list — one list, not a "recently edited" strip repeating rows
              that are in the list below it anyway. Each row carries its own
              state, so written-up and blank are told apart at a glance. */}
          <div className="lg:w-72 shrink-0 flex flex-col gap-2.5">
            <div className="relative">
              <Search className="w-4 h-4 text-[#768994] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search campaigns…"
                className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-[#dce4ec] bg-white outline-none text-sm font-semibold text-[#122027] focus:border-[#c2410d]/40"
              />
            </div>
            <div className="rounded-2xl border border-[#dce4ec] bg-white overflow-hidden max-h-[560px] overflow-y-auto custom-scrollbar divide-y divide-slate-100">
              {sortedFilteredCampaigns.length === 0 && (
                <p className="p-4 text-xs font-bold text-[#768994]">No campaigns match.</p>
              )}
              {sortedFilteredCampaigns.map((c) => {
                const meta = noteMeta[c.id];
                const at = meta?.at;
                const authors = meta?.authors || [];
                const isActive = c.id === selectedCampaignId;
                const cover = covers?.[c.id];
                const mineIn = myId && authors.includes(myId);
                return (
                  <button
                    key={c.id}
                    onClick={() => { setSelectedCampaignId(c.id); onOpenCampaign?.(); }}
                    className={`group relative w-full text-left pl-4 pr-3 py-2.5 flex items-center gap-3 transition-colors ${
                      isActive ? "bg-[#c2410d]/[0.07]" : "hover:bg-[#f2f6f9]"
                    }`}
                  >
                    {/* A bar rather than a tinted row alone: with poster art in
                        every row a background wash is easy to miss, an edge
                        against the list border is not. */}
                    <span
                      className={`absolute left-0 top-0 bottom-0 w-[3px] transition-colors ${
                        isActive ? "bg-[#c2410d]" : "bg-transparent"
                      }`}
                    />

                    {/* The campaign's own poster, the same art the gallery
                        uses. A list of thirty films is far quicker to scan by
                        artwork than by reading every title. */}
                    <span className="shrink-0 w-9 h-12 rounded-lg overflow-hidden bg-slate-100 border border-[#dce4ec] flex items-center justify-center">
                      {cover ? (
                        <img src={cover} alt="" loading="lazy" className="w-full h-full object-cover" />
                      ) : (
                        <span className="text-[13px] font-black text-[#c2d0da]">
                          {(c.title || "?").charAt(0).toUpperCase()}
                        </span>
                      )}
                    </span>

                    <span className="min-w-0 flex-1">
                      <span className={`block text-[13px] font-bold leading-tight truncate ${isActive ? "text-[#c2410d]" : "text-[#122027]"}`}>
                        {c.title}
                      </span>
                      <span className="block text-[10px] font-semibold text-[#94a3b8] mt-1">
                        {at ? relativeTime(at) : "No notes yet"}
                      </span>
                      {/* Who has written, not just that someone has. The thing
                          you actually want off this list is "have I done this
                          one" — so your own dot is ringed. */}
                      {authors.length > 0 && (
                        <span className="flex items-center gap-1 mt-1.5">
                          {authors.slice(0, 5).map((id) => (
                            <span
                              key={id}
                              title={nameFor(id)}
                              className={`w-3.5 h-3.5 rounded-full flex items-center justify-center text-[7px] font-black text-white ${
                                id === myId ? "ring-2 ring-offset-1 ring-[#c2410d]/50" : ""
                              }`}
                              style={{ background: colorFor(id) }}
                            >
                              {(nameFor(id) || "?").charAt(0).toUpperCase()}
                            </span>
                          ))}
                          {authors.length > 5 && (
                            <span className="text-[9px] font-black text-[#94a3b8]">+{authors.length - 5}</span>
                          )}
                          {!mineIn && myId && (
                            <span className="ml-0.5 text-[9px] font-black uppercase tracking-wider text-[#c2410d]/70">
                              not you yet
                            </span>
                          )}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex-1 min-w-0">
            {selectedCampaignId && loaded ? (
              <>
                <div className="flex items-center justify-between gap-3 mb-3 px-0.5 flex-wrap">
                  <p className="text-[13px] font-black text-[#122027] truncate">{selected?.title}</p>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={copyCampaignLink}
                      title="Copy a link that opens this campaign's notes"
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest border border-[#c2410d]/30 bg-[#c2410d]/5 text-[#c2410d] hover:bg-[#c2410d]/10 transition-colors"
                    >
                      {copied === "link" ? <Check className="w-3 h-3" /> : <Link2 className="w-3 h-3" />}
                      {copied === "link" ? "Copied" : "Share"}
                    </button>
                    <span className="w-px h-4 bg-[#dce4ec]" />
                    {/* Two buttons rather than a mode switch plus a copy: the
                        choice IS the action, and a switch you have to set
                        before copying is a step that only exists to be
                        forgotten. */}
                    <button
                      onClick={() => copyExport("section")}
                      disabled={!exportRows.length}
                      title="Copy everyone's notes grouped by section — the debrief agenda"
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest border border-[#dce4ec] bg-white text-[#768994] hover:text-[#122027] hover:border-[#c2d0da] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {copied === "section" ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
                      {copied === "section" ? "Copied" : "By section"}
                    </button>
                    <button
                      onClick={() => copyExport("person")}
                      disabled={!exportRows.length}
                      title="Copy everyone's notes grouped by person"
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest border border-[#dce4ec] bg-white text-[#768994] hover:text-[#122027] hover:border-[#c2d0da] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {copied === "person" ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
                      {copied === "person" ? "Copied" : "By person"}
                    </button>
                    <SaveStatus state={saveState} lastSavedAt={lastSavedAt} />
                  </div>
                </div>

                {/* The bento. A box each, so adding your take never means
                    editing over someone else's — the single shared note was a
                    blank page with everyone's name on it, which is nobody's. */}
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 auto-rows-min">
                  {/* YOURS FIRST. It used to sit last, on the reasoning that it
                      was closest to where you stopped reading — but it is the
                      one box you actually type in, and on a campaign several
                      people have written up that put the editor below a screen
                      of other people's notes. Reading can scroll; writing
                      shouldn't have to. */}
                  <EocNoteBox
                    className={writing ? "xl:col-span-2" : ""}
                    label={myId ? "Your note" : "Notes"}
                    sublabel={myId ? "Answer the three below" : "Connect Wrike in your Profile to write"}
                    accent={myId ? colorFor(myId) : "#c2410d"}
                    mine
                    expanded={writing}
                    onActivity={noteActivity}
                    note={myContent}
                    parseDoc={parseDoc}
                    onChangeSection={
                      myId
                        ? (key, json) => {
                            noteActivity();
                            setMyContent((prev) => ({ ...prev, [key]: JSON.stringify(json) }));
                          }
                        : undefined
                    }
                  />

                  {otherNotes.map((n) => (
                    <EocNoteBox
                      key={n.author_id}
                      label={nameFor(n.author_id)}
                      sublabel={relativeTime(n.updated_at)}
                      accent={colorFor(n.author_id)}
                      note={n}
                      parseDoc={parseDoc}
                    />
                  ))}
                </div>
              </>
            ) : selectedCampaignId ? (
              <p className="text-center text-sm font-bold text-[#768994] py-24">Loading notes…</p>
            ) : (
              <div className="h-full min-h-[340px] rounded-2xl border border-dashed border-[#dce4ec] bg-white/60 flex flex-col items-center justify-center text-center px-6">
                <FileText className="w-7 h-7 text-[#c2d0da] mb-3" strokeWidth={1.5} />
                <p className="text-sm font-bold text-[#122027]">Pick a campaign to write it up</p>
                <p className="text-xs font-medium text-[#768994] mt-1 max-w-xs">
                  You get your own box on each campaign — write your side of it, and read everyone else's next to it.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

// One box in the End of Campaign bento. `mine` is the only editable one: every
// other box is somebody else's note, shown in full but read-only, so the grid
// reads as a wall of takes rather than a document several people fight over.
function EocNoteBox({ label, sublabel, accent, note, parseDoc, onChangeSection, mine = false, expanded = false, onActivity, className = "" }) {
  // Your box is only the big one while you're actually in it. Once you stop,
  // it settles back to the size of everyone else's, so the grid reads as a
  // wall of equal takes rather than yours permanently dominating it.
  const roomy = mine && expanded;
  return (
    <div
      // Every way of being active in the box, because the editor's own
      // onChange is debounced 800ms and doesn't fire at all during continuous
      // typing — relying on it alone collapsed the box mid-sentence.
      // keydown catches typing, input catches paste and IME composition,
      // pointerdown/focus catch arriving in the first place.
      onFocusCapture={mine ? onActivity : undefined}
      onPointerDown={mine ? onActivity : undefined}
      onKeyDownCapture={mine ? onActivity : undefined}
      onInputCapture={mine ? onActivity : undefined}
      className={`rounded-2xl border bg-white overflow-hidden flex flex-col transition-[box-shadow,border-color] duration-300 ${className} ${
        mine
          ? roomy
            ? "border-[#c2410d] shadow-md ring-2 ring-[#c2410d]/10"
            : "border-[#c2410d]/35 shadow-sm"
          : "border-[#dce4ec]"
      }`}
    >
      <div className="flex items-center gap-2.5 px-4 py-2.5 border-b border-slate-100">
        <span className="shrink-0 w-6 h-6 rounded-lg flex items-center justify-center text-[10px] font-black text-white" style={{ background: accent }}>
          {(label || "?").charAt(0).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] font-black text-[#122027] truncate">{label}</span>
          {sublabel && <span className="block text-[10px] font-semibold text-[#94a3b8] truncate">{sublabel}</span>}
        </span>
        {mine && onChangeSection && (
          <span className={`shrink-0 text-[9px] font-black uppercase tracking-widest transition-colors duration-300 ${roomy ? "text-[#c2410d]" : "text-[#c2d0da]"}`}>
            {roomy ? "Editing" : "Your note"}
          </span>
        )}
      </div>
      {/* Height is what animates — the column span it sits in can't tween, so
          the transition carries the change and the reflow lands under it.
          Three sections now, so the box is taller than the single page was and
          scrolls internally rather than making the bento unreadable. */}
      <div
        className={`transition-[max-height] duration-500 ease-[cubic-bezier(0.4,0,0.2,1)] overflow-y-auto custom-scrollbar ${
          roomy ? "max-h-[620px]" : "max-h-[420px]"
        }`}
      >
        {EOC_SECTIONS.map((section, i) => {
          const raw = note?.[section.key] || "";
          const filled = docHasText(raw);
          // Somebody else's empty section is dropped rather than shown as a
          // blank editor — three empty boxes under a name says nothing and
          // makes the grid twice as long to read. Your own always render, or
          // there would be nowhere to answer the question.
          if (!mine && !filled) return null;
          return (
            <div key={section.key} className={i > 0 ? "border-t border-slate-100" : ""}>
              <div className="px-4 pt-3 pb-1">
                <div className="flex items-center gap-2">
                  <span
                    className="shrink-0 w-1 h-3 rounded-full"
                    style={{ background: filled ? accent : "#dce4ec" }}
                  />
                  <span className="text-[10px] font-black uppercase tracking-widest text-[#768994]">
                    {section.label}
                  </span>
                </div>
                {/* The question stays on screen rather than living in the
                    placeholder. As a placeholder it vanished at the first
                    keystroke — exactly when you are still deciding what to
                    write — and on someone else's box it never appeared at all,
                    so their answer arrived with no question attached. */}
                <p className="text-[11px] text-[#94a3b8] font-medium leading-snug mt-1 ml-3">
                  {section.prompt}
                </p>
              </div>
              <RichNoteEditor
                content={parseDoc(raw)}
                onChange={
                  mine && onChangeSection ? (json) => onChangeSection(section.key, json) : undefined
                }
                editable={!!mine && !!onChangeSection}
                accent={accent}
                // A field in a panel, not a page: without this the editor holds
                // a 46rem reading column and centres it, so a short answer
                // floats in the middle of a box whose labels are flush left.
                fill
                // No placeholder: the question is displayed above, and
                // repeating it inside the empty editor just says it twice.
                placeholder=""
                className="px-1 pb-1 min-h-[86px]"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// --- Reference > Notes Canvas: folders/topics of freeform pages, written
// with RichNoteEditor (see src/components/shared/RichNoteEditor.jsx). ---

// Accent palette for personal spaces. A teammate who hasn't picked a colour
// yet gets a deterministic one from this set (hashed off their id) so their
// section still reads consistently across sessions/devices.
const CANVAS_COLOR_PALETTE = ["#c2410d", "#f97316", "#ec4899", "#8b5cf6", "#10b981", "#ef4444", "#eab308", "#0ea5e9"];
const hashColor = (id) => {
  let hash = 0;
  const s = String(id || "");
  for (let i = 0; i < s.length; i++) hash = s.charCodeAt(i) + ((hash << 5) - hash);
  return CANVAS_COLOR_PALETTE[Math.abs(hash) % CANVAS_COLOR_PALETTE.length];
};

function FolderNameInput({ value, onChange, onSubmit, onCancel }) {
  return (
    <div className="flex items-center gap-1.5 mb-1">
      <input
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") onSubmit(); if (e.key === "Escape") onCancel(); }}
        placeholder="Topic name…"
        className="w-full px-2 py-1 rounded-lg border border-[#dce4ec] outline-none text-xs font-bold"
      />
      <button onClick={onSubmit} className="p-1 rounded hover:bg-black/5"><Check className="w-3.5 h-3.5 text-[#c2410d]" /></button>
    </div>
  );
}

function FolderTree({ folders, pages, selectedFolderId, selectedPageId, onToggleFolder, onSelectPage, onDeleteFolder, onDeletePage, onAddPage, accentColor }) {
  if (!folders.length) return <p className="text-xs font-semibold text-[#768994] px-1">No topics yet.</p>;
  return (
    <div className="space-y-0.5">
      {folders.map((folder) => {
        const folderPages = pages.filter((p) => p.folder_id === folder.id);
        const isExpanded = selectedFolderId === folder.id;
        return (
          <div key={folder.id}>
            <div
              role="button"
              tabIndex={0}
              onClick={() => onToggleFolder(folder.id)}
              className="group/folder flex items-center gap-1.5 px-1.5 py-1 rounded-lg cursor-pointer hover:bg-black/5"
            >
              <ChevronRight className={`w-3 h-3 shrink-0 text-[#768994] transition-transform ${isExpanded ? "rotate-90" : ""}`} />
              <span className="text-xs font-bold text-[#122027] truncate flex-1">{folder.name}</span>
              <span className="text-[10px] font-black text-[#768994]">{folderPages.length}</span>
              <button
                onClick={(e) => { e.stopPropagation(); onDeleteFolder(folder.id); }}
                className="opacity-0 group-hover/folder:opacity-100 p-0.5 rounded hover:bg-red-50 text-red-400"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
            {isExpanded && (
              <div className="ml-4 mt-0.5 space-y-0.5">
                {folderPages.map((page) => (
                  <div
                    key={page.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => onSelectPage(page.id)}
                    className="group/page flex items-center gap-1.5 px-1.5 py-1 rounded-lg cursor-pointer hover:bg-black/5 text-[#122027]"
                    style={page.id === selectedPageId ? { backgroundColor: `${accentColor}1a`, color: accentColor } : undefined}
                  >
                    <FileText className="w-3 h-3 shrink-0" />
                    <span className="text-xs font-semibold truncate flex-1">{page.title || "Untitled"}</span>
                    <button
                      onClick={(e) => { e.stopPropagation(); onDeletePage(page.id); }}
                      className="opacity-0 group-hover/page:opacity-100 p-0.5 rounded hover:bg-red-50 text-red-400"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
                <button
                  onClick={() => onAddPage(folder.id)}
                  className="flex items-center gap-1 px-1.5 py-1 text-[11px] font-black hover:opacity-80"
                  style={{ color: accentColor }}
                >
                  <Plus className="w-3 h-3" /> New page
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Folders-only column for the three-pane drill-down (Folders → Pages →
// Editor): a folder is just a selectable row here, its pages live in
// PageList next to it instead of nesting inline underneath.
function FolderList({ folders, pages, selectedFolderId, onSelectFolder, onDeleteFolder, accentColor }) {
  if (!folders.length) return <p className="text-xs font-semibold text-[#768994] px-1">No topics yet.</p>;
  return (
    <div className="space-y-1">
      {folders.map((folder) => {
        const count = pages.filter((p) => p.folder_id === folder.id).length;
        const isSelected = selectedFolderId === folder.id;
        return (
          <div
            key={folder.id}
            role="button"
            tabIndex={0}
            onClick={() => onSelectFolder(folder.id)}
            className="group/folder flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors"
            style={isSelected ? { backgroundColor: `${accentColor}1a` } : undefined}
          >
            <Folder className="w-3.5 h-3.5 shrink-0" style={{ color: accentColor }} />
            <span
              className="text-xs font-bold truncate flex-1"
              style={{ color: isSelected ? accentColor : "#122027" }}
            >
              {folder.name}
            </span>
            <span className="text-[10px] font-black text-[#768994]">{count}</span>
            <button
              onClick={(e) => { e.stopPropagation(); onDeleteFolder(folder.id); }}
              className="opacity-0 group-hover/folder:opacity-100 p-0.5 rounded hover:bg-red-50 text-red-400 shrink-0"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// Pages column: a folder's pages as cards rather than an indented list, so
// they carry the same visual weight as the folder they belong to instead
// of reading as a footnote underneath it.
function PageList({ folder, pages, selectedPageId, onSelectPage, onDeletePage, onAddPage, accentColor }) {
  if (!folder) {
    return (
      <p className="text-xs font-semibold text-[#768994] text-center px-4 py-8">
        Pick a topic on the left to see its pages.
      </p>
    );
  }
  const folderPages = pages.filter((p) => p.folder_id === folder.id);
  return (
    <div>
      <p className="text-[11px] font-black uppercase tracking-widest text-[#768994] px-1 mb-2 truncate">{folder.name}</p>
      <div className="space-y-1.5">
        {folderPages.map((page) => {
          const isSelected = page.id === selectedPageId;
          return (
            <div
              key={page.id}
              role="button"
              tabIndex={0}
              onClick={() => onSelectPage(page.id)}
              className="group/page flex items-center gap-2 px-2.5 py-2 rounded-xl border cursor-pointer transition-colors"
              style={isSelected ? { borderColor: accentColor, backgroundColor: `${accentColor}14` } : { borderColor: "#dce4ec" }}
            >
              <FileText className="w-3.5 h-3.5 shrink-0" style={{ color: isSelected ? accentColor : "#768994" }} />
              <span className="text-xs font-semibold truncate flex-1 text-[#122027]">{page.title || "Untitled"}</span>
              <button
                onClick={(e) => { e.stopPropagation(); onDeletePage(page.id); }}
                className="opacity-0 group-hover/page:opacity-100 p-0.5 rounded hover:bg-red-50 text-red-400 shrink-0"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          );
        })}
        <button
          onClick={() => onAddPage(folder.id)}
          className="w-full flex items-center justify-center gap-1 px-2.5 py-2 rounded-xl border border-dashed text-[11px] font-black hover:opacity-80"
          style={{ borderColor: `${accentColor}55`, color: accentColor }}
        >
          <Plus className="w-3 h-3" /> New page
        </button>
      </div>
    </div>
  );
}

// Kill switch for live collaborative editing on text notes. Collaboration
// rides Supabase Realtime, and this account has no egress headroom to spare —
// if it ever starts costing more than it's worth, flip this off and notes fall
// straight back to the previous single-editor save path with no deploy needed
// beyond this constant. localStorage lets it be disabled per-browser without
// touching everyone (e.g. from the console: localStorage.setItem("xyi_notes_collab","off")).
//
// Was OFF after the first version seeded a note's Yjs document by handing
// TipTap the `content` option, which Collaboration ignores — it builds the
// editor from the Y.Doc instead. Opening a note that had never been
// collaborated on produced an empty editor, and the autosave then wrote that
// emptiness over the real content, destroying a note (Toolbox Board) on
// 2026-07-16. Re-enabled after a full save-path audit closed every gap that
// surfaced: seeding happens in a deferred, race-guarded effect in
// RichNoteEditor.jsx rather than synchronously in onCreate (two clients
// opening the same virgin note at once both seeding was reproduced on the
// live UI, not hypothesised); onUpdate refuses to persist an empty document
// over a note that has content unless this editor has shown that content at
// least once; a non-collab save nulls the stored ydoc so stale CRDT state
// can't later revert a newer plain edit; ydoc is mirrored into local page
// state so remounting a note mid-session can't resurrect its pre-edit self;
// and CollaborativeNoteEditor refetches the authoritative ydoc at mount
// rather than trusting the page-list snapshot, closing the same
// stale-belief-of-"virgin" gap from a different angle.
const NOTES_COLLAB =
  typeof localStorage !== "undefined" && localStorage.getItem("xyi_notes_collab") === "off"
    ? false
    : true;

export function NotesCanvasCard({ isOpen, onToggle, department, pinnedFolderIds = [], onTogglePin, focusFolder, editorExpanded = false, onToggleEditorExpanded, bare = false }) {
  const [folders, setFolders] = useState([]);
  const [pages, setPages] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [selectedFolderId, setSelectedFolderId] = useState(null);
  const [selectedPageId, setSelectedPageId] = useState(null);
  const [folderDraft, setFolderDraft] = useState(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [pageSaveState, setPageSaveState] = useState("idle");
  const [pageLastSavedAt, setPageLastSavedAt] = useState(null);
  const savedTimerRef = useRef(null);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const [activeBoard, setActiveBoard] = useState("team");
  const [showTeammates, setShowTeammates] = useState(false);
  // Expand ("focus mode") is controlled by the parent so it can also hide the
  // campaigns panel and let the note take the full page width.
  const toggleEditorExpanded = onToggleEditorExpanded || (() => {});
  // Separate from editorExpanded: that flag now auto-fires for ANY open note
  // (see the effect below) purely to reclaim the campaigns column's width —
  // it says nothing about whether THIS card's own topics/pages rail should
  // hide. The rail is set per opened page in that same effect (collapsed for
  // a sketch, visible for a text note), so this initial value only covers
  // the state before anything is open.
  const [railCollapsed, setRailCollapsed] = useState(false);

  const currentUserId = useMemo(() => localStorage.getItem("wrike_user_id") || null, []);

  // --- Sharing a single page with named teammates -------------------------
  // Two separate reads rather than loading the whole share table: the pages
  // shared *with me* (for the "Shared with me" board), and the shares *on the
  // open page* (for the share menu). Pages shared from another department
  // aren't in `pages` — that's fetched per-department — so shared pages are
  // fetched by id and kept in their own list.
  const [sharedPages, setSharedPages] = useState([]);
  const [pageShares, setPageShares] = useState([]);
  const [shareOpen, setShareOpen] = useState(false);

  const loadSharedWithMe = useCallback(async () => {
    if (!currentUserId) return;
    const { data: rows } = await supabase
      .from("canvas_note_shares")
      .select("page_id, shared_by_wrike_id")
      .eq("shared_with_wrike_id", currentUserId);
    const ids = (rows || []).map((r) => r.page_id);
    if (!ids.length) { setSharedPages([]); return; }
    const { data: p } = await supabase.from("canvas_notes_pages").select("*").in("id", ids);
    const sharedBy = new Map((rows || []).map((r) => [r.page_id, r.shared_by_wrike_id]));
    setSharedPages((p || []).map((pg) => ({ ...pg, shared_by: sharedBy.get(pg.id) })));
  }, [currentUserId]);

  useEffect(() => { if (isOpen) loadSharedWithMe(); }, [isOpen, loadSharedWithMe]);

  // Who the open page is shared with. Reloaded per page so the menu can't
  // show another page's recipients.
  useEffect(() => {
    let cancelled = false;
    if (!selectedPageId) { setPageShares([]); return; }
    (async () => {
      const { data } = await supabase
        .from("canvas_note_shares")
        .select("id, shared_with_wrike_id")
        .eq("page_id", selectedPageId);
      if (!cancelled) setPageShares(data || []);
    })();
    return () => { cancelled = true; };
  }, [selectedPageId]);

  useEffect(() => { setShareOpen(false); }, [selectedPageId]);

  // --- Opening a shared link ----------------------------------------------
  // A link can point at a page from any topic or department, so it may not be
  // in `pages` (this department only) or `sharedPages`. Fetch the row by id
  // and keep it here so the editor can resolve it either way.
  const [linkedPages, setLinkedPages] = useState([]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    const openFromHash = async () => {
      const id = notePageIdFromHash();
      if (!id) return;
      setSelectedPageId(id);
      const { data } = await supabase.from("canvas_notes_pages").select("*").eq("id", id).maybeSingle();
      if (cancelled || !data) return;
      setLinkedPages((prev) => (prev.some((p) => p.id === data.id) ? prev : [...prev, data]));
      setSelectedFolderId(data.folder_id);
      // Land on the board the page actually belongs to, so the header and
      // accent describe where you are rather than whichever board happened
      // to be open when the link was followed.
      const { data: folder } = await supabase
        .from("canvas_notes_folders")
        .select("owner_wrike_id")
        .eq("id", data.folder_id)
        .maybeSingle();
      if (cancelled) return;
      const owner = folder?.owner_wrike_id || null;
      setActiveBoard(!owner ? "team" : owner === currentUserId ? "mine" : owner);
    };
    openFromHash();
    window.addEventListener("hashchange", openFromHash);
    return () => { cancelled = true; window.removeEventListener("hashchange", openFromHash); };
  }, [isOpen, currentUserId]);

  const [linkCopied, setLinkCopied] = useState(false);
  const copyPageLink = async () => {
    if (!selectedPageId) return;
    try {
      await navigator.clipboard.writeText(noteLinkFor(selectedPageId));
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 1800);
    } catch {
      // Clipboard access can be refused (permissions, insecure origin). Say
      // so rather than flashing "Copied!" over a clipboard that never changed.
      window.prompt("Copy this link:", noteLinkFor(selectedPageId));
    }
  };

  const toggleShare = async (wrikeId) => {
    if (!selectedPageId) return;
    const existing = pageShares.find((s) => s.shared_with_wrike_id === wrikeId);
    if (existing) {
      setPageShares((prev) => prev.filter((s) => s.id !== existing.id));
      await supabase.from("canvas_note_shares").delete().eq("id", existing.id);
      return;
    }
    const { data, error } = await supabase
      .from("canvas_note_shares")
      .insert({
        page_id: selectedPageId,
        shared_with_wrike_id: wrikeId,
        shared_by_wrike_id: currentUserId,
      })
      .select("id, shared_with_wrike_id")
      .single();
    // Optimism is added only once the row exists — a failed insert that left
    // the name ticked would read as "shared" when nothing had been.
    if (!error && data) setPageShares((prev) => [...prev, data]);
  };

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    (async () => {
      const [{ data: f }, { data: pr }] = await Promise.all([
        supabase.from("canvas_notes_folders").select("*").eq("department", department).order("created_at", { ascending: true }),
        supabase.from("profiles").select("wrike_user_id, first_name, last_name, canvas_color"),
      ]);
      if (cancelled) return;
      setFolders(f || []);
      setProfiles(pr || []);
      const folderIds = (f || []).map((x) => x.id);
      if (folderIds.length) {
        const { data: p } = await supabase.from("canvas_notes_pages").select("*").in("folder_id", folderIds).order("created_at", { ascending: true });
        if (!cancelled) setPages(p || []);
      } else {
        setPages([]);
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, department]);

  // Keeps a live-updated set of this department's folder ids for the pages
  // subscription below, which filters client-side (canvas_notes_pages has no
  // department column of its own to filter on server-side, only folder_id).
  const folderIdsRef = useRef(new Set());
  // A per-instance suffix so this card's Realtime channel topic is unique.
  // The topic used to be just `notes-canvas:${department}`, shared by every
  // card on that board — so once a second NotesCanvasCard mounted (the global
  // notes modal alongside the one already on the Canvas page), the second
  // supabase.channel(topic) handed back the first card's already-subscribed
  // channel, and calling .on() on a subscribed channel throws. Unique topics
  // give each mount its own channel; Postgres changes fan out to all of them.
  const channelIdRef = useRef(Math.random().toString(36).slice(2, 9));
  useEffect(() => {
    folderIdsRef.current = new Set(folders.map((f) => f.id));
  }, [folders]);

  // Without this, a folder or page someone else creates (or renames/edits with
  // collab off) never appears here until the card is closed and reopened —
  // the fetch above only runs once per (isOpen, department). This only ever
  // adds/updates/removes list entries; it never touches the open editor's own
  // content prop after mount, so it can't interrupt anyone's typing.
  useEffect(() => {
    if (!isOpen) return;
    const channel = supabase
      .channel(`notes-canvas:${department}:${channelIdRef.current}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "canvas_notes_folders", filter: `department=eq.${department}` },
        (payload) => {
          if (payload.eventType === "DELETE") {
            setFolders((prev) => prev.filter((f) => f.id !== payload.old.id));
            return;
          }
          const row = payload.new;
          setFolders((prev) =>
            prev.some((f) => f.id === row.id) ? prev.map((f) => (f.id === row.id ? { ...f, ...row } : f)) : [...prev, row]
          );
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "canvas_notes_pages" },
        (payload) => {
          if (payload.eventType === "DELETE") {
            setPages((prev) => prev.filter((p) => p.id !== payload.old.id));
            return;
          }
          const row = payload.new;
          if (!folderIdsRef.current.has(row.folder_id)) return; // belongs to another department
          setPages((prev) =>
            prev.some((p) => p.id === row.id) ? prev.map((p) => (p.id === row.id ? { ...p, ...row } : p)) : [...prev, row]
          );
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [isOpen, department]);

  const profileFor = (id) => profiles.find((pr) => pr.wrike_user_id === id);
  const nameFor = (id) => {
    const pr = profileFor(id);
    const name = pr && [pr.first_name, pr.last_name].filter(Boolean).join(" ");
    return name || "Teammate";
  };
  const colorFor = (id) => profileFor(id)?.canvas_color || hashColor(id);
  const myColor = currentUserId ? colorFor(currentUserId) : CANVAS_COLOR_PALETTE[0];
  // The person. Used wherever a human is named (presence, carets).
  const myFirstName = (currentUserId && profileFor(currentUserId)?.first_name) || "Someone";
  // The place. Used for the personal-board pill only — don't hand this to
  // anything that says "<x> is here".
  const myName = currentUserId && profileFor(currentUserId)?.first_name
    ? `${profileFor(currentUserId).first_name}'s Space`
    : "My Space";

  const teamFolders = folders.filter((f) => !f.owner_wrike_id);
  const myFolders = currentUserId ? folders.filter((f) => f.owner_wrike_id === currentUserId) : [];
  const teammateIds = [...new Set(
    folders.filter((f) => f.owner_wrike_id && f.owner_wrike_id !== currentUserId).map((f) => f.owner_wrike_id)
  )];

  const activeBoardFolders = activeBoard === "team"
    ? teamFolders
    : activeBoard === "mine"
      ? myFolders
      : folders.filter((f) => f.owner_wrike_id === activeBoard);

  const setMyColor = async (hex) => {
    if (!currentUserId) return;
    setProfiles((prev) => {
      const exists = prev.some((pr) => pr.wrike_user_id === currentUserId);
      return exists
        ? prev.map((pr) => (pr.wrike_user_id === currentUserId ? { ...pr, canvas_color: hex } : pr))
        : [...prev, { wrike_user_id: currentUserId, canvas_color: hex }];
    });
    setColorPickerOpen(false);
    await supabase.from("profiles").update({ canvas_color: hex }).eq("wrike_user_id", currentUserId);
  };

  const addFolder = async () => {
    const name = newFolderName.trim();
    if (!name || !folderDraft) { setFolderDraft(null); return; }
    const { data } = await supabase
      .from("canvas_notes_folders")
      .insert({ name, owner_wrike_id: folderDraft.owner, department })
      .select()
      .single();
    if (data) setFolders((prev) => [...prev, data]);
    setNewFolderName("");
    setFolderDraft(null);
  };

  const deleteFolder = async (folderId) => {
    await supabase.from("canvas_notes_folders").delete().eq("id", folderId);
    setFolders((prev) => prev.filter((f) => f.id !== folderId));
    setPages((prev) => prev.filter((p) => p.folder_id !== folderId));
    if (selectedFolderId === folderId) { setSelectedFolderId(null); setSelectedPageId(null); }
  };

  const addPage = async (folderId, kind = "text") => {
    const { data } = await supabase
      .from("canvas_notes_pages")
      .insert({ folder_id: folderId, title: "Untitled", content: kind === "sketch" ? {} : [], kind })
      .select()
      .single();
    if (data) {
      setPages((prev) => [...prev, data]);
      setSelectedFolderId(folderId);
      setSelectedPageId(data.id);
    }
  };

  const deletePage = async (pageId) => {
    await supabase.from("canvas_notes_pages").delete().eq("id", pageId);
    setPages((prev) => prev.filter((p) => p.id !== pageId));
    if (selectedPageId === pageId) setSelectedPageId(null);
  };

  const renamePage = async (pageId, title) => {
    setPages((prev) => prev.map((p) => (p.id === pageId ? { ...p, title } : p)));
    await supabase.from("canvas_notes_pages").update({ title }).eq("id", pageId);
  };

  const savePageContent = async (pageId, blocks, ydoc) => {
    // ydoc is mirrored into local state too — an earlier version froze the
    // local copy at fetch time out of fear that a changed prop would disrupt
    // a live session. It can't (the editor reads ydoc once, at mount), and
    // the frozen copy set a genuine trap: switch away from a note you'd been
    // editing and back again, and the editor remounted from the stale
    // pre-edit ydoc — showing (and on the next keystroke, persisting) content
    // your own saves had already superseded.
    setPages((prev) =>
      prev.map((p) =>
        p.id === pageId
          ? { ...p, content: blocks, ...(ydoc !== undefined ? { ydoc } : {}) }
          : p
      )
    );
    setPageSaveState("saving");
    const patch = { content: blocks, updated_at: new Date().toISOString() };
    if (ydoc !== undefined) patch.ydoc = ydoc;
    await supabase.from("canvas_notes_pages").update(patch).eq("id", pageId);
    setPageSaveState("saved");
    setPageLastSavedAt(new Date().toISOString());
    clearTimeout(savedTimerRef.current);
    savedTimerRef.current = setTimeout(() => setPageSaveState("idle"), 2000);
  };

  useEffect(() => {
    setPageSaveState("idle");
    const p = pages.find((pg) => pg.id === selectedPageId);
    setPageLastSavedAt(p?.updated_at || null);
  }, [selectedPageId]);

  // Opening ANY note reclaims the campaigns column's width automatically —
  // once you're reading/writing a specific note, that list isn't doing
  // anything for you. This only touches the OUTER (parent-controlled)
  // editorExpanded flag; it says nothing about this card's own rail, which
  // railCollapsed governs separately below. Symmetric on the way out
  // regardless of kind: switching boards or deleting the open page clears
  // selectedPageId, and without that branch editorExpanded stayed stuck
  // true with no way back short of a page refresh. Keyed on selectedPageId
  // itself (not editorExpanded) so toggling the parent flag manually doesn't
  // immediately get overridden by this effect re-firing.
  // Every page the editor can resolve, kept in a ref rather than in the
  // effect's deps below: those lists change on every realtime update, and
  // re-running the effect for that would snap the rail back and undo a
  // collapse the user had just done by hand.
  const allPagesRef = useRef([]);
  allPagesRef.current = [pages, sharedPages, linkedPages];

  useEffect(() => {
    if (selectedPageId && !editorExpanded) toggleEditorExpanded();
    if (!selectedPageId && editorExpanded) toggleEditorExpanded();
    // A sketch opens with the rail already out of the way — it's a canvas,
    // and every pixel of width counts. A text note keeps the list visible;
    // its prose is capped at a readable measure anyway, so hiding the rail
    // would buy nothing but a longer trip back to the other notes. Either
    // way the maximize button still toggles it by hand.
    const kind = allPagesRef.current.flat().find((p) => p.id === selectedPageId)?.kind;
    setRailCollapsed(kind === "sketch");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPageId]);

  // A sketch reached by a shared link is fetched after the effect above has
  // already run, so its kind wasn't known then — collapse once it lands.
  useEffect(() => {
    const linked = linkedPages.find((p) => p.id === selectedPageId);
    if (linked?.kind === "sketch") setRailCollapsed(true);
  }, [linkedPages, selectedPageId]);

  // Memoised: this is handed to the editor, which uses it to build the Yjs
  // awareness state at mount. A fresh object literal each render would look
  // like a changed identity to anything downstream keyed on it.
  // myName is the *board pill's* label ("Antonio's Space" / "My Space") — a
  // place, not a person. Presence and carets name a human, so they take the
  // first name straight off the profile: "Antonio is here", not
  // "Antonio's Space is here".
  const collabUser = useMemo(
    () => ({ name: myFirstName, color: myColor }),
    [myFirstName, myColor]
  );

  // The live provider for the open note, handed up by the editor once its
  // Y.Doc exists. Only used to read awareness for the presence chip; it's
  // nulled on unmount, so switching notes can't leave a stale one behind.
  const [collabProvider, setCollabProvider] = useState(null);

  // `pages` only holds this department's pages, so a page shared from another
  // department is findable only in sharedPages — without this fallback,
  // opening one from "Shared with me" would select nothing.
  const selectedPage =
    pages.find((p) => p.id === selectedPageId)
    || sharedPages.find((p) => p.id === selectedPageId)
    || linkedPages.find((p) => p.id === selectedPageId);
  // A text note's own editor column is already the wide 1fr side of the
  // two-column grid regardless of whether the rail is collapsed — capping
  // its prose at the same narrow 46rem either way just wastes the room a
  // wide screen already has. So a normal (non-sketch) note gets the wider
  // prose measure as soon as it's open; sketches don't use this at all
  // (they skip the doc-head block entirely).
  const proseWide = !!selectedPage && selectedPage.kind !== "sketch";
  const selectedPageFolder = selectedPage ? folders.find((f) => f.id === selectedPage.folder_id) : null;
  const selectedAccent = selectedPageFolder?.owner_wrike_id ? colorFor(selectedPageFolder.owner_wrike_id) : "#c2410d";
  // One accent for the whole active board: terracotta for the team board, the
  // owner's colour for a personal/teammate space — so the section reads as
  // "whose space am I in" at a glance, not just a coloured pill.
  const boardAccent = activeBoard === "team" ? "#c2410d"
    : activeBoard === "mine" ? myColor
    : activeBoard === "shared" ? SHARED_ACCENT
    : colorFor(activeBoard);

  // Pull plain text out of a stored TipTap document — powers the note-list
  // preview snippet and the editor's live word count. Accepts either a full
  // ProseMirror doc ({type:"doc", content:[...]}) or a bare content array.
  const blocksText = (doc) => {
    if (!doc) return "";
    const nodes = Array.isArray(doc) ? doc : doc.content;
    if (!Array.isArray(nodes)) return "";
    const walk = (nodes) =>
      (nodes || []).map((n) => {
        if (typeof n?.text === "string") return n.text;
        return Array.isArray(n?.content) ? walk(n.content) : "";
      }).join(" ");
    return walk(nodes).replace(/\s+/g, " ").trim();
  };
  const snippetOf = (page) => blocksText(page?.content).slice(0, 60);
  const wordCountOf = (page) => {
    const t = blocksText(page?.content);
    return t ? t.split(/\s+/).filter(Boolean).length : 0;
  };
  const timeAgo = (iso) => {
    if (!iso) return "not saved yet";
    const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    if (d <= 0) return "today";
    if (d === 1) return "yesterday";
    if (d < 7) return `${d}d ago`;
    if (d < 30) return `${Math.floor(d / 7)}w ago`;
    return `${Math.floor(d / 30)}mo ago`;
  };

  const toggleFolder = (id) => setSelectedFolderId((prev) => (prev === id ? null : id));
  const startDraft = (owner) => { setFolderDraft({ owner }); setNewFolderName(""); };

  // A pinned-topic card on the shelf was clicked: jump to the board that owns
  // the folder and open it. focusFolder bumps its `n` each click so re-clicking
  // the same topic still re-triggers.
  useEffect(() => {
    if (!focusFolder?.id || !folders.length) return;
    const folder = folders.find((f) => f.id === focusFolder.id);
    if (!folder) return;
    setActiveBoard(
      !folder.owner_wrike_id ? "team" : folder.owner_wrike_id === currentUserId ? "mine" : folder.owner_wrike_id
    );
    setSelectedFolderId(folder.id);
  }, [focusFolder, folders, currentUserId]);

  // One-click "New note": drop a page into the active topic (the one whose note
  // is open, else the first topic on this board). With no topic yet, start a
  // topic draft instead so the user is never stuck at an empty board.
  const handleNewNote = (kind = "text") => {
    const target =
      (selectedFolderId && activeBoardFolders.some((f) => f.id === selectedFolderId) && selectedFolderId) ||
      activeBoardFolders[0]?.id;
    if (target) {
      setSelectedFolderId(target);
      addPage(target, kind);
    } else {
      // No topic to hold the page yet — same starting-point regardless of
      // kind; the first page added once the topic exists defaults to text.
      startDraft(activeBoard === "mine" ? currentUserId : null);
    }
  };

  // Surface bleeds to the card edges (covers the CollapsibleCard's cool
  // slate-50 inner) and takes on the active board's accent, so the whole
  // Notes Canvas reads as "whose space am I in". In `bare` mode (the
  // quick-access Notes modal) the surrounding CollapsibleCard is dropped —
  // the modal supplies its own chrome — so the content-bleed negative margins
  // that tuck under the card's own padding would instead pull content past the
  // modal's edges; they're dropped too.
  const body = (
      <div
        className={`flex flex-col gap-4 ${bare ? "p-5 sm:p-6" : "-m-6 sm:-m-8 p-5 sm:p-6"} transition-colors duration-300`}
        style={{ background: `linear-gradient(180deg, ${boardAccent}14, ${boardAccent}08 40%, ${boardAccent}05)` }}
      >
        {/* --- Board switcher: which space am I in --- */}
        {/* This is the primary navigation for the whole panel — team board vs
            personal vs a teammate's space — so it gets real visual weight
            (solid colour fill + icon on the active pill) rather than reading
            as a quiet segmented control. */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => { setActiveBoard("team"); setSelectedPageId(null); }}
            className={`inline-flex items-center gap-2 pl-3 pr-4 py-2 rounded-2xl text-sm font-black tracking-wide transition-[color,background-color,border-color,box-shadow] focus-visible:ring-2 focus-visible:ring-[#c2410d]/40 focus-visible:outline-none ${
              activeBoard === "team" ? "text-white shadow-md" : "bg-white/80 border border-[#ece4d8] text-[#8a8073] hover:text-[#5a5147] hover:border-[#c2410d]/30"
            }`}
            style={activeBoard === "team" ? { background: `linear-gradient(135deg, #c2410d, #9a3412)` } : undefined}
          >
            <span
              className="w-6 h-6 rounded-lg grid place-items-center shrink-0"
              style={activeBoard === "team" ? { backgroundColor: "#ffffff2a" } : { backgroundColor: "#c2410d14", color: "#c2410d" }}
            >
              <Users className="w-3.5 h-3.5" />
            </span>
            {boardLabelFor(department)}
          </button>

          {currentUserId && (
            <button
              onClick={() => { setActiveBoard("mine"); setSelectedPageId(null); }}
              className={`inline-flex items-center gap-2 pl-3 pr-4 py-2 rounded-2xl text-sm font-black tracking-wide transition-[color,background-color,border-color,box-shadow] focus-visible:ring-2 focus-visible:ring-[#c2410d]/40 focus-visible:outline-none ${
                activeBoard === "mine" ? "text-white shadow-md" : "bg-white/80 border border-[#ece4d8] text-[#8a8073] hover:text-[#5a5147]"
              }`}
              style={activeBoard === "mine" ? { background: `linear-gradient(135deg, ${myColor}, ${myColor}cc)` } : { borderColor: `${myColor}30` }}
            >
              <span
                className="w-6 h-6 rounded-lg grid place-items-center text-[10px] font-black shrink-0"
                style={activeBoard === "mine" ? { backgroundColor: "#ffffff2a", color: "#fff" } : { backgroundColor: `${myColor}18`, color: myColor }}
              >
                {(myName || "M").charAt(0)}
              </span>
              {myName}
            </button>
          )}

          {/* Only appears once something has actually been shared with you —
              an always-present empty board would just be furniture. */}
          {sharedPages.length > 0 && (
            <button
              onClick={() => { setActiveBoard("shared"); setSelectedPageId(null); }}
              className={`inline-flex items-center gap-2 pl-3 pr-4 py-2 rounded-2xl text-sm font-black tracking-wide transition-[color,background-color,border-color,box-shadow] focus-visible:ring-2 focus-visible:ring-[#c2410d]/40 focus-visible:outline-none ${
                activeBoard === "shared" ? "text-white shadow-md" : "bg-white/80 border border-[#ece4d8] text-[#8a8073] hover:text-[#5a5147]"
              }`}
              style={activeBoard === "shared"
                ? { background: `linear-gradient(135deg, ${SHARED_ACCENT}, ${SHARED_ACCENT}cc)` }
                : { borderColor: `${SHARED_ACCENT}30` }}
            >
              <span
                className="w-6 h-6 rounded-lg grid place-items-center shrink-0"
                style={activeBoard === "shared"
                  ? { backgroundColor: "#ffffff2a", color: "#fff" }
                  : { backgroundColor: `${SHARED_ACCENT}18`, color: SHARED_ACCENT }}
              >
                <Share2 className="w-3.5 h-3.5" />
              </span>
              Shared with me
              <span className="text-[11px] font-bold tabular-nums opacity-70">{sharedPages.length}</span>
            </button>
          )}

          {teammateIds.map((id) => {
            const color = colorFor(id);
            const isActive = activeBoard === id;
            return (
              <button
                key={id}
                onClick={() => { setActiveBoard(id); setSelectedPageId(null); }}
                className={`inline-flex items-center gap-2 pl-3 pr-4 py-2 rounded-2xl text-sm font-black tracking-wide transition-[color,background-color,border-color,box-shadow] focus-visible:ring-2 focus-visible:ring-[#c2410d]/40 focus-visible:outline-none ${
                  isActive ? "text-white shadow-md" : "bg-white/80 border border-[#ece4d8] text-[#8a8073] hover:text-[#5a5147]"
                }`}
                style={isActive ? { background: `linear-gradient(135deg, ${color}, ${color}cc)` } : { borderColor: `${color}30` }}
              >
                <span
                  className="w-6 h-6 rounded-lg grid place-items-center text-[10px] font-black shrink-0"
                  style={isActive ? { backgroundColor: "#ffffff2a", color: "#fff" } : { backgroundColor: `${color}18`, color }}
                >
                  {nameFor(id).charAt(0)}
                </span>
                <span className="truncate max-w-[90px]">{nameFor(id)}</span>
              </button>
            );
          })}
        </div>

        {/* --- Main content: two-column layout --- */}
        <div className={`grid gap-4 ${railCollapsed ? "grid-cols-1" : "grid-cols-[248px_1fr]"}`}>
          {/* Notes rail — New note button, then topics as quiet section
              headers with their notes listed flat beneath (no expand gate). */}
          {!railCollapsed && (
          <div
            className="flex flex-col rounded-2xl border border-[#dce4ec] bg-white shadow-sm overflow-hidden max-h-[600px]"
            /* Surface comes from the bg-white class, not an inline hex, so the
               dark theme can remap it; only the personal-space accent tint stays
               inline (it's derived from the member's own colour). */
            style={activeBoard === "mine" ? { borderColor: `${myColor}44`, backgroundColor: `${myColor}08` } : undefined}
          >
            {/* "Shared with me" is a read-through of other people's pages —
                there's no topic of yours here for a new note to belong to, so
                the create controls step aside rather than failing on click. */}
            {activeBoard !== "shared" && (
            <div className="p-2.5 border-b border-slate-100 flex items-center gap-1.5">
              <button
                onClick={() => handleNewNote("text")}
                className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-white text-[13px] font-bold shadow-sm transition-[transform,box-shadow] hover:-translate-y-px hover:shadow-[0_10px_26px_-12px_rgba(18,32,39,0.22)] active:scale-[.98] focus-visible:ring-2 focus-visible:ring-[#c2410d]/40 focus-visible:outline-none"
                style={{ background: `linear-gradient(135deg, ${boardAccent}, ${boardAccent}cc)` }}
              >
                <Plus className="w-4 h-4" /> New note
              </button>
              <button
                onClick={() => handleNewNote("sketch")}
                title="New sketch"
                className="shrink-0 flex items-center justify-center w-10 h-10 rounded-xl border shadow-sm transition-[transform,box-shadow] hover:-translate-y-px hover:shadow-[0_10px_26px_-12px_rgba(18,32,39,0.22)] active:scale-[.98] focus-visible:ring-2 focus-visible:ring-[#c2410d]/40 focus-visible:outline-none"
                style={{ borderColor: `${boardAccent}55`, color: boardAccent }}
              >
                <PenTool className="w-4 h-4" />
              </button>
            </div>
            )}

            <div className="flex items-center gap-2 px-3 pt-2.5 pb-1">
              <span className="text-[10px] font-black uppercase tracking-[0.13em] text-[#8a8073] flex-1 truncate">
                {activeBoard === "mine" ? myName : activeBoard === "shared" ? "Shared with me" : boardLabelFor(department)}
              </span>
              {activeBoard === "mine" && (
                <button
                  onClick={() => setColorPickerOpen((v) => !v)}
                  title="Change my colour"
                  className="w-5 h-5 rounded-md flex items-center justify-center shrink-0"
                  style={{ backgroundColor: `${myColor}22`, color: myColor }}
                >
                  <User className="w-3 h-3" />
                </button>
              )}
              <button
                onClick={() => startDraft(activeBoard === "mine" ? currentUserId : null)}
                title="New topic"
                className="p-1 rounded-md hover:bg-black/5 shrink-0"
                style={{ color: boardAccent }}
              >
                <FolderPlus className="w-3.5 h-3.5" />
              </button>
            </div>

            {activeBoard === "mine" && colorPickerOpen && (
              <div className="flex items-center gap-1 mx-3 mb-2 p-1.5 rounded-lg border border-[#ece4d8] bg-white shadow-sm w-fit">
                {CANVAS_COLOR_PALETTE.map((hex) => (
                  <button
                    key={hex}
                    onClick={() => setMyColor(hex)}
                    className="w-4 h-4 rounded-full ring-1 ring-black/5"
                    style={{ backgroundColor: hex }}
                  />
                ))}
              </div>
            )}

            {folderDraft?.owner === (activeBoard === "mine" ? currentUserId : null) && (
              <div className="flex items-center gap-1.5 mx-3 mb-2">
                <input
                  autoFocus
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") addFolder(); if (e.key === "Escape") setFolderDraft(null); }}
                  placeholder="Topic name…"
                  className="flex-1 px-2 py-1 rounded-lg border border-[#ece4d8] outline-none text-xs font-bold"
                />
                <button onClick={addFolder} className="p-1 rounded hover:bg-black/5"><Check className="w-3.5 h-3.5 text-[#c2410d]" /></button>
              </div>
            )}

            <div className="flex-1 overflow-y-auto px-2 pb-3">
              {activeBoard === "shared" ? (
                // Shared pages come from every topic and department, so they
                // list flat — grouping them under topic headers would imply a
                // structure the recipient has no access to navigate.
                sharedPages.map((page) => {
                  const active = selectedPageId === page.id;
                  const isSketch = page.kind === "sketch";
                  return (
                    <div
                      key={page.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => { setSelectedFolderId(page.folder_id); setSelectedPageId(page.id); }}
                      className={`group/page flex items-start gap-2.5 mx-1 px-2 py-2 rounded-lg cursor-pointer transition-colors ${
                        active ? "bg-white shadow-sm" : "hover:bg-black/[0.03]"
                      }`}
                    >
                      <span
                        className="w-6 h-6 rounded-md grid place-items-center shrink-0 mt-0.5"
                        style={{ backgroundColor: active ? `${boardAccent}18` : "#00000008", color: active ? boardAccent : "#8a8073" }}
                      >
                        {isSketch ? <PenTool className="w-3.5 h-3.5" /> : <FileText className="w-3.5 h-3.5" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={`block text-[13px] font-semibold truncate leading-tight ${active ? "" : "text-[#3a352e]"}`} style={active ? { color: boardAccent } : undefined}>
                          {page.title || "Untitled"}
                        </span>
                        <span className="block text-[11px] text-[#8a8073] truncate mt-0.5">
                          {page.shared_by ? `Shared by ${nameFor(page.shared_by)}` : "Shared with you"}
                        </span>
                      </span>
                    </div>
                  );
                })
              ) : activeBoardFolders.length === 0 ? (
                <p className="text-xs font-semibold text-[#8a8073] px-2 py-4">
                  No topics yet — add one with the + above.
                </p>
              ) : (
                activeBoardFolders.map((folder) => {
                  const folderPages = pages.filter((p) => p.folder_id === folder.id);
                  const isPinned = pinnedFolderIds.includes(folder.id);
                  return (
                    <div key={folder.id} className="mb-1.5">
                      {/* Topic header */}
                      <div className="group/folder flex items-center gap-1.5 px-2 pt-2.5 pb-1">
                        <span className="text-[10px] font-black uppercase tracking-[0.12em] text-[#8a8073] truncate">{folder.name}</span>
                        <span className="text-[10px] font-bold text-[#6b6155] tabular-nums">{folderPages.length}</span>
                        <div className="flex-1" />
                        {onTogglePin && (
                          <button
                            onClick={(e) => { e.stopPropagation(); onTogglePin(folder); }}
                            title={isPinned ? "Unpin topic" : "Pin topic to shelf"}
                            className={`p-0.5 rounded transition-[color,opacity] focus-visible:ring-2 focus-visible:ring-[#c2410d]/40 focus-visible:outline-none ${isPinned ? "text-amber-500" : "text-[#8a8073] opacity-0 group-hover/folder:opacity-100 hover:text-amber-500"}`}
                          >
                            <Pin className={`w-3 h-3 ${isPinned ? "fill-current" : ""}`} />
                          </button>
                        )}
                        <button
                          onClick={() => addPage(folder.id)}
                          title="New note in this topic"
                          className="p-0.5 rounded text-[#6b6155] opacity-0 group-hover/folder:opacity-100 hover:text-[#c2410d] transition-[color,opacity]"
                        >
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); deleteFolder(folder.id); }}
                          title="Delete topic"
                          className="opacity-0 group-hover/folder:opacity-100 p-0.5 rounded hover:bg-red-50 text-red-400 transition-[background-color,opacity]"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>

                      {/* Notes — always visible, no expand gate */}
                      {folderPages.length === 0 ? (
                        <div className="flex items-center gap-2 mx-1 px-1 py-1">
                          <button
                            onClick={() => addPage(folder.id, "text")}
                            className="flex items-center gap-1.5 px-1 py-0.5 text-[11px] font-semibold text-[#8a8073] hover:text-[#c2410d] transition-colors"
                          >
                            <Plus className="w-3 h-3" /> Add the first note
                          </button>
                          <button
                            onClick={() => addPage(folder.id, "sketch")}
                            title="Add a sketch"
                            className="flex items-center gap-1 px-1 py-0.5 text-[11px] font-semibold text-[#8a8073] hover:text-[#c2410d] transition-colors"
                          >
                            <PenTool className="w-3 h-3" />
                          </button>
                        </div>
                      ) : (
                        folderPages.map((page) => {
                          const active = selectedPageId === page.id;
                          const isSketch = page.kind === "sketch";
                          const shapeCount = page.content?.elements?.length || 0;
                          const snippet = isSketch
                            ? (shapeCount ? `${shapeCount} shape${shapeCount === 1 ? "" : "s"}` : "")
                            : snippetOf(page);
                          return (
                            <div
                              key={page.id}
                              role="button"
                              tabIndex={0}
                              onClick={() => { setSelectedFolderId(folder.id); setSelectedPageId(page.id); }}
                              className={`group/page flex items-start gap-2.5 mx-1 px-2 py-2 rounded-lg cursor-pointer transition-colors ${
                                active ? "bg-white shadow-sm" : "hover:bg-black/[0.03]"
                              }`}
                            >
                              <span
                                className="w-6 h-6 rounded-md grid place-items-center shrink-0 mt-0.5"
                                style={{ backgroundColor: active ? `${boardAccent}18` : "#00000008", color: active ? boardAccent : "#8a8073" }}
                              >
                                {isSketch ? <PenTool className="w-3.5 h-3.5" /> : <FileText className="w-3.5 h-3.5" />}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className={`block text-[13px] font-semibold truncate leading-tight ${active ? "" : "text-[#3a352e]"}`} style={active ? { color: boardAccent } : undefined}>
                                  {page.title || "Untitled"}
                                </span>
                                <span className="block text-[11px] text-[#8a8073] truncate mt-0.5">
                                  {snippet || (isSketch ? "Empty sketch" : "Empty note")}
                                </span>
                              </span>
                              <button
                                onClick={(e) => { e.stopPropagation(); deletePage(page.id); }}
                                className="opacity-0 group-hover/page:opacity-100 p-0.5 rounded hover:bg-red-50 text-red-400 transition-[background-color,opacity] mt-0.5"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </div>
                          );
                        })
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
          )}

          {/* Editor column */}
          <div className="flex flex-col min-w-0 rounded-2xl border shadow-sm overflow-hidden bg-white"
            style={selectedPage ? { borderColor: `${selectedAccent}33`, borderLeftWidth: 3, borderLeftColor: selectedAccent } : { borderColor: "#ece4d8" }}
          >
            {/* Slim top bar — orientation + save state + focus toggle */}
            <div className="flex items-center gap-2 px-4 py-2 border-b border-slate-100 shrink-0">
              <span className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.13em]" style={{ color: `${boardAccent}` }}>
                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: boardAccent }} />
                {activeBoard === "mine" ? myName
                  : activeBoard === "team" ? boardLabelFor(department)
                  : activeBoard === "shared" ? "Shared with me"
                  : nameFor(activeBoard)}
              </span>
              {selectedPage?.kind === "sketch" && (
                <input
                  value={selectedPage.title}
                  onChange={(e) => renamePage(selectedPage.id, e.target.value)}
                  placeholder="Untitled sketch"
                  className="ml-2 min-w-0 max-w-[260px] text-[13px] font-bold text-[#3a352e] bg-transparent outline-none border-b border-transparent focus:border-[#d5cdbf] px-1 truncate placeholder:text-[#cdc5b7] placeholder:font-medium"
                />
              )}
              <div className="flex-1" />
              {selectedPage && <SaveStatus state={pageSaveState} lastSavedAt={pageLastSavedAt} />}
              {/* Share lives in the top bar rather than the document head so
                  it's reachable for sketches too — they skip the head. */}
              {selectedPage && currentUserId && (
                <div className="relative shrink-0">
                  <button
                    onClick={() => setShareOpen((v) => !v)}
                    title="Share this page with teammates"
                    className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[11px] font-bold transition-colors ${
                      pageShares.length ? "text-white" : "text-[#8a8073] hover:bg-black/5"
                    }`}
                    style={pageShares.length ? { backgroundColor: SHARED_ACCENT } : undefined}
                  >
                    <Share2 className="w-4 h-4" />
                    {pageShares.length > 0 && <span className="tabular-nums">{pageShares.length}</span>}
                  </button>
                  {shareOpen && (
                    <>
                      <div className="fixed inset-0 z-[60]" onClick={() => setShareOpen(false)} />
                      <div className="absolute right-0 top-full mt-1.5 z-[61] w-60 max-h-72 overflow-y-auto rounded-xl border border-[#ece4d8] bg-white shadow-xl p-1.5">
                        {/* Copy link sits above the people list: sending a
                            link is the quickest way to get someone to a page,
                            and it works whether or not you also tick them. */}
                        <button
                          onClick={copyPageLink}
                          className="w-full flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-black/[0.04] transition-colors text-left"
                        >
                          <span
                            className="w-6 h-6 rounded-lg grid place-items-center shrink-0"
                            style={{ backgroundColor: `${SHARED_ACCENT}18`, color: SHARED_ACCENT }}
                          >
                            {linkCopied ? <Check className="w-3.5 h-3.5" /> : <Link2 className="w-3.5 h-3.5" />}
                          </span>
                          <span className="min-w-0 flex-1 text-[12px] font-bold text-[#3a352e]">
                            {linkCopied ? "Link copied" : "Copy link to this page"}
                          </span>
                        </button>
                        <p className="px-2 pt-1.5 pb-1 text-[10px] font-black uppercase tracking-[0.12em] text-[#8a8073] border-t border-[#f2ece2] mt-1">
                          Notify
                        </p>
                        {profiles.filter((pr) => pr.wrike_user_id !== currentUserId).length === 0 ? (
                          <p className="px-2 py-2 text-[11px] text-[#8a8073]">No teammates found.</p>
                        ) : (
                          profiles
                            .filter((pr) => pr.wrike_user_id !== currentUserId)
                            .map((pr) => {
                              const on = pageShares.some((s) => s.shared_with_wrike_id === pr.wrike_user_id);
                              const color = colorFor(pr.wrike_user_id);
                              return (
                                <button
                                  key={pr.wrike_user_id}
                                  onClick={() => toggleShare(pr.wrike_user_id)}
                                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-black/[0.04] transition-colors text-left"
                                >
                                  <span
                                    className="w-6 h-6 rounded-lg grid place-items-center text-[10px] font-black shrink-0"
                                    style={{ backgroundColor: `${color}18`, color }}
                                  >
                                    {(pr.first_name || "?").charAt(0)}
                                  </span>
                                  <span className="min-w-0 flex-1 text-[12px] font-semibold text-[#3a352e] truncate">
                                    {[pr.first_name, pr.last_name].filter(Boolean).join(" ") || pr.wrike_user_id}
                                  </span>
                                  <span
                                    className={`w-4 h-4 rounded grid place-items-center shrink-0 border ${on ? "border-transparent" : "border-[#d5cdbf]"}`}
                                    style={on ? { backgroundColor: SHARED_ACCENT } : undefined}
                                  >
                                    {on && <Check className="w-3 h-3 text-white" />}
                                  </span>
                                </button>
                              );
                            })
                        )}
                        <p className="px-2 pt-2 pb-1 text-[10px] leading-snug text-[#a29889] border-t border-[#f2ece2] mt-1">
                          Ticking puts this page in their “Shared with me”. Everyone signed in can already open any note — this isn’t a permission.
                        </p>
                      </div>
                    </>
                  )}
                </div>
              )}
              {selectedPage && (
                <button
                  onClick={() => setRailCollapsed((v) => !v)}
                  title={railCollapsed ? "Show notes list" : "Hide notes list"}
                  className="p-1.5 rounded-lg hover:bg-black/5 text-[#8a8073] shrink-0 transition-colors"
                >
                  {railCollapsed ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
                </button>
              )}
            </div>

            {selectedPage ? (
              <>
                {/* Cosy document head — title/breadcrumb/byline. A sketch has
                    no title to read and no word count to show, so it skips
                    straight to the canvas instead of reserving this space. */}
                {selectedPage.kind !== "sketch" && (
                <div className={`w-full mx-auto px-6 sm:px-12 pt-7 shrink-0 transition-[max-width] duration-200 ${proseWide ? "max-w-[62rem]" : "max-w-[46rem]"}`}>
                  <div className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.12em] mb-3" style={{ color: boardAccent }}>
                    <span>{activeBoard === "mine" ? myName : activeBoard === "shared" ? "Shared with me" : boardLabelFor(department)}</span>
                    {selectedPageFolder && <><span className="opacity-40">/</span><span className="text-[#8a8073] truncate">{selectedPageFolder.name}</span></>}
                  </div>
                  <input
                    value={selectedPage.title}
                    onChange={(e) => renamePage(selectedPage.id, e.target.value)}
                    className="w-full outline-none bg-transparent font-display font-bold tracking-tight text-[#221f1a] placeholder:text-[#cdc5b7] leading-tight"
                    style={{ fontSize: "clamp(26px, 3.4vw, 34px)" }}
                    placeholder="Untitled note"
                  />
                  <div className="flex items-center gap-2.5 mt-3 mb-1 text-[12px] text-[#8a8073]">
                    <span className="w-6 h-6 rounded-full grid place-items-center text-[9px] font-black text-white shrink-0" style={{ backgroundColor: boardAccent }}>
                      {(activeBoard === "mine" ? (myName || "M") : boardLabelFor(department)).charAt(0)}
                    </span>
                    <span className="text-[#8a8073] font-semibold">Edited {timeAgo(pageLastSavedAt || selectedPage.updated_at)}</span>
                    <span className="w-1 h-1 rounded-full bg-[#d5cdbf]" />
                    <span className="tabular-nums">{wordCountOf(selectedPage)} words</span>
                    <PresenceStack awareness={collabProvider?.awareness} />
                  </div>
                </div>
                )}

                {selectedPage.kind === "sketch" ? (
                  <div className="flex-1 min-h-[640px]">
                    <Suspense fallback={<div className="h-full min-h-[640px] bg-[#faf7f2] animate-pulse" />}>
                      <ExcalidrawPageEditor
                        key={selectedPage.id}
                        pageId={selectedPage.id}
                        content={selectedPage.content}
                        onChange={(scene) => savePageContent(selectedPage.id, scene)}
                      />
                    </Suspense>
                  </div>
                ) : (
                  <RichNoteEditor
                    key={selectedPage.id}
                    content={selectedPage.content}
                    ydoc={selectedPage.ydoc}
                    collabRoom={NOTES_COLLAB ? selectedPage.id : null}
                    collabUser={collabUser}
                    fetchLatestYdoc={async () => {
                      // Authoritative read at editor mount — the local ydoc
                      // above is a snapshot from the page-list fetch, and
                      // trusting a stale one made this client seed a note a
                      // peer had already seeded (see CollaborativeNoteEditor).
                      const { data } = await supabase
                        .from("canvas_notes_pages")
                        .select("ydoc")
                        .eq("id", selectedPage.id)
                        .maybeSingle();
                      return data?.ydoc ?? null;
                    }}
                    onCollabReady={setCollabProvider}
                    onChange={(json, ydoc) => savePageContent(selectedPage.id, json, ydoc)}
                    accent={boardAccent}
                    wide={proseWide}
                    className={
                      railCollapsed
                        ? "min-h-[45vh] max-h-[60vh] overflow-y-auto pt-1 pb-8"
                        : "min-h-[320px] max-h-[600px] overflow-y-auto pt-1 pb-8"
                    }
                  />
                )}
              </>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-center py-16 px-6 gap-4">
                <div className="w-16 h-16 rounded-2xl flex items-center justify-center" style={{ backgroundColor: `${boardAccent}14`, color: boardAccent }}>
                  <FileText className="w-8 h-8" />
                </div>
                <div>
                  <p className="text-base font-bold text-[#221f1a]">A calm place to write</p>
                  <p className="text-[13px] font-medium text-[#8a8073] mt-1 max-w-[280px]">
                    Pick a note on the left, or start a new one and type <span className="font-mono font-bold text-[#3a352e]">/</span> for headings, checklists and more.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleNewNote("text")}
                    className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-white text-[13px] font-bold shadow-sm transition-[transform,box-shadow] hover:-translate-y-px hover:shadow-[0_10px_26px_-12px_rgba(18,32,39,0.22)] active:scale-95 focus-visible:ring-2 focus-visible:ring-[#c2410d]/40 focus-visible:outline-none"
                    style={{ background: `linear-gradient(135deg, ${boardAccent}, ${boardAccent}cc)` }}
                  >
                    <Plus className="w-4 h-4" /> New note
                  </button>
                  <button
                    onClick={() => handleNewNote("sketch")}
                    className="flex items-center gap-2 px-4 py-2.5 rounded-xl border text-[13px] font-bold transition-[transform,box-shadow] hover:-translate-y-px hover:shadow-[0_10px_26px_-12px_rgba(18,32,39,0.22)] active:scale-95 focus-visible:ring-2 focus-visible:ring-[#c2410d]/40 focus-visible:outline-none"
                    style={{ borderColor: `${boardAccent}55`, color: boardAccent }}
                  >
                    <PenTool className="w-4 h-4" /> New sketch
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
  );

  if (bare) return body;
  return (
    <CollapsibleCard
      icon={Folder}
      title="Notes Canvas"
      subtitle={`${department} team board · personal spaces`}
      isOpen={isOpen}
      onToggle={onToggle}
    >
      {body}
    </CollapsibleCard>
  );
}

const INITIAL_CAMPAIGNS = [];

// --- THE HARDCODED COVER ART DICTIONARY ---
const CAMPAIGN_COVERS = {
  // Hardcoded initial campaign IDs
  "camp-ody":
    "https://m.media-amazon.com/images/M/MV5BN2MyYjk2MWMtODMyZS00MDUyLWE0OGQtOTQ3MGY0MDE0ZjVmXkEyXkFqcGc@._V1_.jpg",
  "camp-sm6":
    "https://img1.wsimg.com/isteam/ip/d6a3e7a7-e920-4711-bf09-856dd846af78/SCARYMOVIE6.webp",

  // Dynamically imported Wrike campaign IDs
  "wrike-disclosure-day":
    "https://cdn.theplaylist.net/wp-content/uploads/2025/12/16114819/discloure-day.jpg",
  "wrike-passenger":
    "https://m.media-amazon.com/images/M/MV5BNjFhNmVjY2MtNjNjMy00MDIwLThiMjMtY2VkMGQwZmRjMTI4XkEyXkFqcGc@._V1_.jpg",
  "wrike-the-super-mario-galaxy-movie":
    "https://cdn.mos.cms.futurecdn.net/w3k25CThDiiTSZpD7QM8xD.jpg",
};

// --- HELPER: Generate a unique gradient based on campaign title ---
const generateGradient = (title) => {
  let hash = 0;
  for (let i = 0; i < title.length; i++) {
    hash = title.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h1 = Math.abs(hash % 360);
  const h2 = (h1 + 40) % 360;
  return `linear-gradient(135deg, hsl(${h1}, 80%, 65%), hsl(${h2}, 80%, 45%))`;
};

// --- STUDIO DETECTION ---
// Link-based detection: Universal and Paramount get their own section;
// everything else (Sony, Warner, Disney, Netflix…) collapses into Others.
const STUDIO_MAP = [
  { studio: "Universal", keywords: ["universal"] },
  { studio: "Paramount", keywords: ["paramount"] },
  { studio: "Others",    keywords: ["warner", "wbros", "wb", "sony", "columbia", "tristar", "disney", "marvel", "pixar", "lucasfilm", "netflix", "apple", "amazon", "mgm"] },
];
// Folder-tree detection (wrikeEnrich) may still return granular names like "Warner"
// or "Sony" — those are NOT in STUDIO_ORDER so the grouping logic maps them → Others.
const STUDIO_ORDER = ["Universal", "Paramount", "Others"];

// --- STUDIO COVER ART ---
const STUDIO_ART = {
  Universal: { label: "Universal Pictures", gradient: "linear-gradient(135deg,#06224f,#1f6fd0)", img: "https://static.wikia.nocookie.net/disney/images/7/76/Universal_logo_2013.jpg/revision/latest?cb=20201106121113", fit: "cover" },
  Paramount: { label: "Paramount Pictures", gradient: "linear-gradient(135deg,#0a3a8c,#3aa0ff)", img: "https://static.wikia.nocookie.net/nickelodeon/images/b/b8/Bandicam_2025-08-02_11-34-48-280.jpg/revision/latest?cb=20250804165010", fit: "cover" },
  Others:    { label: "Other Studios",      gradient: "linear-gradient(135deg,#1e293b,#475569)", img: "https://cdn.theplaylist.net/wp-content/uploads/2020/12/14182612/Sony-Pictures-Warner-Bros.jpg", fit: "cover" },
  Misc:      { label: "Miscellaneous",      gradient: "linear-gradient(135deg,#475569,#94a3b8)", img: "https://framerusercontent.com/images/2WndDWsxzrGcm0d0x7n1WYVw.png?width=3024&height=1672", fit: "cover" },
};

const detectStudio = (links = []) => {
  const combined = links
    .filter((l) => l.isAutoGenerated)
    .map((l) => l.url)
    .join(" ")
    .toLowerCase();
  if (!combined) return null;
  for (const { studio, keywords } of STUDIO_MAP) {
    if (keywords.some((k) => combined.includes(k))) return studio;
  }
  return null;
};

// --- HELPER: Markdown Parser for Notes ---
const parseFormatting = (text) => {
  if (!text) return "";
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>") // Bold
    .replace(/\*(.*?)\*/g, "<em>$1</em>") // Italic
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      // A class, not an inline colour: this HTML goes through
      // dangerouslySetInnerHTML, and an inline style is the one thing the dark
      // theme's class overrides can't reach. Styled in Timesheeter.css.
      '<a href="$2" target="_blank" rel="noopener noreferrer" class="rne-note-link">$1</a>'
    ) // Links
    .replace(/\n/g, "<br/>"); // Newlines
  return html;
};

// ---------------------------------------------------------------------------
// Reference > Launch Tracker (Print): per-launch-wave market delivery grid.
// Print coordinates each launch through a Wrike hub task ("*_Launch_Print_
// Requests" / "*_Launch_Markets") whose subtasks are the per-market requests
// ("AB3_INTL_Print_Teaser1SHT_Birds_CMYK_KR"). The hub description carries the
// job-folder paths, OV master links, the shared GD sheet and the per-market
// packaging checklist — all parsed into notesText by the sync (wrikeEnrich).
// ---------------------------------------------------------------------------

// Trailing market code from a per-market subtask title. Allows compound codes
// (NL-ENG, IN-HI) and template placeholders (MARKET).
const marketFromTitle = (title) => {
  const m = (title || "").match(/_([A-Za-z]{2,6}(?:-[A-Za-z]{2,4})?)$/);
  return m ? m[1].toUpperCase() : null;
};

// Hub titles come straight from Wrike as "ZAL_Print_Launch_Hub" etc — the
// film-code prefix isn't user-friendly. Replace it with the full film title
// from FILM_MAPPINGS when one exists; leave non-matching titles untouched.
const prettifyHubTitle = (rawTitle) => {
  if (!rawTitle) return "";
  const parts = rawTitle.split(/_/);
  const first = parts[0]?.toUpperCase();
  if (FILM_MAPPINGS[first]) {
    parts[0] = FILM_MAPPINGS[first];
    return parts.join(" ");
  }
  return rawTitle.replace(/_/g, " ");
};

// Wrike market codes that aren't ISO 3166 (or aren't a single country at all).
const MARKET_CODE_FIXUPS = { UK: "GB" };
const NON_COUNTRY_MARKETS = new Set(["MARKET", "LAS", "CIS", "INT", "INTL", "OV"]);
const marketFlagEmoji = (code) => {
  if (!code || NON_COUNTRY_MARKETS.has(code)) return "";
  const base = MARKET_CODE_FIXUPS[code] || code.split("-")[0];
  return /^[A-Z]{2}$/.test(base) ? codeToFlag(base) : "";
};

// Traffic-light bucket for a subtask's workflow status name.
const launchStatusStyle = (statusName) => {
  const s = (statusName || "").toLowerCase();
  if (/(complete|deliver|approved)/.test(s)) return { dot: "bg-[#1baf7a]", chip: "border-[#1baf7a]/30 bg-[#1baf7a]/5" };
  if (/(hold|defer)/.test(s))                return { dot: "bg-amber-400", chip: "border-amber-300/60 bg-amber-50" };
  if (/cancel/.test(s))                      return { dot: "bg-slate-300", chip: "border-slate-200 bg-slate-50 opacity-60" };
  return { dot: "bg-[#12a0e1]", chip: "border-[#12a0e1]/30 bg-[#12a0e1]/5" };
};
const isLaunchDone = (statusName) => /(complete|deliver)/i.test(statusName || "");

// Pull the reusable bits out of a hub's parsed description: server paths, the
// shared Google-Sheet tracker link, and the packaging-checklist tail.
const parseHubNotes = (notesText) => {
  const text = notesText || "";
  const gdLink = (text.match(/https:\/\/docs\.google\.com\/[^\s"']+/) || [])[0] || null;
  const paths = [...new Set(text.match(/\/Volumes\/[^\s"']+/g) || [])];
  const ckIdx = text.search(/PACKAGING\s*CHECKLIST/i);
  const checklist = ckIdx >= 0
    ? text.slice(ckIdx).split("\n").slice(1).map((l) => l.trim()).filter(Boolean)
    : [];
  return { gdLink, paths, checklist };
};

const wrikeTaskLink = (t) => t.permalink || `https://www.wrike.com/open.htm?id=${t.id}`;

// One chip per MARKET (not per subtask — digital waves carry several requests
// per market, and a wall of five separate DE chips read as noise). Aggregate
// status decides the chip's colour; multi-request markets show a done/total
// fraction and open a popover listing the individual Wrike tasks.
const aggregateChipStyle = (m) => {
  if (m.activeCount === 0)      return { chip: "border-slate-200 bg-slate-50 opacity-60", dot: "bg-slate-300" };   // all cancelled
  if (m.done === m.activeCount) return { chip: "border-[#1baf7a]/30 bg-[#1baf7a]/5",      dot: "bg-[#1baf7a]" };   // delivered
  if (m.allOnHold)              return { chip: "border-amber-300/60 bg-amber-50",          dot: "bg-amber-400" };   // parked
  return { chip: "border-[#12a0e1]/30 bg-[#12a0e1]/5", dot: "bg-[#12a0e1]" };                                      // in flight
};

function MarketChip({ market }) {
  const [open, setOpen] = useState(false);
  const style = aggregateChipStyle(market);
  const flag = marketFlagEmoji(market.code);
  const label = market.code === "MARKET" ? "Template" : market.code === "OTHER" ? "Other" : market.code;
  const single = market.items.length === 1;

  const face = (
    <>
      {flag ? (
        <CountryFlag flag={flag} imgClass="w-5 h-[14px]" textClass="text-[11px]" />
      ) : (
        <Globe className="w-3.5 h-3.5 text-[#768994]" />
      )}
      {label}
      {!single && (
        <span className="text-[10px] font-bold text-[#768994] tabular-nums">
          {market.done}/{market.activeCount || market.items.length}
        </span>
      )}
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${style.dot}`} />
    </>
  );

  // Single request → chip links straight to its Wrike task, same as before.
  if (single) {
    const { task, status } = market.items[0];
    return (
      <a
        href={wrikeTaskLink(task)}
        target="_blank"
        rel="noopener noreferrer"
        title={`${task.title} — ${status}`}
        className={`flex items-center gap-1.5 pl-1.5 pr-2 py-1 rounded-lg border text-[11px] font-black text-[#122027] hover:shadow-sm transition-shadow ${style.chip}`}
      >
        {face}
      </a>
    );
  }

  // Several requests behind one market → popover lists each as its own link.
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title={`${market.items.length} requests — click to list`}
        className={`flex items-center gap-1.5 pl-1.5 pr-2 py-1 rounded-lg border text-[11px] font-black text-[#122027] hover:shadow-sm transition-shadow ${style.chip}`}
      >
        {face}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute z-30 top-full left-0 mt-1.5 w-72 max-h-64 overflow-y-auto bg-white border border-[#dce4ec] rounded-xl shadow-xl p-1.5 space-y-0.5">
            {market.items.map(({ task, status }) => {
              const s = launchStatusStyle(status);
              return (
                <a
                  key={task.id}
                  href={wrikeTaskLink(task)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-50 transition-colors"
                >
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${s.dot}`} />
                  <span className="text-[11px] font-semibold text-[#122027] truncate flex-1">{task.title.replace(/_/g, " ")}</span>
                  <span className="text-[9px] font-bold text-[#768994] uppercase tracking-wide shrink-0">{status}</span>
                </a>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function LaunchHubCard({ hub, subs }) {
  const [expanded, setExpanded] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [copiedPath, setCopiedPath] = useState(null);
  const { gdLink, paths, checklist } = parseHubNotes(hub.notesText);

  // Group subtasks by market code; no-code strays pool into "OTHER" and
  // template placeholders (_MARKET) keep their own bucket. Alphabetical for
  // findability, Template and Other pinned last.
  const byCode = new Map();
  for (const s of subs) {
    const code = marketFromTitle(s.title) || "OTHER";
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push({ task: s, status: s.customStatusName || s.status || "" });
  }
  const markets = [...byCode.entries()]
    .map(([code, items]) => {
      const cancelled = items.filter((i) => /cancel/i.test(i.status)).length;
      const activeCount = items.length - cancelled;
      const done = items.filter((i) => isLaunchDone(i.status)).length;
      const allOnHold = activeCount > 0 && items.filter((i) => !/cancel/i.test(i.status)).every((i) => /(hold|defer)/i.test(i.status));
      return { code, items, done, activeCount, allOnHold };
    })
    .sort((a, b) => {
      const rank = (c) => (c === "OTHER" ? 2 : c === "MARKET" ? 1 : 0);
      return rank(a.code) - rank(b.code) || a.code.localeCompare(b.code);
    });

  // Header + progress speak in MARKETS (the unit Print thinks in), not raw
  // request-subtask counts: a market is done when every non-cancelled request
  // in it is delivered. All-cancelled markets drop out of the denominator.
  const countable = markets.filter((m) => m.code !== "MARKET" && m.activeCount > 0);
  const done = countable.filter((m) => m.done === m.activeCount).length;
  const totalRequests = subs.length;
  const pct = countable.length > 0 ? Math.round((done / countable.length) * 100) : 0;
  const allDone = done === countable.length && countable.length > 0;
  const onHoldCount = markets.filter((m) => m.allOnHold).length;
  const hasFlags = markets.some((m) => marketFlagEmoji(m.code));
  const previewFlags = markets.filter((m) => marketFlagEmoji(m.code)).slice(0, 4);
  const extraFlagCount = markets.filter((m) => marketFlagEmoji(m.code)).length - previewFlags.length;

  const copyPath = (p) => {
    navigator.clipboard?.writeText(p);
    setCopiedPath(p);
    setTimeout(() => setCopiedPath(null), 1500);
  };

  return (
    <div
      className={`group rounded-2xl border bg-white overflow-hidden transition-[border-color,box-shadow,background-color] duration-200 ${
        allDone ? "border-[#1baf7a]/30 bg-gradient-to-br from-[#1baf7a]/[0.04] to-white"
        : onHoldCount === countable.length && countable.length > 0 ? "border-amber-200"
        : "border-[#dce4ec] hover:border-[#12a0e1]/40 hover:shadow-sm"
      }`}
    >
      {/* Clickable header — collapsed shows everything scannable in one row */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={`w-full flex items-center gap-3 p-3.5 text-left ${expanded ? "pb-3" : ""}`}
      >
        {/* Progress ring — replaces the small "done/countable" text */}
        <span className="relative shrink-0 w-10 h-10 rounded-full flex items-center justify-center">
          <svg viewBox="0 0 36 36" className="absolute inset-0 w-full h-full -rotate-90">
            <circle cx="18" cy="18" r="15" fill="none" stroke="#eef1f5" strokeWidth="3.5" />
            {countable.length > 0 && (
              <circle
                cx="18" cy="18" r="15" fill="none" stroke={allDone ? "#1baf7a" : "#c2410d"} strokeWidth="3.5"
                strokeDasharray={`${(done / countable.length) * 94.25} 94.25`}
                strokeLinecap="round"
                className="transition-[stroke,stroke-dasharray] duration-500"
              />
            )}
          </svg>
          <span className={`relative text-[10px] font-black tabular-nums ${allDone ? "text-[#1baf7a]" : "text-[#122027]"}`}>
            {countable.length > 0 ? `${done}` : "--"}
          </span>
        </span>

        <span className="flex-1 min-w-0">
          {hub.projectName && (
            <span className="block text-[9px] font-black uppercase tracking-[0.15em] text-[#c2410d] truncate mb-0.5">{hub.projectName}</span>
          )}
          <span className="block text-sm font-black text-[#122027] truncate leading-tight">{prettifyHubTitle(hub.title)}</span>
          <span className="flex items-center gap-1.5 mt-0.5 flex-wrap">
            <span className="text-[10px] font-bold text-[#768994]">{hub.customStatusName || hub.status}</span>
            {countable.length > 0 && (
              <>
                <span className="text-[#dce4ec]">·</span>
                <span className={`text-[10px] font-black ${allDone ? "text-[#1baf7a]" : "text-[#122027]"}`}>
                  {done}/{countable.length} markets
                </span>
                {totalRequests > countable.length && (
                  <span className="text-[10px] font-semibold text-[#94a3b8]">· {totalRequests} requests</span>
                )}
              </>
            )}
            {onHoldCount > 0 && !allDone && (
              <span className="text-[10px] font-black text-amber-500">· {onHoldCount} on hold</span>
            )}
          </span>
        </span>

        {/* Compact flag preview — collapses the wall of chips into 4 + "N" */}
        {!expanded && hasFlags && (
          <span className="hidden sm:flex items-center -space-x-1.5 shrink-0">
            {previewFlags.map((m) => {
              const st = aggregateChipStyle(m);
              const flag = marketFlagEmoji(m.code);
              return (
                <span
                  key={m.code}
                  title={`${m.code} — ${m.done}/${m.activeCount} delivered`}
                  className={`relative w-7 h-5 rounded-md overflow-hidden ring-2 ring-white ${st.dot} flex items-center justify-center`}
                >
                  <CountryFlag flag={flag} imgClass="w-full h-full" textClass="text-[9px]" />
                </span>
              );
            })}
            {extraFlagCount > 0 && (
              <span className="relative w-7 h-5 rounded-md bg-slate-100 ring-2 ring-white flex items-center justify-center text-[9px] font-black text-[#768994] tabular-nums">
                +{extraFlagCount}
              </span>
            )}
          </span>
        )}

        <span className="flex items-center gap-1 shrink-0">
          <a
            href={wrikeTaskLink(hub)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            title="Open in Wrike"
            className="p-1.5 rounded-lg text-[#768994] hover:text-[#c2410d] hover:bg-slate-50 transition-colors inline-flex"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
          <ChevronRight className={`w-4 h-4 text-[#768994] transition-transform ${expanded ? "rotate-90" : ""}`} />
        </span>
      </button>

      {/* Expanded body — market chips + paths + checklist, slides in */}
      {expanded && (
        <div className="px-3.5 pb-3.5 space-y-3 animate-in fade-in slide-in-from-top-1 duration-200">
          {countable.length > 0 && (
            <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
              <div
                className={`h-full rounded-full transition-[width,background-color] duration-500 ${allDone ? "bg-[#1baf7a]" : "bg-gradient-to-r from-amber-500 to-orange-600"}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          )}

          {markets.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {markets.map((m) => (
                <MarketChip key={m.code} market={m} />
              ))}
            </div>
          ) : (
            <p className="text-[11px] font-bold text-[#94a3b8]">No market subtasks synced yet.</p>
          )}

          {(paths.length > 0 || gdLink || checklist.length > 0) && (
            <div className="pt-2 border-t border-[#eef1f5]">
              <div className="flex items-center gap-3">
                {(paths.length > 0 || checklist.length > 0) && (
                  <button
                    onClick={() => setShowDetails((v) => !v)}
                    className="flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-[#768994] hover:text-[#122027]"
                  >
                    <ChevronRight className={`w-3 h-3 transition-transform ${showDetails ? "rotate-90" : ""}`} />
                    Paths & checklist
                  </button>
                )}
                {gdLink && (
                  <a
                    href={gdLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-[#c2410d] hover:text-[#9a3412]"
                  >
                    <ExternalLink className="w-3 h-3" /> GD Sheet
                  </a>
                )}
              </div>
              {showDetails && (
                <div className="space-y-1.5 pt-2">
                  {paths.map((p) => (
                    <button
                      key={p}
                      onClick={() => copyPath(p)}
                      title="Copy path"
                      className="group flex items-center gap-1.5 max-w-full text-left"
                    >
                      {copiedPath === p
                        ? <Check className="w-3 h-3 shrink-0 text-[#1baf7a]" />
                        : <Copy className="w-3 h-3 shrink-0 text-[#94a3b8] group-hover:text-[#c2410d]" />}
                      <span className="text-[10px] font-semibold text-[#768994] group-hover:text-[#122027] truncate font-mono">{p}</span>
                    </button>
                  ))}
                  {checklist.length > 0 && (
                    <ul className="space-y-0.5 pl-1 pt-1">
                      {checklist.map((line, i) => (
                        <li key={i} className="text-[11px] font-semibold text-[#4b5c68] leading-snug">{line}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PrintLaunchTrackerCard({ isOpen, onToggle, hubs, taskById }) {
  // Hub subtasks that predate the widened sync filter aren't in the cache yet —
  // hydrate them straight from Wrike for display. Attempted ids are remembered
  // so tasks Wrike won't return don't trigger a refetch loop.
  const [extraSubs, setExtraSubs] = useState({});
  const attemptedRef = useRef(new Set());

  useEffect(() => {
    if (!isOpen) return;
    const missing = [];
    for (const hub of hubs) {
      for (const id of hub.subTaskIds || []) {
        if (!taskById.has(id) && !attemptedRef.current.has(id)) {
          attemptedRef.current.add(id);
          missing.push(id);
        }
      }
    }
    if (!missing.length) return;
    let alive = true;
    fetchTasksByIds(missing).then((list) => {
      if (!alive) return;
      if (!list.length) {
        // Whole fetch came back empty — a transient failure (rate limit,
        // expired session), not "these tasks don't exist". Unmark so the
        // next open/remount retries instead of writing the session off.
        missing.forEach((id) => attemptedRef.current.delete(id));
        return;
      }
      setExtraSubs((prev) => {
        const next = { ...prev };
        list.forEach((t) => { next[t.id] = t; });
        return next;
      });
    });
    return () => { alive = false; };
  }, [isOpen, hubs, taskById]);

  // Flat grid, freshest work first. Hubs whose own status is wrapped
  // (Delivered / Completed / Cancelled) are months-old campaigns — hidden by
  // default behind a toggle so the tracker opens on what's actually live.
  // The same bucket catches hubs whose Wrike status hasn't flipped yet but
  // every market IS delivered — those are work visually complete, just not
  //yet reflected in Wrike.
  const [showWrapped, setShowWrapped] = useState(false);
  const { active, wrapped } = useMemo(() => {
    const withSubs = hubs
      .map((hub) => ({
        hub,
        subs: (hub.subTaskIds || [])
          .map((id) => taskById.get(id) || extraSubs[id])
          .filter(Boolean),
      }))
      .sort((a, b) => (b.hub.updatedDate || "").localeCompare(a.hub.updatedDate || ""));

    // Status-rolled-up case: Wrike already says the whole hub is done.
    const hubStatusWrapped = ({ hub }) =>
      /(deliver|complete|cancel)/i.test(hub.customStatusName || hub.status || "");

    // A hub is "all-markets-done" when it has ≥1 countable market and every
    // one of those markets is fully delivered — guards against a null `subs`
    // or a no-market hub being misclassified as wrapped.
    const allMarketsDone = ({ subs }) => {
      if (!subs || subs.length === 0) return false;
      const byCode = new Map();
      for (const s of subs) {
        const code = marketFromTitle(s.title) || "OTHER";
        (byCode.has(code) ? byCode.get(code) : byCode.set(code, []).get(code)).push(s);
      }
      let countable = 0, done = 0;
      for (const [code, items] of byCode) {
        if (code === "MARKET") continue;
        const cancelled = items.filter((i) => /cancel/i.test(i.customStatusName || i.status || "")).length;
        const activeCount = items.length - cancelled;
        if (activeCount === 0) continue;
        countable++;
        if (items.filter((i) => isLaunchDone(i.customStatusName || i.status || "")).length === activeCount) done++;
      }
      return countable > 0 && done === countable;
    };

    const isWrapped = (h) => hubStatusWrapped(h) || allMarketsDone(h);
    return {
      active: withSubs.filter((h) => !isWrapped(h)),
      wrapped: withSubs.filter(isWrapped),
    };
  }, [hubs, taskById, extraSubs]);
  const visible = showWrapped ? [...active, ...wrapped] : active;

  return (
    <CollapsibleCard
      icon={Printer}
      title="Launch Tracker"
      subtitle={`Per-market print requests · ${active.length} live`}
      isOpen={isOpen}
      onToggle={onToggle}
    >
      {hubs.length === 0 ? (
        <p className="text-center text-sm font-bold text-[#768994] py-16">
          No launch hubs synced yet — hit Sync to pull Print requests from Wrike.
        </p>
      ) : (
        <div className="space-y-4">
          {wrapped.length > 0 && (
            <div className="flex justify-end">
              <button
                onClick={() => setShowWrapped((v) => !v)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-[10px] font-black uppercase tracking-widest transition-colors ${
                  showWrapped
                    ? "border-[#c2410d]/40 bg-[#c2410d]/5 text-[#c2410d]"
                    : "border-[#dce4ec] bg-white text-[#768994] hover:text-[#122027]"
                }`}
              >
                <Check className={`w-3 h-3 ${showWrapped ? "" : "opacity-30"}`} />
                Wrapped · {wrapped.length}
              </button>
            </div>
          )}
          {visible.length === 0 ? (
            <p className="text-center text-sm font-bold text-[#768994] py-10">
              Nothing live right now — {wrapped.length} wrapped launch{wrapped.length === 1 ? "" : "es"} hidden above.
            </p>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-4">
              {visible.map(({ hub, subs }) => (
                <LaunchHubCard key={hub.id} hub={hub} subs={subs} />
              ))}
            </div>
          )}
        </div>
      )}
    </CollapsibleCard>
  );
}

export default function CampaignCanvas({ wrikeData = [], folderCampaigns = [], triggerToast: _triggerToast, isLoading = false, syncNow, isSyncing = false, isAdmin = false, scanFilmMappings, isScanning = false, filmCodeMappings = {} }) {
  const triggerToast = _triggerToast ?? ((msg) => console.warn("Toast:", msg));
  // Same null-falls-back-to-Motion convention used everywhere else
  // department-gated (see src/lib/departments.js) — an unset profile
  // department behaves like Motion rather than showing nothing.
  const department = useDepartment() || "Motion";
  const [campaigns, setCampaigns] = useState(INITIAL_CAMPAIGNS);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedMatrix, setSelectedMatrix] = useState(null);
  const [showMappingsPanel, setShowMappingsPanel] = useState(false);

  const FILM_TABLE_COLS = [
    { key: "code",   label: "Code",      px: 140 },
    { key: "name",   label: "Film Name", px: 360 },
    { key: "source", label: "Source",    px: 140 },
  ];
  const { widths: filmWidths, resizeHandle: filmHandle } = useColumnResize("canvas-filmmap-cols", FILM_TABLE_COLS);

  // --- COMMAND PALETTE STATE ---
  const [isPaletteOpen, setIsPaletteOpen] = useState(false);
  const [paletteSearch, setPaletteSearch] = useState("");

  // --- ACCORDION ANIMATION & SCROLL STATE ---
  const [expandedCampId, setExpandedCampId] = useState(null);

  // Workspace vs. gallery. Default view is the two-column workspace (Notes +
  // Which tool is open, or null for none. Canvas hosts several independent
  // surfaces (campaigns, notes, launch tracker, DOOH specs) and stacking them
  // all in one scroll meant everything competed at once — the same reason
  // Management drills down rather than listing every section. Each gets the
  // full page, one at a time, with the switcher row always on top.
  //
  // Opens on Campaigns: the switcher alone over an empty page reads as a
  // page that failed to load, and the art-wall is what this page is for.
  // ...unless a shared note link brought us here, in which case opening on
  // Campaigns would hide the very page the link was for.
  const [canvasView, setCanvasView] = useState(() =>
    notePageIdFromHash() || eocCampaignIdFromHash() ? "notes" : "campaigns"
  );

  // An End of Campaign link, as { id, n }. The counter is what makes following
  // the SAME link twice work: the effect downstream keys on this object, and a
  // bare id would be unchanged the second time and do nothing — the same
  // reason focusFolder carries one.
  const [focusCampaign, setFocusCampaign] = useState(() => {
    const id = eocCampaignIdFromHash();
    return id ? { id, n: 0 } : null;
  });

  // Following a second link while already on this page changes only the hash,
  // so nothing would remount — switch to Notes on the hash change itself.
  useEffect(() => {
    const onHash = () => {
      if (notePageIdFromHash()) setCanvasView("notes");
      const eocId = eocCampaignIdFromHash();
      if (eocId) {
        setCanvasView("notes");
        setFocusCampaign((prev) => ({ id: eocId, n: (prev?.n || 0) + 1 }));
      }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const [collapsedStudios, setCollapsedStudios] = useState({}); // {studio: true} = folded
  // Notes "expand" → full page width: hides the campaigns panel + the notes rail.
  const [notesExpanded, setNotesExpanded] = useState(false);
  // The Notes Canvas browser folds away when you open a campaign in End of
  // Campaign Notes, the same collapsed-card idiom Management's AdminHub uses.
  // Its header row stays, so one click brings it back.
  const [notesBrowserOpen, setNotesBrowserOpen] = useState(true);
  // Stable identity: the card's link-following effect lists this in its deps,
  // and an inline arrow would give it a new one every render.
  const openCampaignNotes = useCallback(() => setNotesBrowserOpen(false), []);

  // --- SIDE PANEL STATE ---
  const [showFoldersPanel, setShowFoldersPanel] = useState(false);

  // --- Cover Art State (Persisted to Supabase so localStorage clears don't wipe it) ---
  const [covers, setCovers] = useState({});

  const [newCampaignTitle, setNewCampaignTitle] = useState("");
  const [newCampaignLink, setNewCampaignLink] = useState("");
  const [deletingCampId, setDeletingCampId] = useState(null);
  const [editingCampTitleId, setEditingCampTitleId] = useState(null);
  const [editCampTitleText, setEditCampTitleText] = useState("");

  // --- PINNED CAMPAIGNS ---
  const [pinnedIds, setPinnedIds] = useState([]);
  // Pinned notes topics (folders) live alongside campaigns on the shelf. Stored
  // as full folder objects ({id, name, owner_wrike_id, department}) so the shelf
  // can render + the child NotesCanvasCard can derive its own pinned-state.
  const [pinnedFolders, setPinnedFolders] = useState([]);
  // A pinned-topic card click asks the Notes panel to open that folder. Bumped
  // each click so the child re-focuses even when the same folder is re-clicked.
  const [focusFolder, setFocusFolder] = useState(null); // { id, n } | null

  // --- DOOH SPECS ---
  const [doohCountries, setDoohCountries] = useState([]);
  const [countryAssets, setCountryAssets] = useState({}); // { [countryId]: [asset] }
  const [selectedCountry, setSelectedCountry] = useState(null);
  const [isAddCountryOpen, setIsAddCountryOpen] = useState(false);
  const [newCountryName, setNewCountryName] = useState("");
  const [newCountryCode, setNewCountryCode] = useState("");
  const [countrySearch, setCountrySearch] = useState("");
  const [doohViewMode, setDoohViewMode] = useState(() => localStorage.getItem("dooh_view_mode") || "list");

  // --- REFERENCE SECTION: collapsible region groups + free-text note cards ---
  const [expandedRegions, setExpandedRegions] = useState(() => {
    try { return JSON.parse(localStorage.getItem("canvas_reference_expanded") || "{}"); } catch { return {}; }
  });
  const toggleRegion = (key) => {
    setExpandedRegions((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      localStorage.setItem("canvas_reference_expanded", JSON.stringify(next));
      return next;
    });
  };
  const setAllRegionsExpanded = (open) => {
    const keys = ["Pinned", ...REGION_ORDER];
    const next = Object.fromEntries(keys.map((k) => [k, open]));
    setExpandedRegions(next);
    localStorage.setItem("canvas_reference_expanded", JSON.stringify(next));
  };

  // --- Launch Tracker (Print): hub tasks + id lookup for their subtasks ---
  const taskById = useMemo(() => new Map(wrikeData.map((t) => [t.id, t])), [wrikeData]);
  const printLaunchHubs = useMemo(
    () => wrikeData.filter((t) => t.title && PRINT_HUB_RE.test(t.title)),
    [wrikeData]
  );
  const [uploadingCountry, setUploadingCountry] = useState(null);
  const [deletingAssetId, setDeletingAssetId] = useState(null);
  const [deletingCountryId, setDeletingCountryId] = useState(null);
  const countryFileInputRef = useRef(null);

  // Nested folders inside a country
  const [doohFolders, setDoohFolders] = useState([]); // { id, country_id, parent_id, name }
  const [currentFolderId, setCurrentFolderId] = useState(null); // null = country root
  const [isAddFolderOpen, setIsAddFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [deletingFolderId, setDeletingFolderId] = useState(null);
  const [editingSourceFolderId, setEditingSourceFolderId] = useState(null);
  const [editSourceText, setEditSourceText] = useState("");
  const [previewAsset, setPreviewAsset] = useState(null); // image/PDF lightbox
  const [previewList, setPreviewList] = useState([]);      // siblings to flick through

  const isPdfAsset = (a) => /\.pdf($|\?)/i.test(a?.name || a?.url || "");
  const openPreview = (asset, list = []) => {
    if (asset.type === "image" || isPdfAsset(asset)) {
      setPreviewList(list);
      setPreviewAsset(asset);
    } else {
      window.open(asset.url, "_blank", "noopener");
    }
  };
  const previewIndex = previewAsset ? previewList.findIndex((a) => a.id === previewAsset.id) : -1;

  const [editingNote, setEditingNote] = useState({
    campId: null,
    noteId: null,
  });
  const [editNoteText, setEditNoteText] = useState("");
  const [addingNoteCampId, setAddingNoteCampId] = useState(null);
  const [newNoteText, setNewNoteText] = useState("");

  const [editingLink, setEditingLink] = useState({
    campId: null,
    linkId: null,
  });
  const [editLinkTitle, setEditLinkTitle] = useState("");
  const [editLinkUrl, setEditLinkUrl] = useState("");

  const [linkModalCampId, setLinkModalCampId] = useState(null);
  const [newLinkTitle, setNewLinkTitle] = useState("");
  const [newLinkUrl, setNewLinkUrl] = useState("");
  const [copiedLinkId, setCopiedLinkId] = useState(null);

  // Load covers + manual campaigns from Supabase on mount
  useEffect(() => {
    (async () => {
      const { data: coverData } = await supabase.from("canvas_covers").select("covers").eq("id", 1).single();
      if (coverData?.covers) setCovers(coverData.covers);

      const { data: manualData } = await supabase.from("canvas_manual_campaigns").select("*");
      if (manualData?.length) {
        setCampaigns((prev) => {
          const existing = new Set(prev.map((c) => c.id));
          const toAdd = manualData
            .filter((r) => !existing.has(r.id))
            .map((r) => ({
              id: r.id,
              title: r.title,
              wrikeLink: r.wrike_link || "#",
              notes: [],
              matrices: [],
              links: [],
              isManual: true,
            }));
          return toAdd.length ? [...prev, ...toAdd] : prev;
        });
      }

      // Pinned campaigns
      const { data: pinData } = await supabase.from("canvas_pinned_campaigns").select("campaign_id");
      if (pinData?.length) setPinnedIds(pinData.map((r) => r.campaign_id));

      // Pinned notes topics (folders) — joined with folder detail so the shelf
      // can render them (name + which board they belong to) without a second
      // round-trip. Stale pins auto-drop via the FK's ON DELETE CASCADE.
      const { data: pinNoteData } = await supabase
        .from("canvas_pinned_notes")
        .select("folder_id, canvas_notes_folders(id, name, owner_wrike_id, department)");
      if (pinNoteData?.length) {
        setPinnedFolders(pinNoteData.map((r) => r.canvas_notes_folders).filter(Boolean));
      }

      // DOOH Specs — countries + their assets
      const { data: countryData } = await supabase
        .from("dooh_countries")
        .select("*")
        .order("created_at", { ascending: true });
      if (countryData?.length) setDoohCountries(countryData);

      const { data: assetData } = await supabase
        .from("dooh_assets")
        .select("*")
        .order("created_at", { ascending: true });
      if (assetData?.length) {
        const byCountry = {};
        assetData.forEach((a) => {
          (byCountry[a.country_id] ||= []).push(a);
        });
        setCountryAssets(byCountry);
      }

      const { data: folderData } = await supabase
        .from("dooh_folders")
        .select("*")
        .order("created_at", { ascending: true });
      if (folderData?.length) setDoohFolders(folderData);
    })();
  }, []);

  // Save covers to Supabase whenever they change
  const saveCoverRef = useRef(null);
  const linksLoadedRef = useRef(false);
  const metaLoadedRef = useRef(false);

  // --- STUDIO OVERRIDE STATE ---
  const [studioOverrides, setStudioOverrides] = useState({});
  const [studioPickerCampId, setStudioPickerCampId] = useState(null);
  // Which studio is currently drilled-into (null = show the studio gallery)
  const [selectedStudio, setSelectedStudio] = useState(null);
  useEffect(() => {
    if (Object.keys(covers).length === 0) return;
    clearTimeout(saveCoverRef.current);
    saveCoverRef.current = setTimeout(async () => {
      await supabase.from("canvas_covers").upsert({ id: 1, covers });
    }, 500);
  }, [covers]);

  // --- GLOBAL KEYBOARD LISTENER (CMD+K) ---
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setIsPaletteOpen((prev) => !prev);
      }
      if (e.key === "Escape") {
        setIsPaletteOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    if (!isPaletteOpen) setPaletteSearch("");
  }, [isPaletteOpen]);

  // --- ESCAPE KEY TO CLOSE CAMPAIGN MODAL ---
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") setExpandedCampId(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // --- KEYBOARD CONTROLS FOR FILE PREVIEW (Esc / ← / →) ---
  useEffect(() => {
    if (!previewAsset) return;
    const onKey = (e) => {
      if (e.key === "Escape") return setPreviewAsset(null);
      const i = previewList.findIndex((a) => a.id === previewAsset.id);
      if (e.key === "ArrowLeft" && i > 0) setPreviewAsset(previewList[i - 1]);
      if (e.key === "ArrowRight" && i >= 0 && i < previewList.length - 1) setPreviewAsset(previewList[i + 1]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewAsset, previewList]);

  useEffect(() => {
    if (!wrikeData || wrikeData.length === 0) return;

    const wrikeGroupedCampaigns = {};

    wrikeData.forEach((task) => {
      // The studio gallery is MATRIX-only. wrikeData also carries Print launch
      // hubs + their per-market subtasks now (for the Launch Tracker card), and
      // those must NOT be grouped into campaign/studio cards — the Launch
      // Tracker reads them through its own derivation. Skip anything that isn't
      // a MATRIX so the gallery keeps showing only the crafted matrices.
      if (!task.title?.toUpperCase().includes("MATRIX")) return;

      let campaignTitle = task.projectName;

      // --- BULLETPROOF CAMPAIGN TITLE EXTRACTOR ---
      if (!campaignTitle || campaignTitle === "Unknown Project") {
        // 1. Try to extract the movie name from the folder path (e.g. .../Disclosure Day/Digital/...)
        if (task.extractedPathData) {
          const pathParts = task.extractedPathData.split("/");
          const digitalIndex = pathParts.findIndex(
            (p) => p.toUpperCase() === "DIGITAL"
          );
          if (digitalIndex > 0) {
            campaignTitle = pathParts[digitalIndex - 1];
          }
        }

        // 2. If still missing, guess from the acronym in the title
        if (!campaignTitle || campaignTitle.trim() === "") {
          const prefix = task.title.split("_")[0].toUpperCase();
          if (prefix === "DDA") campaignTitle = "Disclosure Day";
          else if (prefix === "ODY") campaignTitle = "The Odyssey";
          else if (prefix === "SCRY") campaignTitle = "Scary Movie 6";
          else campaignTitle = task.title.split(/[-_]/)[0] || "Unknown Project";
        }
      }

      // Clean up any weird URL encoding or underscores
      campaignTitle = decodeURIComponent(campaignTitle)
        .replace(/_/g, " ")
        .trim();

      if (!wrikeGroupedCampaigns[campaignTitle]) {
        wrikeGroupedCampaigns[campaignTitle] = {
          id: `wrike-${campaignTitle.toLowerCase().replace(/\s+/g, "-")}`,
          title: campaignTitle,
          wrikeLink: task.permalink || `https://www.wrike.com/open.htm?id=${task.id}`,
          notes: [],
          matrices: [],
          links: [],
          lastMatrixUpdate: 0,
          // A campaign is live while any of its MATRIX tasks is still open in
          // Wrike. Age is the wrong test — three campaigns marked Delivered
          // were edited today, and a genuinely active one can sit untouched
          // for a fortnight — so this reads Wrike's own status instead.
          isLive: false,
          studioHint: task.studioName || null,
        };
      } else if (!wrikeGroupedCampaigns[campaignTitle].studioHint && task.studioName) {
        wrikeGroupedCampaigns[campaignTitle].studioHint = task.studioName;
      }

      // Wrike's own lifecycle field, not the workflow label: customStatusName
      // is per-workflow free text ("Delivered", "Motion", "Completed"), while
      // `status` is the fixed Active/Completed/Deferred/Cancelled underneath.
      if (task.status !== "Completed" && task.status !== "Cancelled") {
        wrikeGroupedCampaigns[campaignTitle].isLive = true;
      }

      const tableHtml = task.tableHtml || "";
      const notesText = task.notesText || "";
      const extractedPath = task.extractedPathData || "";

      const finalNoteText =
        notesText || `Connected Matrix Asset: ${task.title}`;
      if (
        !wrikeGroupedCampaigns[campaignTitle].notes.some(
          (n) => n.text === finalNoteText
        )
      ) {
        wrikeGroupedCampaigns[campaignTitle].notes.push({
          id: `note-wrike-${task.id}`,
          text: finalNoteText,
          isAutoGenerated: true,
        });
      }

      if (extractedPath) {
        const paths = extractedPath
          .split(" ")
          .filter((p) => p.includes("/VOLUMES/"));
        paths.forEach((pathStr, index) => {
          if (
            !wrikeGroupedCampaigns[campaignTitle].links.some(
              (l) => l.url === pathStr
            )
          ) {
            const parts = pathStr.split("/").filter(Boolean);
            const last2 = parts.slice(-2).map((s) => decodeURIComponent(s).replace(/_/g, " ")).join(" / ");
            wrikeGroupedCampaigns[campaignTitle].links.push({
              id: `link-auto-${task.id}-${index}`,
              title: last2 || pathStr,
              url: pathStr,
              isAutoGenerated: true,
            });
          }
        });
      }

      if (
        tableHtml &&
        !wrikeGroupedCampaigns[campaignTitle].matrices.some(
          (m) => m.id === task.id
        )
      ) {
        wrikeGroupedCampaigns[campaignTitle].matrices.push({
          id: task.id,
          title: task.title,
          tableHtml: tableHtml,
        });
        const taskTs = task.updatedDate ? new Date(task.updatedDate).getTime() : 0;
        if (taskTs > wrikeGroupedCampaigns[campaignTitle].lastMatrixUpdate) {
          wrikeGroupedCampaigns[campaignTitle].lastMatrixUpdate = taskTs;
        }
      }
    });

    setCampaigns((prevCampaigns) => {
      const updatedList = [...prevCampaigns];

      Object.values(wrikeGroupedCampaigns).forEach((wrikeCamp) => {
        const existingIndex = updatedList.findIndex(
          (c) => c.title.toLowerCase() === wrikeCamp.title.toLowerCase()
        );

        if (existingIndex > -1) {
          const existingNotes = updatedList[existingIndex].notes || [];
          wrikeCamp.notes.forEach((newNote) => {
            if (!existingNotes.some((en) => en.text === newNote.text)) {
              existingNotes.push(newNote);
            }
          });
          updatedList[existingIndex].notes = existingNotes;

          const existingLinks = updatedList[existingIndex].links || [];
          wrikeCamp.links.forEach((newLink) => {
            if (!existingLinks.some((el) => el.url === newLink.url)) {
              existingLinks.push(newLink);
            }
          });
          updatedList[existingIndex].links = existingLinks;

          updatedList[existingIndex].matrices = wrikeCamp.matrices;
          if (updatedList[existingIndex].wrikeLink === "#") {
            updatedList[existingIndex].wrikeLink = wrikeCamp.wrikeLink;
          }
          // Always accept a non-null studioHint from the latest wrikeData pass.
          // The first pass often has studioName=null (backfill hasn't run yet);
          // subsequent passes carry the backfilled value and must update the camp.
          if (wrikeCamp.studioHint) {
            updatedList[existingIndex].studioHint = wrikeCamp.studioHint;
          }
          // Recomputed from this pass, never OR'd with the stored value — a
          // campaign that has since been delivered has to be able to go back
          // to not-live, which is the whole point.
          updatedList[existingIndex].isLive = wrikeCamp.isLive;
          updatedList[existingIndex].lastMatrixUpdate = wrikeCamp.lastMatrixUpdate;
        } else {
          updatedList.push(wrikeCamp);
        }
      });

      return updatedList;
    });
  }, [wrikeData]);

  // --- MERGE FOLDER-BASED CAMPAIGNS (Warner Bros / Sony) ---
  useEffect(() => {
    if (!folderCampaigns.length) return;
    setCampaigns((prev) => {
      const map = new Map(prev.map((c) => [c.id, c]));
      folderCampaigns.forEach((fc) => {
        if (!map.has(fc.id)) {
          map.set(fc.id, fc);
        } else {
          // Keep existing data but refresh studioHint if not overridden
          const existing = map.get(fc.id);
          if (!existing.studioHint) map.set(fc.id, { ...existing, studioHint: "Others" });
        }
      });
      return [...map.values()];
    });
  }, [folderCampaigns]);

  // --- LOAD PERSISTED LINKS FROM SUPABASE ---
  useEffect(() => {
    if (!campaigns.length || linksLoadedRef.current) return;
    linksLoadedRef.current = true;
    (async () => {
      const { data } = await supabase.from("campaign_links").select("*");
      if (!data?.length) return;
      const map = {};
      data.forEach((r) => {
        if (!map[r.campaign_id]) map[r.campaign_id] = [];
        map[r.campaign_id].push({ id: r.id, title: r.title, url: r.url, fromDb: true });
      });
      setCampaigns((prev) =>
        prev.map((camp) => ({
          ...camp,
          links: [
            ...(camp.links || []).filter((l) => !l.fromDb),
            ...(map[camp.id] || []),
          ],
        }))
      );
    })();
  }, [campaigns]);

  // --- LOAD STUDIO OVERRIDES FROM SUPABASE ---
  useEffect(() => {
    if (!campaigns.length || metaLoadedRef.current) return;
    metaLoadedRef.current = true;
    (async () => {
      const { data } = await supabase.from("campaign_meta").select("campaign_id, studio");
      if (!data?.length) return;
      const map = {};
      data.forEach((r) => { map[r.campaign_id] = r.studio; });
      setStudioOverrides(map);
    })();
  }, [campaigns]);

  // --- COMMAND PALETTE SEARCH ENGINE WITH ACTIONS ---
  const paletteResults = React.useMemo(() => {
    if (!paletteSearch.trim()) return [];
    const query = paletteSearch.toLowerCase();
    const results = [];

    const globalActions = [
      {
        id: "action-new",
        title: "Create New Campaign",
        matchType: "Action",
        icon: Plus,
      },
      {
        id: "action-copy",
        title: "Copy Canvas JSON to Clipboard",
        matchType: "Action",
        icon: Copy,
      },
      {
        id: "action-dark",
        title: "Toggle Dark Theme",
        matchType: "Action",
        icon: Moon,
      },
      {
        id: "action-sync",
        title: "Trigger API Sync",
        matchType: "Action",
        icon: Zap,
      },
    ];

    globalActions.forEach((action) => {
      if (action.title.toLowerCase().includes(query)) {
        results.push(action);
      }
    });

    campaigns.forEach((camp) => {
      let matched = false;
      let matchType = "";

      if (camp.title.toLowerCase().includes(query)) {
        matched = true;
        matchType = "Found in Title";
      } else if (camp.notes.some((n) => n.text.toLowerCase().includes(query))) {
        matched = true;
        matchType = "Found in Notes";
      } else if (
        camp.links.some(
          (l) =>
            l.title.toLowerCase().includes(query) ||
            l.url.toLowerCase().includes(query)
        )
      ) {
        matched = true;
        matchType = "Found in Folder Links";
      }

      if (matched) {
        results.push({ ...camp, matchType });
      }
    });

    return results;
  }, [paletteSearch, campaigns]);

  const handleSelectPaletteResult = (result) => {
    setIsPaletteOpen(false);
    setPaletteSearch("");

    if (result.matchType === "Action") {
      if (result.id === "action-new") setIsModalOpen(true);
      if (result.id === "action-copy") {
        navigator.clipboard.writeText(JSON.stringify(campaigns, null, 2));
        triggerToast("Canvas data copied to clipboard!", "success");
      }
      if (result.id === "action-dark") {
        toggleDarkMode();
      }
      if (result.id === "action-sync") {
        triggerToast("Wrike Sync triggered! (Placeholder)");
      }
      return;
    }

    handleToggleCamp(result.id);
  };

  // --- REBUILT "BREATHE" ACCORDION TOGGLE (WITH ANCHORING) ---
  const handleToggleCamp = (id) => {
    setExpandedCampId((prev) => (prev === id ? null : id));
    setShowFoldersPanel(false);
    setStudioPickerCampId(null);
  };

  const activeCamp = expandedCampId ? campaigns.find((c) => c.id === expandedCampId) : null;
  const activeCover = activeCamp ? covers[activeCamp.id] || CAMPAIGN_COVERS[activeCamp.id] : null;

  const handleSaveNewCampaign = async () => {
    if (!newCampaignTitle.trim()) return;
    const id = `camp-${Date.now()}`;
    const newCampaign = {
      id,
      title: newCampaignTitle.trim(),
      wrikeLink: newCampaignLink || "#",
      notes: [],
      matrices: [],
      links: [],
      isManual: true,
    };
    setCampaigns((prev) => [...prev, newCampaign]);
    await supabase.from("canvas_manual_campaigns").insert({
      id,
      title: newCampaign.title,
      wrike_link: newCampaign.wrikeLink,
    });
    handleCloseModal();
  };

  const handleRenameCampaign = async (campId, newTitle) => {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    setCampaigns((prev) => prev.map((c) => c.id === campId ? { ...c, title: trimmed } : c));
    setEditingCampTitleId(null);
    await supabase.from("canvas_manual_campaigns").update({ title: trimmed }).eq("id", campId);
  };

  const handleDeleteCampaign = async (campId) => {
    setCampaigns((prev) => prev.filter((c) => c.id !== campId));
    setExpandedCampId(null);
    setDeletingCampId(null);
    await supabase.from("canvas_manual_campaigns").delete().eq("id", campId);
  };

  // --- PIN / UNPIN ---
  const togglePin = async (campId) => {
    const isPinned = pinnedIds.includes(campId);
    setPinnedIds((prev) => (isPinned ? prev.filter((id) => id !== campId) : [...prev, campId]));
    if (isPinned) {
      await supabase.from("canvas_pinned_campaigns").delete().eq("campaign_id", campId);
    } else {
      await supabase.from("canvas_pinned_campaigns").insert({ campaign_id: campId });
    }
  };

  // Pin/unpin a Notes topic (folder). Takes the whole folder object so the
  // shelf has the detail it needs the moment it's pinned (no refetch). Called
  // from NotesCanvasCard's topic rows via the onTogglePin prop.
  const toggleNotePin = async (folder) => {
    if (!folder?.id) return;
    const isPinned = pinnedFolders.some((f) => f.id === folder.id);
    setPinnedFolders((prev) =>
      isPinned ? prev.filter((f) => f.id !== folder.id) : [...prev, folder]
    );
    if (isPinned) {
      await supabase.from("canvas_pinned_notes").delete().eq("folder_id", folder.id);
    } else {
      await supabase.from("canvas_pinned_notes").insert({ folder_id: folder.id });
    }
  };

  // --- DOOH SPECS HANDLERS ---
  const handleAddCountry = async () => {
    const name = newCountryName.trim();
    if (!name) return;
    const id = `country-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now().toString(36)}`;
    const flag = codeToFlag(newCountryCode) || "🌐";
    const country = { id, name, flag };
    setDoohCountries((prev) => [...prev, country]);
    setNewCountryName("");
    setNewCountryCode("");
    setIsAddCountryOpen(false);
    await supabase.from("dooh_countries").insert(country);
  };

  const setViewMode = (mode) => {
    setDoohViewMode(mode);
    localStorage.setItem("dooh_view_mode", mode);
  };

  const togglePinCountry = async (country) => {
    const next = !country.pinned;
    setDoohCountries((prev) => prev.map((c) => (c.id === country.id ? { ...c, pinned: next } : c)));
    await supabase.from("dooh_countries").update({ pinned: next }).eq("id", country.id);
  };

  const handleDeleteCountry = async (countryId) => {
    const assets = countryAssets[countryId] || [];
    setDoohCountries((prev) => prev.filter((c) => c.id !== countryId));
    setCountryAssets((prev) => {
      const next = { ...prev };
      delete next[countryId];
      return next;
    });
    setDoohFolders((prev) => prev.filter((f) => f.country_id !== countryId));
    setSelectedCountry(null);
    setCurrentFolderId(null);
    setDeletingCountryId(null);
    // Remove stored files, then the rows
    const paths = assets.map((a) => a.storage_path).filter(Boolean);
    if (paths.length) await supabase.storage.from("dooh-specs").remove(paths);
    await supabase.from("dooh_assets").delete().eq("country_id", countryId);
    await supabase.from("dooh_folders").delete().eq("country_id", countryId);
    await supabase.from("dooh_countries").delete().eq("id", countryId);
  };

  // --- DOOH FOLDERS ---
  const handleAddFolder = async () => {
    const name = newFolderName.trim();
    if (!name || !selectedCountry) return;
    const id = `folder-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const folder = { id, country_id: selectedCountry, parent_id: currentFolderId, name };
    setDoohFolders((prev) => [...prev, folder]);
    setNewFolderName("");
    setIsAddFolderOpen(false);
    await supabase.from("dooh_folders").insert(folder);
  };

  // Save the source path for the node currently being viewed:
  // the current folder, or the country itself when at the root.
  const handleSaveSource = async (value) => {
    const v = value.trim();
    setEditingSourceFolderId(null);
    if (currentFolderId) {
      setDoohFolders((prev) => prev.map((f) => (f.id === currentFolderId ? { ...f, source_path: v || null } : f)));
      await supabase.from("dooh_folders").update({ source_path: v || null }).eq("id", currentFolderId);
    } else if (selectedCountry) {
      setDoohCountries((prev) => prev.map((c) => (c.id === selectedCountry ? { ...c, source_path: v || null } : c)));
      await supabase.from("dooh_countries").update({ source_path: v || null }).eq("id", selectedCountry);
    }
  };

  const handleDeleteFolder = async (folderId) => {
    // Collect the folder and every descendant folder
    const toDelete = new Set([folderId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const f of doohFolders) {
        if (f.parent_id && toDelete.has(f.parent_id) && !toDelete.has(f.id)) {
          toDelete.add(f.id);
          changed = true;
        }
      }
    }
    const folderIds = [...toDelete];
    const assetsToDelete = Object.values(countryAssets)
      .flat()
      .filter((a) => a.folder_id && toDelete.has(a.folder_id));

    setDoohFolders((prev) => prev.filter((f) => !toDelete.has(f.id)));
    setCountryAssets((prev) => {
      const next = {};
      for (const [cid, list] of Object.entries(prev)) {
        next[cid] = list.filter((a) => !(a.folder_id && toDelete.has(a.folder_id)));
      }
      return next;
    });
    setDeletingFolderId(null);
    // If we're currently inside a folder being removed, climb to its parent
    if (currentFolderId && toDelete.has(currentFolderId)) {
      const f = doohFolders.find((x) => x.id === folderId);
      setCurrentFolderId(f?.parent_id || null);
    }

    const paths = assetsToDelete.map((a) => a.storage_path).filter(Boolean);
    if (paths.length) await supabase.storage.from("dooh-specs").remove(paths);
    if (assetsToDelete.length) await supabase.from("dooh_assets").delete().in("id", assetsToDelete.map((a) => a.id));
    await supabase.from("dooh_folders").delete().in("id", folderIds);
  };

  const handleUploadFiles = async (countryId, fileList, folderId = null) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setUploadingCountry(countryId);
    for (const file of files) {
      try {
        const ext = file.name.includes(".") ? file.name.split(".").pop() : "bin";
        const id = `asset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const path = `${countryId}/${folderId || "root"}/${id}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from("dooh-specs")
          .upload(path, file, { cacheControl: "3600", upsert: false });
        if (upErr) {
          triggerToast(`Upload failed: ${upErr.message}`);
          continue;
        }
        const { data: pub } = supabase.storage.from("dooh-specs").getPublicUrl(path);
        const type = file.type.startsWith("image/") ? "image" : "document";
        const asset = { id, country_id: countryId, folder_id: folderId, type, name: file.name, url: pub.publicUrl, storage_path: path };
        await supabase.from("dooh_assets").insert(asset);
        setCountryAssets((prev) => ({ ...prev, [countryId]: [...(prev[countryId] || []), asset] }));
      } catch (err) {
        triggerToast(`Upload error: ${err.message}`);
      }
    }
    setUploadingCountry(null);
  };

  const handleDeleteAsset = async (asset) => {
    setCountryAssets((prev) => ({
      ...prev,
      [asset.country_id]: (prev[asset.country_id] || []).filter((a) => a.id !== asset.id),
    }));
    setDeletingAssetId(null);
    if (asset.storage_path) await supabase.storage.from("dooh-specs").remove([asset.storage_path]);
    await supabase.from("dooh_assets").delete().eq("id", asset.id);
  };

  const handleCloseModal = () => {
    setNewCampaignTitle("");
    setNewCampaignLink("");
    setIsModalOpen(false);
  };

  const handleFormat = (type, textState, setTextState, inputId) => {
    const textarea = document.getElementById(inputId);
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selectedText = textState.substring(start, end);
    let before = textState.substring(0, start);
    let after = textState.substring(end);

    let prefix = "";
    let suffix = "";

    if (type === "bold") {
      prefix = "**";
      suffix = "**";
    }
    if (type === "italic") {
      prefix = "*";
      suffix = "*";
    }
    if (type === "link") {
      const url = prompt("Enter link URL:");
      if (!url) return;
      prefix = "[";
      suffix = `](${url})`;
    }

    const defaultText =
      selectedText || (type === "link" ? "link text" : "text");
    const newText = before + prefix + defaultText + suffix + after;

    setTextState(newText);

    setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(
        start + prefix.length,
        start + prefix.length + defaultText.length
      );
    }, 0);
  };

  const handleAddNote = (campId) => {
    if (!newNoteText.trim()) return;
    setCampaigns((prev) =>
      prev.map((camp) => {
        if (camp.id === campId) {
          return {
            ...camp,
            notes: [
              ...(camp.notes || []),
              { id: `note-${Date.now()}`, text: newNoteText },
            ],
          };
        }
        return camp;
      })
    );
    setNewNoteText("");
    setAddingNoteCampId(null);
  };

  const handleDeleteNote = (campId, noteId) => {
    setCampaigns((prev) =>
      prev.map((camp) => {
        if (camp.id === campId) {
          return { ...camp, notes: camp.notes.filter((n) => n.id !== noteId) };
        }
        return camp;
      })
    );
  };

  const startEditing = (campId, note, text) => {
    setEditingNote({ campId, noteId: note.id });
    setEditNoteText(text);
  };

  const handleSaveEdit = (campId, noteId) => {
    if (!editNoteText.trim()) return;
    setCampaigns((prev) =>
      prev.map((camp) => {
        if (camp.id === campId) {
          return {
            ...camp,
            notes: camp.notes.map((n) =>
              n.id === noteId ? { ...n, text: editNoteText } : n
            ),
          };
        }
        return camp;
      })
    );
    setEditingNote({ campId: null, noteId: null });
  };

  const handleAddLink = async (campId) => {
    if (!newLinkTitle.trim() || !newLinkUrl.trim()) return;
    const { data } = await supabase
      .from("campaign_links")
      .insert({ campaign_id: campId, title: newLinkTitle, url: newLinkUrl })
      .select()
      .single();
    const newLink = {
      id: data?.id || `link-${Date.now()}`,
      title: newLinkTitle,
      url: newLinkUrl,
      fromDb: !!data,
    };
    setCampaigns((prev) =>
      prev.map((camp) =>
        camp.id === campId
          ? { ...camp, links: [...(camp.links || []), newLink] }
          : camp
      )
    );
    setNewLinkTitle("");
    setNewLinkUrl("");
  };
  const startEditingLink = (campId, link) => {
    setEditingLink({ campId, linkId: link.id });
    setEditLinkTitle(link.title);
    setEditLinkUrl(link.url);
  };

  const handleSaveEditLink = async (campId, linkId) => {
    if (!editLinkTitle.trim() || !editLinkUrl.trim()) return;
    const camp = campaigns.find((c) => c.id === campId);
    const link = camp?.links?.find((l) => l.id === linkId);
    if (link?.fromDb) {
      await supabase
        .from("campaign_links")
        .update({ title: editLinkTitle, url: editLinkUrl })
        .eq("id", linkId);
    }
    setCampaigns((prev) =>
      prev.map((camp) =>
        camp.id === campId
          ? {
              ...camp,
              links: (camp.links || []).map((l) =>
                l.id === linkId ? { ...l, title: editLinkTitle, url: editLinkUrl } : l
              ),
            }
          : camp
      )
    );
    setEditingLink({ campId: null, linkId: null });
  };

  const cancelEditingLink = () => {
    setEditingLink({ campId: null, linkId: null });
  };
  const handleDeleteLink = async (campId, linkId) => {
    const camp = campaigns.find((c) => c.id === campId);
    const link = camp?.links?.find((l) => l.id === linkId);
    if (link?.fromDb) {
      await supabase.from("campaign_links").delete().eq("id", linkId);
    }
    setCampaigns((prev) =>
      prev.map((camp) =>
        camp.id === campId
          ? { ...camp, links: (camp.links || []).filter((l) => l.id !== linkId) }
          : camp
      )
    );
  };

  const handleCopyLink = (url, linkId) => {
    navigator.clipboard.writeText(url);
    setCopiedLinkId(linkId);
    setTimeout(() => setCopiedLinkId(null), 2000);
  };

  const handleSetStudio = async (campId, studio) => {
    setStudioOverrides((prev) => ({ ...prev, [campId]: studio }));
    setStudioPickerCampId(null);
    await supabase
      .from("campaign_meta")
      .upsert({ campaign_id: campId, studio });
  };

  const handleUpdateCover = (campId) => {
    const url = prompt(
      "Paste the image URL for this campaign's cover art (or leave blank to reset):"
    );
    if (url !== null) {
      setCovers((prev) => {
        const newCovers = { ...prev };
        if (url.trim() === "") {
          delete newCovers[campId];
        } else {
          newCovers[campId] = url;
        }
        return newCovers;
      });
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 text-[#122027] font-sans selection:bg-[#c2410d]/30 selection:text-[#122027] pb-12">
      <style>{`
        /* --- STANDARD STYLES --- */
        .wrike-matrix-render table { width: 100%; border-collapse: collapse; margin-top: 4px; font-size: 13px; }
        .wrike-matrix-render th { background-color: #122027; color: #ffffff; font-weight: 800; padding: 10px 14px; text-align: left; border: 1px solid #dce4ec; text-transform: uppercase; font-size: 11px; tracking: 0.05em; }
        .wrike-matrix-render td { padding: 10px 14px; border: 1px solid #dce4ec; font-weight: 500; color: #323b43; }
        .wrike-matrix-render tr:nth-child(even) { background-color: #f8fafc; }
        .wrike-matrix-render tr:hover { background-color: #c2410d/5; }
        .wrike-matrix-render a { color: #c2410d; font-weight: 700; text-decoration: underline; }
        .custom-scrollbar::-webkit-scrollbar { width: 6px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background-color: #dce4ec; border-radius: 10px; }
        .custom-scrollbar:hover::-webkit-scrollbar-thumb { background-color: #cbd5e1; }
      `}</style>

      {/* --- COMMAND PALETTE OVERLAY (z-300) --- */}
      {isPaletteOpen && (
        <div
          className="fixed inset-0 z-[300] flex items-start justify-center pt-[15vh] p-4 bg-[#122027]/60 backdrop-blur-sm animate-in fade-in duration-200"
          onClick={() => setIsPaletteOpen(false)}
        >
          <div
            className="bg-white rounded-3xl w-full max-w-2xl shadow-2xl flex flex-col border border-[#dce4ec] overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-4 border-b border-[#dce4ec] flex items-center gap-3 bg-slate-50/50">
              <Search className="w-6 h-6 text-[#c2410d]" />
              <input
                autoFocus
                type="text"
                value={paletteSearch}
                onChange={(e) => setPaletteSearch(e.target.value)}
                placeholder="Search campaigns, notes, or quick actions..."
                className="flex-1 bg-transparent text-lg font-medium text-[#122027] outline-none placeholder:text-[#768994]"
              />
              <div className="text-[10px] font-black text-[#768994] bg-white px-2 py-1 rounded-md border border-[#dce4ec] shadow-sm">
                ESC
              </div>
            </div>

            <div className="max-h-[60vh] overflow-y-auto custom-scrollbar p-2">
              {!paletteSearch.trim() ? (
                <div className="p-10 text-center text-[#768994] flex flex-col items-center gap-2">
                  <Command className="w-8 h-8 opacity-30" />
                  <p className="text-sm font-medium">
                    Search for campaigns or trigger global actions...
                  </p>
                </div>
              ) : paletteResults.length === 0 ? (
                <div className="p-10 text-center text-[#768994] flex flex-col items-center gap-2">
                  <Search className="w-8 h-8 opacity-30" />
                  <p className="text-sm font-medium">
                    No matches found for "{paletteSearch}"
                  </p>
                </div>
              ) : (
                paletteResults.map((result) => {
                  const isAction = result.matchType === "Action";
                  const ActionIcon = result.icon;
                  const cover = !isAction
                    ? covers[result.id] || CAMPAIGN_COVERS[result.id]
                    : null;

                  return (
                    <button
                      key={result.id}
                      onClick={() => handleSelectPaletteResult(result)}
                      className="w-full text-left p-4 hover:bg-slate-50 rounded-2xl flex items-center justify-between group transition-colors"
                    >
                      <div className="flex items-center gap-4">
                        <div
                          className={`w-12 h-12 rounded-[1rem] overflow-hidden shadow-sm shrink-0 flex items-center justify-center border border-slate-100/50 ${
                            isAction ? "bg-amber-100 text-amber-600" : ""
                          }`}
                          style={{
                            background: !isAction
                              ? cover
                                ? "#fff"
                                : generateGradient(result.title)
                              : undefined,
                          }}
                        >
                          {isAction ? (
                            <ActionIcon className="w-6 h-6" />
                          ) : cover ? (
                            <img
                              src={cover}
                              className="w-full h-full object-cover"
                              alt=""
                            />
                          ) : (
                            <Film className="w-5 h-5 text-white opacity-90" />
                          )}
                        </div>
                        <div>
                          <h4 className="text-base font-black text-[#122027] group-hover:text-[#c2410d] tracking-tight transition-colors">
                            {result.title}
                          </h4>
                          <p
                            className={`text-[11px] font-bold mt-0.5 flex items-center gap-1.5 uppercase tracking-widest ${
                              isAction ? "text-amber-500" : "text-[#768994]"
                            }`}
                          >
                            {isAction ? (
                              <Zap className="w-3 h-3" />
                            ) : (
                              <Sparkles className="w-3 h-3 text-[#1cc1a5]" />
                            )}
                            {result.matchType}
                          </p>
                        </div>
                      </div>
                      <span className="text-[10px] font-black uppercase tracking-widest text-[#768994] bg-white border border-slate-200 px-2.5 py-1.5 rounded-lg group-hover:text-[#c2410d] group-hover:border-[#c2410d]/30 group-hover:bg-[#c2410d]/5 transition-colors flex items-center gap-1.5 shadow-sm">
                        {isAction ? "Run" : "Jump"}{" "}
                        <Layout className="w-3.5 h-3.5" />
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* --- FILM MAPPINGS PANEL (admin only) --- */}
      {showMappingsPanel && (() => {
        const hardcoded = FILM_MAPPINGS || {};
        const discovered = filmCodeMappings || {};
        const allCodes = [...new Set([...Object.keys(hardcoded), ...Object.keys(discovered)])].sort();
        return (
          <div
            className="fixed inset-0 z-[300] flex items-start justify-center pt-[10vh] p-4 bg-[#122027]/60 backdrop-blur-sm animate-in fade-in duration-200"
            onClick={() => setShowMappingsPanel(false)}
          >
            <div
              className="bg-white rounded-3xl w-full max-w-2xl shadow-2xl flex flex-col border border-[#dce4ec] overflow-hidden max-h-[80vh]"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="p-5 border-b border-[#dce4ec] flex items-center justify-between bg-slate-50/50 shrink-0">
                <div className="flex items-center gap-3">
                  <div className="bg-gradient-to-br from-[#c2410d] to-[#1cc1a5] p-2.5 rounded-xl text-white shadow">
                    <Film className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-base font-black text-[#122027] tracking-tight">Film Code Mappings</h3>
                    <p className="text-[11px] text-[#768994] font-medium mt-0.5">
                      {Object.keys(hardcoded).length} hardcoded · {Object.keys(discovered).length} discovered · {allCodes.length} total
                    </p>
                  </div>
                </div>
                <button onClick={() => setShowMappingsPanel(false)} className="text-[#768994] hover:text-[#122027] p-1.5 rounded-xl hover:bg-slate-100 transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>
              {/* Table */}
              <div className="overflow-y-auto custom-scrollbar">
                <table className="w-full text-sm [&_td]:overflow-hidden" style={{ tableLayout: "fixed", minWidth: `${FILM_TABLE_COLS.reduce((s, c) => s + filmWidths[c.key], 0)}px` }}>
                  <colgroup>
                    {FILM_TABLE_COLS.map(c => <col key={c.key} style={{ width: filmWidths[c.key] }} />)}
                  </colgroup>
                  <thead className="sticky top-0 bg-white border-b border-[#dce4ec]">
                    <tr>
                      <th className="relative text-left px-5 py-3 text-[10px] font-black tracking-widest text-[#768994] uppercase overflow-hidden">Code{filmHandle("code")}</th>
                      <th className="relative text-left px-5 py-3 text-[10px] font-black tracking-widest text-[#768994] uppercase overflow-hidden">Film Name{filmHandle("name")}</th>
                      <th className="relative text-right px-5 py-3 text-[10px] font-black tracking-widest text-[#768994] uppercase overflow-hidden">Source{filmHandle("source")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allCodes.map((code, i) => {
                      const isHardcoded = !!hardcoded[code];
                      const name = hardcoded[code] || discovered[code];
                      return (
                        <tr key={code} className="border-b border-[#dce4ec]">
                          <td className="px-5 py-3">
                            <span className="font-mono text-xs font-black text-[#122027] bg-slate-100 px-2 py-1 rounded-lg border border-slate-200">
                              {code}
                            </span>
                          </td>
                          <td className="px-5 py-3 font-semibold text-[#122027]">{name}</td>
                          <td className="px-5 py-3 text-right">
                            {isHardcoded ? (
                              <span className="text-[10px] font-black uppercase tracking-widest text-blue-600 bg-blue-50 border border-blue-100 px-2 py-1 rounded-full">Hardcoded</span>
                            ) : (
                              <span className="text-[10px] font-black uppercase tracking-widest text-emerald-600 bg-emerald-50 border border-emerald-100 px-2 py-1 rounded-full">Discovered</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {allCodes.length === 0 && (
                  <div className="p-12 text-center text-[#768994] text-sm font-medium">
                    No mappings yet — run <strong>Map Films</strong> to discover them.
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      <PageHeader pageId="canvas" icon={Layout} title="Campaign Canvas" subtitle="Visual Command Centre for active campaigns">
        <span className="hidden md:flex items-center gap-1 bg-white/15 border border-white/20 px-2.5 py-1 rounded-md text-[10px] font-black tracking-widest text-white/85">
          <Command className="w-3 h-3" /> Global Cmd + K Menu
        </span>
        {isAdmin && (
          <>
            <button
              onClick={() => setShowMappingsPanel(true)}
              title="View all film code mappings (admin only)"
              className={pageHeaderActionClass}
            >
              <List className="w-3.5 h-3.5" />
              {Object.keys(filmCodeMappings).length + Object.keys(FILM_MAPPINGS || {}).length} Codes
            </button>
            {scanFilmMappings && (
              <button
                onClick={scanFilmMappings}
                disabled={isScanning || isSyncing}
                title="Scan all Wrike tasks to discover film code mappings (admin only)"
                className={pageHeaderActionClass}
              >
                <Search className={`w-3.5 h-3.5 ${isScanning ? "animate-pulse" : ""}`} />
                {isScanning ? "Scanning…" : "Map Films"}
              </button>
            )}
            {syncNow && (
              <button
                onClick={syncNow}
                disabled={isSyncing || isScanning}
                title="Force full Wrike sync (admin only)"
                className={pageHeaderActionClass}
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? "animate-spin" : ""}`} />
                {isSyncing ? "Syncing…" : "Sync Wrike"}
              </button>
            )}
          </>
        )}
      </PageHeader>

      <div className="max-w-[1800px] mx-auto px-4 sm:px-6 py-6">
        {/* --- PERFECTLY CENTERED ICON DOCK --- */}
        {isLoading && (
          <div className="flex items-center justify-center gap-2 py-3 text-xs font-bold text-[#768994]">
            <div className="w-3.5 h-3.5 border-2 border-[#c2410d] border-t-transparent rounded-full animate-spin" />
            Loading campaigns from cache…
          </div>
        )}
        {/* --- STUDIO GALLERY / DRILL-DOWN --- */}
        {(() => {
          const relativeDate = (ts) => {
            if (!ts) return null;
            const days = Math.floor((Date.now() - ts) / 86400000);
            if (days === 0) return "Today";
            if (days === 1) return "Yesterday";
            if (days < 7) return `${days}d ago`;
            if (days < 30) return `${Math.floor(days / 7)}w ago`;
            return `${Math.floor(days / 30)}mo ago`;
          };

          const sortedCampaigns = [...campaigns].sort(
            (a, b) => (b.lastMatrixUpdate || 0) - (a.lastMatrixUpdate || 0)
          );

          const grouped = sortedCampaigns.reduce((acc, camp) => {
            const auto = detectStudio(camp.links);
            const studio = studioOverrides[camp.id] || auto || camp.studioHint || "Others";
            const section = STUDIO_ORDER.includes(studio) ? studio : "Others";
            if (!acc[section]) acc[section] = [];
            acc[section].push(camp);
            return acc;
          }, {});

          // Others always shows — catches Sony/Warner/etc. plus anything unclassified
          // (manual adds, campaigns with no detectable studio) instead of a separate Misc card.
          const gallerySections = STUDIO_ORDER.filter(
            (s) => grouped[s]?.length > 0 || s === "Others"
          );

          // Pinned campaigns (preserve pin order)
          const pinnedCamps = pinnedIds
            .map((id) => campaigns.find((c) => c.id === id))
            .filter(Boolean);

          // --- Reusable campaign card ---
          const renderCampaignCard = (camp, index = 0) => {
            const hasCover = covers[camp.id] || CAMPAIGN_COVERS[camp.id];
            const isExpanded = expandedCampId === camp.id;
            const hasMatrix = camp.matrices?.length > 0;
            const updatedTs = camp.lastMatrixUpdate;
            // Was "edited in the last 14 days", which marked three
            // delivered campaigns as active because someone touched them
            // today. isLive comes off Wrike's own status instead.
            const isActive = camp.isLive;

            return (
              <div
                key={camp.id}
                className="relative animate-in fade-in slide-in-from-bottom-3 duration-500"
                style={{ animationDelay: `${Math.min(index, 16) * 35}ms`, animationFillMode: "both" }}
              >
                <button
                  onClick={() => handleToggleCamp(camp.id)}
                  className="group relative w-full rounded-2xl overflow-hidden outline-none transition-[transform,box-shadow,filter] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] text-left aspect-[2/3] shadow-md hover:shadow-2xl hover:-translate-y-1"
                  style={{
                    background: hasCover ? "#122027" : generateGradient(camp.title),
                    filter: isActive ? "none" : "grayscale(60%) brightness(0.75)",
                    transition: "filter 0.5s cubic-bezier(0.16,1,0.3,1), transform 0.5s cubic-bezier(0.16,1,0.3,1), box-shadow 0.5s cubic-bezier(0.16,1,0.3,1)",
                  }}
                  onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.filter = "none"; }}
                  onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.filter = "grayscale(60%) brightness(0.75)"; }}
                >
                  {hasCover && (
                    <div className="absolute inset-0 overflow-hidden rounded-2xl [transform:translateZ(0)]">
                      <img
                        src={hasCover}
                        alt={camp.title}
                        className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                      />
                    </div>
                  )}
                  {!hasCover && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <Film className="w-10 h-10 text-white/30" />
                    </div>
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
                  {isExpanded && (
                    <div className="absolute inset-0 ring-4 ring-inset ring-[#c2410d] rounded-2xl pointer-events-none" />
                  )}
                  {/* Top badges */}
                  <div className="absolute top-2.5 left-2.5 right-2.5 flex justify-between items-start">
                    {hasMatrix && isActive ? (
                      <span className="w-2 h-2 rounded-full mt-0.5 bg-emerald-400 shadow-[0_0_6px_2px_rgba(52,211,153,0.5)]" />
                    ) : !isActive ? (
                      <span className="text-[9px] font-black uppercase tracking-widest bg-black/40 backdrop-blur-sm text-white/70 px-2 py-0.5 rounded-full">
                        Delivered
                      </span>
                    ) : <span />}
                    {updatedTs ? (
                      <span className="text-[10px] font-bold bg-black/40 backdrop-blur-sm text-white/80 px-2 py-0.5 rounded-full">
                        {relativeDate(updatedTs)}
                      </span>
                    ) : null}
                  </div>
                  {/* Title */}
                  <div className="absolute bottom-0 left-0 right-0 p-3">
                    <p className={`text-sm font-black leading-tight text-white drop-shadow transition-colors line-clamp-2 ${isExpanded ? "text-[#c2410d]" : ""}`}>
                      {camp.title}
                    </p>
                  </div>
                </button>
              </div>
            );
          };

          // Studio detail used to be a full early-return "page swap" here — it's
          // now rendered inline inside the gallery view below (right under the
          // card row) so clicking a studio expands in place instead of hiding
          // Pinned / DOOH Specs / Reference.

          // ============ COUNTRY DETAIL VIEW (a DOOH country is open) ============
          // Tied to the DOOH tool being open: this is a full early return, so
          // an un-cleared country would otherwise render over the hub after
          // navigating back.
          if (canvasView === "dooh" && selectedCountry) {
            const country = doohCountries.find((c) => c.id === selectedCountry);
            if (!country) { setSelectedCountry(null); return null; }
            const allAssets = countryAssets[selectedCountry] || [];
            const foldersAll = doohFolders.filter((f) => f.country_id === selectedCountry);
            const subFolders = foldersAll.filter((f) => (f.parent_id || null) === (currentFolderId || null));
            const assetsHere = allAssets.filter((a) => (a.folder_id || null) === (currentFolderId || null));
            const images = assetsHere.filter((a) => a.type === "image");
            const docs = assetsHere.filter((a) => a.type !== "image");
            // Items that open in the lightbox (images + PDFs), in display order
            const previewable = [...images, ...docs.filter(isPdfAsset)];
            const isUploading = uploadingCountry === selectedCountry;

            // Count immediate children (folders + files) for a folder card badge
            const folderItemCount = (fid) =>
              foldersAll.filter((f) => (f.parent_id || null) === fid).length +
              allAssets.filter((a) => (a.folder_id || null) === fid).length;

            // Breadcrumb path from root → current folder
            const crumbs = [];
            let cur = currentFolderId;
            while (cur) {
              const f = foldersAll.find((x) => x.id === cur);
              if (!f) break;
              crumbs.unshift(f);
              cur = f.parent_id || null;
            }

            const isEmptyHere = subFolders.length === 0 && assetsHere.length === 0 && !isUploading;

            return (
              <div key={`country-${selectedCountry}`} className="mt-2 py-4 px-6 w-full">
                {/* Country banner */}
                <div className="relative rounded-3xl overflow-hidden p-6 sm:p-7 mb-8 shadow-md animate-in fade-in slide-in-from-top-4 zoom-in-95 duration-500 bg-gradient-to-br from-[#122027] via-[#1b3a4b] to-[#12506e]">
                  <div className="relative flex items-center justify-between gap-4 flex-wrap">
                    <div className="flex items-center gap-4 min-w-0">
                      <button
                        onClick={() => { setSelectedCountry(null); setCurrentFolderId(null); }}
                        className="flex items-center gap-1.5 bg-white/10 hover:bg-white/20 backdrop-blur-md text-white/90 px-3 py-1.5 rounded-xl text-[11px] font-black uppercase tracking-widest border border-white/20 transition-colors shrink-0"
                      >
                        <ChevronLeft className="w-3.5 h-3.5" /> DOOH Specs
                      </button>
                      <div className="flex items-center gap-3 min-w-0">
                        <CountryFlag flag={country.flag} imgClass="w-14 h-10" textClass="text-5xl" />
                        <div className="min-w-0">
                          {/* Breadcrumb */}
                          <div className="flex items-center gap-1.5 flex-wrap mb-1">
                            <button
                              onClick={() => setCurrentFolderId(null)}
                              className={`text-2xl sm:text-3xl font-black tracking-tight leading-none transition-colors ${currentFolderId ? "text-white/55 hover:text-white" : "text-white"}`}
                            >
                              {country.name}
                            </button>
                            {crumbs.map((f, idx) => (
                              <React.Fragment key={f.id}>
                                <ChevronRight className="w-4 h-4 text-white/40 shrink-0" />
                                <button
                                  onClick={() => setCurrentFolderId(f.id)}
                                  className={`text-2xl sm:text-3xl font-black tracking-tight leading-none transition-colors ${idx === crumbs.length - 1 ? "text-white" : "text-white/55 hover:text-white"}`}
                                >
                                  {f.name}
                                </button>
                              </React.Fragment>
                            ))}
                          </div>
                          <p className="text-[11px] font-bold text-white/70 uppercase tracking-widest">
                            {subFolders.length > 0 && `${subFolders.length} ${subFolders.length === 1 ? "folder" : "folders"} · `}
                            {assetsHere.length} {assetsHere.length === 1 ? "file" : "files"}
                          </p>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => { setNewFolderName(""); setIsAddFolderOpen(true); }}
                        className="flex items-center gap-2 bg-white/10 hover:bg-white/20 text-white px-4 py-2.5 rounded-xl font-black text-xs uppercase tracking-widest border border-white/20 transition-colors active:scale-95"
                      >
                        <FolderPlus className="w-4 h-4" /> New folder
                      </button>
                      <button
                        onClick={() => countryFileInputRef.current?.click()}
                        disabled={isUploading}
                        className="flex items-center gap-2 bg-[#c2410d] hover:bg-[#9a3412] disabled:opacity-60 text-white px-4 py-2.5 rounded-xl font-black text-xs uppercase tracking-widest border border-white/10 transition-colors active:scale-95 shadow-md"
                      >
                        {isUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                        {isUploading ? "Uploading…" : "Add files"}
                      </button>
                      {deletingCountryId === country.id ? (
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-bold text-rose-200 whitespace-nowrap">Delete country?</span>
                          <button onClick={() => handleDeleteCountry(country.id)} className="p-2 bg-rose-500 hover:bg-rose-600 text-white rounded-lg transition-colors"><Check className="w-4 h-4" /></button>
                          <button onClick={() => setDeletingCountryId(null)} className="p-2 bg-white/10 hover:bg-white/20 text-white rounded-lg transition-colors"><X className="w-4 h-4" /></button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setDeletingCountryId(country.id)}
                          title="Delete country"
                          className="p-2.5 bg-white/10 hover:bg-rose-500/80 text-white rounded-xl border border-white/20 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                <input
                  ref={countryFileInputRef}
                  type="file"
                  multiple
                  accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt"
                  className="hidden"
                  onChange={(e) => { handleUploadFiles(selectedCountry, e.target.files, currentFolderId); e.target.value = ""; }}
                />

                {/* Source path — for the current folder, or the country at root */}
                {(() => {
                  const node = currentFolderId ? foldersAll.find((f) => f.id === currentFolderId) : country;
                  if (!node) return null;
                  const src = node.source_path || "";
                  const isUrl = /^https?:\/\//i.test(src);
                  const editing = editingSourceFolderId === node.id;
                  const label = currentFolderId ? "Source" : "Country path";
                  return (
                    <div className="mb-6 flex items-center gap-2 bg-white border border-[#dce4ec] rounded-2xl px-4 py-2.5 shadow-sm">
                      <Link2 className="w-4 h-4 text-[#c2410d] shrink-0" />
                      <span className="text-[10px] font-black text-[#768994] uppercase tracking-widest shrink-0">{label}</span>
                      {editing ? (
                        <>
                          <input
                            autoFocus
                            value={editSourceText}
                            onChange={(e) => setEditSourceText(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") handleSaveSource(editSourceText); if (e.key === "Escape") setEditingSourceFolderId(null); }}
                            placeholder="/Volumes/… or https://drive.google.com/…"
                            className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg border border-[#dce4ec] focus:border-[#c2410d] outline-none text-sm font-medium text-[#122027]"
                          />
                          <button onClick={() => handleSaveSource(editSourceText)} className="p-1.5 bg-[#c2410d] hover:bg-[#9a3412] text-white rounded-lg transition-colors shrink-0"><Check className="w-4 h-4" /></button>
                          <button onClick={() => setEditingSourceFolderId(null)} className="p-1.5 bg-slate-100 hover:bg-slate-200 text-[#122027] rounded-lg transition-colors shrink-0"><X className="w-4 h-4" /></button>
                        </>
                      ) : (
                        <>
                          {src
                            ? <code className="flex-1 min-w-0 truncate text-sm font-medium text-[#122027]">{src}</code>
                            : <span className="flex-1 min-w-0 text-sm text-[#768994] italic">No source path set</span>}
                          {src && (
                            <button
                              onClick={() => { navigator.clipboard?.writeText(src); triggerToast("Source path copied", "success"); }}
                              title="Copy" className="p-1.5 text-[#768994] hover:text-[#c2410d] hover:bg-slate-50 rounded-lg transition-colors shrink-0"
                            ><Copy className="w-4 h-4" /></button>
                          )}
                          {src && isUrl && (
                            <a href={src} target="_blank" rel="noopener noreferrer" title="Open" className="p-1.5 text-[#768994] hover:text-[#c2410d] hover:bg-slate-50 rounded-lg transition-colors shrink-0"><ExternalLink className="w-4 h-4" /></a>
                          )}
                          <button
                            onClick={() => { setEditSourceText(src); setEditingSourceFolderId(node.id); }}
                            title={src ? "Edit" : "Add source path"} className="p-1.5 text-[#768994] hover:text-[#c2410d] hover:bg-slate-50 rounded-lg transition-colors shrink-0"
                          ><Edit2 className="w-4 h-4" /></button>
                        </>
                      )}
                    </div>
                  );
                })()}

                {/* Folders at this level */}
                {subFolders.length > 0 && (
                  <div className="mb-8">
                    <h3 className="text-xs font-black text-[#768994] uppercase tracking-widest mb-3 flex items-center gap-2">
                      <Folder className="w-4 h-4" /> Folders
                    </h3>
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
                      {subFolders.map((f) => (
                        <div key={f.id} className="group relative">
                          <button
                            onClick={() => setCurrentFolderId(f.id)}
                            className="w-full flex items-center gap-3 bg-white border border-[#dce4ec] rounded-2xl p-3.5 shadow-sm hover:border-[#c2410d]/50 hover:shadow transition-[border-color,box-shadow] text-left focus-visible:ring-2 focus-visible:ring-[#c2410d]/40 focus-visible:outline-none"
                          >
                            <div className="shrink-0 w-10 h-10 rounded-xl bg-amber-100 text-amber-500 flex items-center justify-center">
                              <Folder className="w-5 h-5 fill-current" />
                            </div>
                            <div className="min-w-0">
                              <p className="text-sm font-black text-[#122027] truncate">{f.name}</p>
                              <p className="text-[11px] text-[#768994] font-bold">{folderItemCount(f.id)} {folderItemCount(f.id) === 1 ? "item" : "items"}</p>
                            </div>
                          </button>
                          {deletingFolderId === f.id ? (
                            <div className="absolute top-2 right-2 flex items-center gap-1">
                              <button onClick={() => handleDeleteFolder(f.id)} title="Delete folder + contents" className="p-1.5 bg-rose-500 hover:bg-rose-600 text-white rounded-lg shadow"><Check className="w-3.5 h-3.5" /></button>
                              <button onClick={() => setDeletingFolderId(null)} className="p-1.5 bg-slate-100 hover:bg-slate-200 text-[#122027] rounded-lg shadow"><X className="w-3.5 h-3.5" /></button>
                            </div>
                          ) : (
                            <button onClick={() => setDeletingFolderId(f.id)} title="Delete folder" className="absolute top-2 right-2 p-1.5 text-[#768994] hover:text-rose-500 hover:bg-rose-50 rounded-lg opacity-0 group-hover:opacity-100 transition-[color,background-color,opacity] focus-visible:ring-2 focus-visible:ring-[#c2410d]/40 focus-visible:outline-none"><Trash2 className="w-3.5 h-3.5" /></button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {isEmptyHere && (
                  <div className="w-full border-2 border-dashed border-[#dce4ec] rounded-3xl py-16 flex flex-col items-center justify-center gap-3 text-[#768994]">
                    <Folder className="w-10 h-10 opacity-50" />
                    <p className="text-sm font-black">This folder is empty</p>
                    <p className="text-xs">Use “New folder” to organise sites, or “Add files” to upload specs</p>
                    <div className="flex items-center gap-2 mt-2">
                      <button onClick={() => { setNewFolderName(""); setIsAddFolderOpen(true); }} className="flex items-center gap-1.5 px-4 py-2 rounded-xl border border-[#dce4ec] hover:border-[#c2410d] hover:text-[#c2410d] text-xs font-black uppercase tracking-widest transition-colors focus-visible:ring-2 focus-visible:ring-[#c2410d]/40 focus-visible:outline-none"><FolderPlus className="w-4 h-4" /> New folder</button>
                      <button onClick={() => countryFileInputRef.current?.click()} className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#c2410d] hover:bg-[#9a3412] text-white text-xs font-black uppercase tracking-widest transition-colors focus-visible:ring-2 focus-visible:ring-[#c2410d]/40 focus-visible:outline-none"><Upload className="w-4 h-4" /> Add files</button>
                    </div>
                  </div>
                )}

                {/* Images */}
                {images.length > 0 && (
                  <div className="mb-8">
                    <h3 className="text-xs font-black text-[#768994] uppercase tracking-widest mb-3 flex items-center gap-2">
                      <ImageIcon className="w-4 h-4" /> Images
                    </h3>
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                      {images.map((asset) => (
                        <div key={asset.id} className="group relative rounded-2xl overflow-hidden aspect-square bg-slate-100 border border-[#dce4ec] shadow-sm">
                          <button type="button" onClick={() => openPreview(asset, previewable)} className="absolute inset-0 w-full h-full cursor-zoom-in">
                            <img src={asset.url} alt={asset.name} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" />
                          </button>
                          <div className="absolute inset-x-0 bottom-0 p-2 bg-gradient-to-t from-black/70 to-transparent pointer-events-none">
                            <p className="text-[10px] font-bold text-white truncate">{asset.name}</p>
                          </div>
                          {deletingAssetId === asset.id ? (
                            <div className="absolute top-2 right-2 flex items-center gap-1">
                              <button onClick={() => handleDeleteAsset(asset)} className="p-1.5 bg-rose-500 hover:bg-rose-600 text-white rounded-lg shadow"><Check className="w-3.5 h-3.5" /></button>
                              <button onClick={() => setDeletingAssetId(null)} className="p-1.5 bg-white/90 hover:bg-white text-[#122027] rounded-lg shadow"><X className="w-3.5 h-3.5" /></button>
                            </div>
                          ) : (
                            <button onClick={() => setDeletingAssetId(asset.id)} className="absolute top-2 right-2 p-1.5 bg-black/40 hover:bg-rose-500 text-white rounded-lg opacity-0 group-hover:opacity-100 transition-opacity backdrop-blur-sm"><Trash2 className="w-3.5 h-3.5" /></button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Documents */}
                {docs.length > 0 && (
                  <div className="mb-8">
                    <h3 className="text-xs font-black text-[#768994] uppercase tracking-widest mb-3 flex items-center gap-2">
                      <FileText className="w-4 h-4" /> Documents
                    </h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                      {docs.map((asset) => (
                        <div key={asset.id} className="group relative flex items-center gap-3 bg-white border border-[#dce4ec] rounded-2xl p-3 shadow-sm hover:border-[#c2410d]/40 hover:shadow transition-[border-color,box-shadow]">
                          <button type="button" onClick={() => openPreview(asset, previewable)} className="flex items-center gap-3 min-w-0 flex-1 text-left cursor-pointer">
                            <div className="shrink-0 w-10 h-10 rounded-xl bg-[#c2410d]/10 text-[#c2410d] flex items-center justify-center">
                              <FileText className="w-5 h-5" />
                            </div>
                            <div className="min-w-0">
                              <p className="text-sm font-bold text-[#122027] truncate">{asset.name}</p>
                              <p className="text-[11px] text-[#768994] font-medium">{isPdfAsset(asset) ? "Preview →" : "Open →"}</p>
                            </div>
                          </button>
                          {deletingAssetId === asset.id ? (
                            <div className="flex items-center gap-1 shrink-0">
                              <button onClick={() => handleDeleteAsset(asset)} className="p-1.5 bg-rose-500 hover:bg-rose-600 text-white rounded-lg"><Check className="w-3.5 h-3.5" /></button>
                              <button onClick={() => setDeletingAssetId(null)} className="p-1.5 bg-slate-100 hover:bg-slate-200 text-[#122027] rounded-lg"><X className="w-3.5 h-3.5" /></button>
                            </div>
                          ) : (
                            <button onClick={() => setDeletingAssetId(asset.id)} className="shrink-0 p-2 text-[#768994] hover:text-rose-500 hover:bg-rose-50 rounded-lg opacity-0 group-hover:opacity-100 transition-[color,background-color,opacity] focus-visible:ring-2 focus-visible:ring-[#c2410d]/40 focus-visible:outline-none"><Trash2 className="w-4 h-4" /></button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          }

          // ============ GALLERY VIEW (studio cards) ============
          // Only the department's own tools are offered — Launch Tracker is
          // Print's, DOOH Specs is Motion's — so the hub never shows a tile
          // that opens onto nothing.
          // Counted, not assumed: the tile used to read "18 live" because it
          // showed every campaign ever cached. Only two of those are actually
          // open in Wrike.
          const liveCount = campaigns.filter((c) => c.isLive).length;
          const canvasTools = [
            { id: "campaigns", icon: Film,     label: "Campaigns",  desc: "Every campaign, by studio", count: liveCount === campaigns.length ? `${campaigns.length} live` : `${liveCount} live · ${campaigns.length - liveCount} delivered` },
            { id: "notes",     icon: Folder,   label: "Notes Canvas", desc: `${department} team board · personal spaces`, count: null },
            ...(department === "Print"  ? [{ id: "launch", icon: Printer, label: "Launch Tracker", desc: "Per-market print requests", count: `${printLaunchHubs.length} live` }] : []),
            ...(department === "Motion" ? [{ id: "dooh",   icon: Globe,   label: "DOOH Specs", desc: "Screen specs by country", count: `${doohCountries.length} countries` }] : []),
            // End of Campaign Notes has no tile: it lives at the foot of Notes
            // Canvas, where the team is already writing things down for each
            // other. Behind its own tile it read as one more admin surface
            // nobody opened.
          ];

          return (
            <div key="studio-gallery" className="mt-2 py-4 px-6 w-full">
              {/* ============ TOOL SWITCHER ============ */}
              {/* The tiles stay put and the page under them changes, rather
                  than the row being replaced by whatever you picked. Clicking
                  the open tool closes it again, so the row doubles as the way
                  back — no separate breadcrumb to hunt for. */}
              <section className="mb-6">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {canvasTools.map(({ id, icon: Icon, label, desc, count }) => {
                    const active = canvasView === id;
                    return (
                      <button
                        key={id}
                        onClick={() => { setCanvasView(active ? null : id); setSelectedCountry(null); }}
                        aria-expanded={active}
                        className={`group text-left rounded-3xl border p-5 transition-[border-color,box-shadow,transform] active:scale-[0.99] focus-visible:ring-2 focus-visible:ring-[#c2410d]/40 focus-visible:outline-none ${
                          active
                            ? "border-[#c2410d] bg-white shadow-md ring-2 ring-[#c2410d]/15"
                            : "border-[#dce4ec] bg-white shadow-sm hover:shadow-md hover:border-[#c2410d]/40"
                        }`}
                      >
                        <div className="flex items-start gap-4">
                          <div className={`shrink-0 w-12 h-12 rounded-2xl flex items-center justify-center transition-[transform,opacity,box-shadow] ${
                            active
                              ? `bg-gradient-to-br ${CANVAS_GRADIENT} shadow-md scale-105`
                              : `bg-gradient-to-br ${CANVAS_GRADIENT} shadow-sm opacity-90 group-hover:opacity-100`
                          }`}>
                            <Icon className="w-6 h-6 text-white" strokeWidth={1.75} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <h3 className={`text-sm font-black transition-colors ${active ? "text-[#c2410d]" : "text-[#122027] group-hover:text-[#c2410d]"}`}>{label}</h3>
                            <p className="text-[11px] font-medium text-[#768994] mt-0.5 leading-snug">{desc}</p>
                            {count && (
                              <p className="text-[10px] font-black uppercase tracking-widest text-[#c2410d] mt-2">{count}</p>
                            )}
                          </div>
                          {/* Points right when closed, down when open — the
                              chevron says where the content is. */}
                          <ChevronRight
                            className={`w-4 h-4 shrink-0 mt-1 transition-[transform,color] duration-300 ${
                              active ? "rotate-90 text-[#c2410d]" : "text-[#c2d0da] group-hover:text-[#c2410d] group-hover:translate-x-0.5"
                            }`}
                          />
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>

              {/* ============ PINNED SHELF (top) — horizontal quick-access cards ============ */}
              {/* Stays on the hub: pins are the shortcut past the tool grid. */}
              {canvasView === null && (pinnedCamps.length > 0 || pinnedFolders.length > 0) && (
                <section className="mb-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
                  <div className="flex items-center justify-between gap-2.5 mb-3 px-1">
                    <p className="text-[11px] font-black text-[#768994] uppercase tracking-widest">Pinned</p>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {pinnedCamps.map((camp) => {
                      const cover = covers[camp.id] || CAMPAIGN_COVERS[camp.id];
                      const ts = camp.lastMatrixUpdate;
                      const isActive = ts && (Date.now() - ts) < 14 * 24 * 60 * 60 * 1000;
                      const auto = detectStudio(camp.links);
                      const studio = studioOverrides[camp.id] || auto || camp.studioHint || "Others";
                      const assetCount = camp.links?.length || 0;
                      return (
                        <button
                          key={`pin-${camp.id}`}
                          onClick={() => handleToggleCamp(camp.id)}
                          className="group/pin relative text-left rounded-2xl border border-[#dce4ec] bg-white p-3.5 hover:border-[#c2410d]/40 hover:shadow-md transition-[border-color,box-shadow] focus-visible:ring-2 focus-visible:ring-[#c2410d]/40 focus-visible:outline-none"
                        >
                          <span
                            onClick={(e) => { e.stopPropagation(); togglePin(camp.id); }}
                            title="Unpin"
                            className="absolute top-2.5 right-2.5 p-1 rounded-lg text-amber-500 hover:bg-amber-50 transition-colors"
                          >
                            <Pin className="w-3.5 h-3.5 fill-current" />
                          </span>
                          <div className="flex items-center gap-3">
                            <span
                              className="relative w-10 h-10 rounded-xl overflow-hidden shrink-0 shadow-sm flex items-center justify-center"
                              style={{ background: cover ? "#122027" : generateGradient(camp.title) }}
                            >
                              {cover ? (
                                <img src={cover} alt="" className="w-full h-full object-cover" />
                              ) : (
                                <Film className="w-4 h-4 text-white/50" />
                              )}
                            </span>
                            <div className="min-w-0 pr-5">
                              <p className="text-[9px] font-black uppercase tracking-widest text-[#94a3b8] truncate">{studio} · Campaign</p>
                              <p className="text-sm font-black text-[#122027] truncate leading-tight mt-0.5">{camp.title}</p>
                            </div>
                          </div>
                          <p className="flex items-center gap-1.5 text-[10px] font-bold text-[#768994] mt-2.5">
                            {isActive && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />}
                            {isActive ? "Live" : relativeDate(ts) || "No matrix"}
                            {assetCount > 0 && <span className="text-[#c2d0da]">· {assetCount} asset{assetCount === 1 ? "" : "s"}</span>}
                          </p>
                        </button>
                      );
                    })}

                    {/* Pinned Notes topics — sit alongside campaigns on the shelf.
                        Clicking opens the topic in the Notes panel (focusFolder). */}
                    {pinnedFolders.map((folder) => {
                      const me = localStorage.getItem("wrike_user_id");
                      const eyebrow = !folder.owner_wrike_id
                        ? `${boardLabelFor(folder.department || department)} · Topic`
                        : folder.owner_wrike_id === me
                          ? "My Space · Topic"
                          : "Shared · Topic";
                      return (
                        <button
                          key={`pin-folder-${folder.id}`}
                          onClick={() => setFocusFolder({ id: folder.id, n: Date.now() })}
                          className="group/pin relative text-left rounded-2xl border border-[#dce4ec] bg-white p-3.5 hover:border-[#c2410d]/50 hover:shadow-md transition-[border-color,box-shadow] focus-visible:ring-2 focus-visible:ring-[#c2410d]/40 focus-visible:outline-none"
                        >
                          <span
                            onClick={(e) => { e.stopPropagation(); toggleNotePin(folder); }}
                            title="Unpin topic"
                            className="absolute top-2.5 right-2.5 p-1 rounded-lg text-amber-500 hover:bg-amber-50 transition-colors"
                          >
                            <Pin className="w-3.5 h-3.5 fill-current" />
                          </span>
                          <div className="flex items-center gap-3">
                            <span className="relative w-10 h-10 rounded-xl shrink-0 shadow-sm flex items-center justify-center bg-gradient-to-br from-[#c2410d] to-[#9a3412]">
                              <FileText className="w-4 h-4 text-white/80" />
                            </span>
                            <div className="min-w-0 pr-5">
                              <p className="text-[9px] font-black uppercase tracking-widest text-[#94a3b8] truncate">{eyebrow}</p>
                              <p className="text-sm font-black text-[#122027] truncate leading-tight mt-0.5">{folder.name}</p>
                            </div>
                          </div>
                          <p className="flex items-center gap-1.5 text-[10px] font-bold text-[#768994] mt-2.5">
                            Open in Notes Canvas
                          </p>
                        </button>
                      );
                    })}
                  </div>
                </section>
              )}

              {/* ============ NOTES + CAMPAIGN LIST ============ */}
              {/* These used to sit side by side, each at half attention. They're
                  now separate tools, so whichever is open takes the full width. */}
              {/* Keyed on the open tool: switching remounts this panel so its
                  entrance animation runs again. The switcher above never
                  remounts, so the row itself stays perfectly still. */}
              <div key={canvasView || "hub"} className="animate-in fade-in slide-in-from-bottom-2 duration-300">
              {canvasView === "notes" && (
                <div className="grid grid-cols-1 gap-6 mb-10 items-start">
                  {(
                  <div className="min-w-0">
                    <NotesCanvasCard
                      isOpen={notesBrowserOpen}
                      onToggle={() => setNotesBrowserOpen((v) => !v)}
                      department={department}
                      pinnedFolderIds={pinnedFolders.map((f) => f.id)}
                      onTogglePin={toggleNotePin}
                      focusFolder={focusFolder}
                      editorExpanded={notesExpanded}
                      onToggleEditorExpanded={() => setNotesExpanded((v) => !v)}
                    />
                  </div>
                  )}

                </div>
              )}

              {/* ============ GALLERY — the studio art-wall ============ */}
              {/* The only campaigns view. There used to be a compact list here
                  too, with the gallery behind a "Browse gallery" button — two
                  ways to see the same campaigns, and the art-wall is the one
                  worth having on a page called Canvas. */}
              {canvasView === "campaigns" && (
              <>
              <div className="flex items-center gap-2.5 mb-4 px-1">
                <div className="w-9 h-9 rounded-xl bg-[#c2410d]/10 text-[#c2410d] flex items-center justify-center shadow-sm">
                  <Film className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-lg font-black text-[#122027] tracking-tight leading-none">Studios</h2>
                  <p className="text-[11px] font-bold text-[#768994] uppercase tracking-widest mt-1">Campaign libraries</p>
                </div>
              </div>
              {/* Fixed-size flex row, not a grid — with only a handful of studios,
                  a wide grid reserves empty tracks that read as an accidental
                  gap on the right. Cards flex to fill the row evenly (capped so
                  they don't balloon on ultra-wide screens) with a fixed height
                  rather than aspect-square, so stretching the width doesn't also
                  stretch the height into something oversized. */}
              <div className="flex flex-wrap justify-center gap-5">
                {gallerySections.map((section, i) => {
                  const art = STUDIO_ART[section] || STUDIO_ART.Misc;
                  const count = grouped[section]?.length || 0;
                  const isSelected = selectedStudio === section;
                  return (
                    <div
                      key={section}
                      className="flex-1 min-w-[280px] animate-in fade-in slide-in-from-bottom-4 zoom-in-95"
                      style={{ animationDelay: `${i * 60}ms`, animationFillMode: "both" }}
                    >
                    <button
                      onClick={() => setSelectedStudio((prev) => (prev === section ? null : section))}
                      className={`group relative w-full rounded-3xl overflow-hidden h-64 sm:h-80 xl:h-96 shadow-md hover:shadow-2xl hover:-translate-y-1.5 outline-none [filter:saturate(0.4)_brightness(0.9)] hover:[filter:saturate(1.08)_brightness(1.05)] ${isSelected ? "ring-4 ring-[#c2410d]/50 [filter:saturate(1.08)_brightness(1.05)]" : ""}`}
                      style={{ background: art.gradient, transition: "filter 0.6s cubic-bezier(0.16,1,0.3,1), transform 0.6s cubic-bezier(0.16,1,0.3,1), box-shadow 0.6s cubic-bezier(0.16,1,0.3,1)" }}
                    >
                      {/* Studio art (best-effort; hides itself on load failure) */}
                      {art.img && art.fit === "cover" && (
                        <img
                          src={art.img}
                          alt={art.label}
                          onError={(e) => { e.currentTarget.style.display = "none"; }}
                          className="absolute inset-0 w-full h-full object-cover transition-transform duration-500 ease-out group-hover:scale-105"
                        />
                      )}
                      {art.img && art.fit !== "cover" && (
                        <img
                          src={art.img}
                          alt={art.label}
                          onError={(e) => { e.currentTarget.style.display = "none"; }}
                          className="absolute left-1/2 top-[44%] -translate-x-1/2 -translate-y-1/2 max-h-[34%] max-w-[60%] object-contain drop-shadow-lg transition-transform duration-500 ease-out group-hover:scale-110 group-hover:-translate-y-[55%]"
                        />
                      )}
                      {/* Legibility veil — stronger for cover photos */}
                      <div className={`absolute inset-0 ${art.fit === "cover" ? "bg-gradient-to-t from-black/80 via-black/25 to-black/20" : "bg-gradient-to-t from-black/60 via-black/5 to-black/10"}`} />
                      {/* Count */}
                      <span className="absolute top-3 right-3 text-[11px] font-black bg-white/15 backdrop-blur-md text-white px-2.5 py-1 rounded-full border border-white/25 transition-transform duration-300 group-hover:scale-105">
                        {count}
                      </span>
                      {/* Wordmark */}
                      <div className="absolute bottom-0 left-0 right-0 p-5 sm:p-6 text-left transition-transform duration-300 group-hover:-translate-y-1">
                        <p className="text-xl sm:text-2xl font-black text-white tracking-tight drop-shadow-md leading-none truncate">
                          {section}
                        </p>
                        <p className="text-[11px] font-bold text-white/75 uppercase tracking-widest mt-2 truncate">
                          {art.label}
                        </p>
                      </div>
                    </button>
                    </div>
                  );
                })}
              </div>

              {/* Studio detail — expands in place below the cards instead of
                  replacing the page, so Pinned / DOOH Specs / Reference stay
                  put and a second click on the same card collapses it again. */}
              <AnimatePresence initial={false}>
                {selectedStudio && (() => {
                  const detailCamps = grouped[selectedStudio] || [];
                  return (
                    <motion.div
                      key={`studio-detail-${selectedStudio}`}
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                      className="overflow-hidden"
                    >
                      {/* No repeat header here — the selected card above already
                          shows the studio name/count and gets a ring highlight,
                          so this just drops straight into its campaigns. */}
                      <div className="mt-6">
                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-4">
                          {detailCamps.map((camp, i) => renderCampaignCard(camp, i))}
                        </div>

                        {detailCamps.length === 0 && (
                          <p className="text-center text-sm font-bold text-[#768994] py-16">
                            No campaigns in this studio.
                          </p>
                        )}
                      </div>
                    </motion.div>
                  );
                })()}
              </AnimatePresence>
              </>
              )}

              {/* ============ LAUNCH TRACKER (PRINT) ============ */}
              {/* Each reference surface is now a tool of its own, reached from
                  the hub, so it opens expanded — there's nothing to collapse it
                  against. */}
              {canvasView === "launch" && department === "Print" && (
                <PrintLaunchTrackerCard
                  isOpen
                  onToggle={undefined}
                  hubs={printLaunchHubs}
                  taskById={taskById}
                />
              )}
              {/* ============ DOOH SPECS ============ */}
              {/* DOOH specs are Motion-specific (out-of-home media specs) —
                  other departments get different content here later. */}
              {canvasView === "dooh" && department === "Motion" && (
              <CollapsibleCard
                icon={Globe}
                title="DOOH Specs"
                subtitle={`Screen specs by country · ${doohCountries.length}`}
                isOpen
                onToggle={undefined}
              >
                <div className="flex flex-wrap items-center gap-3 mb-5">
                  <div className="relative">
                    <Search className="w-4 h-4 text-[#768994] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      value={countrySearch}
                      onChange={(e) => setCountrySearch(e.target.value)}
                      placeholder="Search country…"
                      className="w-44 sm:w-56 pl-9 pr-3 py-2 rounded-xl border border-[#dce4ec] focus:border-[#c2410d] outline-none text-sm font-semibold text-[#122027] bg-white"
                    />
                  </div>
                  <div className="flex items-center bg-white border border-[#dce4ec] rounded-xl p-0.5">
                    <button onClick={() => setViewMode("grid")} title="Grid view" className={`p-1.5 rounded-lg transition-colors ${doohViewMode === "grid" ? "bg-[#c2410d] text-white" : "text-[#768994] hover:text-[#122027]"}`}><LayoutGrid className="w-4 h-4" /></button>
                    <button onClick={() => setViewMode("list")} title="List view" className={`p-1.5 rounded-lg transition-colors ${doohViewMode === "list" ? "bg-[#c2410d] text-white" : "text-[#768994] hover:text-[#122027]"}`}><List className="w-4 h-4" /></button>
                  </div>
                  <button onClick={() => setIsAddCountryOpen(true)} className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#c2410d] hover:bg-[#9a3412] text-white text-xs font-black uppercase tracking-widest transition-colors active:scale-95">
                    <Plus className="w-4 h-4" /> Add
                  </button>
                  <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
                    <button onClick={() => setAllRegionsExpanded(true)} className="text-[10px] font-black uppercase tracking-widest text-[#c2410d] hover:text-[#9a3412] px-1">Expand all</button>
                    <span className="text-[#dce4ec]">·</span>
                    <button onClick={() => setAllRegionsExpanded(false)} className="text-[10px] font-black uppercase tracking-widest text-[#768994] hover:text-[#122027] px-1">Collapse all</button>
                  </div>
                </div>

                {(() => {
                  const q = countrySearch.trim().toLowerCase();
                  const countryCount = (id) =>
                    doohFolders.filter((f) => f.country_id === id).length + (countryAssets[id] || []).length;
                  const visible = doohCountries.filter((c) => !q || c.name.toLowerCase().includes(q));
                  const pinned = visible.filter((c) => c.pinned);
                  const unpinned = visible.filter((c) => !c.pinned);
                  const openCountry = (id) => { setSelectedStudio(null); setSelectedCountry(id); setCurrentFolderId(null); window.scrollTo({ top: 0, behavior: "smooth" }); };

                  const Card = (country) => {
                    const count = countryCount(country.id);
                    return (
                      <div key={country.id} className="relative group/c">
                        <button onClick={() => openCountry(country.id)} className="w-full group relative rounded-xl overflow-hidden min-h-[104px] outline-none shadow-sm hover:shadow-lg hover:-translate-y-0.5 bg-gradient-to-br from-[#1b3a4b] to-[#12506e] flex flex-col items-center justify-center gap-2 px-2 py-3 transition-[transform,box-shadow] duration-300 focus-visible:ring-2 focus-visible:ring-[#c2410d]/40 focus-visible:outline-none">
                          <span className="transition-transform duration-500 group-hover:scale-110"><CountryFlag flag={country.flag} imgClass="w-11 h-[30px]" textClass="text-3xl" /></span>
                          <p className="text-[11px] font-bold text-white text-center leading-tight line-clamp-2 px-0.5">{country.name}</p>
                          {count > 0 && <span className="absolute top-1.5 right-1.5 text-[9px] font-black bg-white/15 backdrop-blur-md text-white w-5 h-5 flex items-center justify-center rounded-full border border-white/25">{count}</span>}
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); togglePinCountry(country); }} title={country.pinned ? "Unpin" : "Pin"} className={`absolute top-1.5 left-1.5 p-1 rounded-lg transition-[color,opacity] focus-visible:ring-2 focus-visible:ring-[#c2410d]/40 focus-visible:outline-none ${country.pinned ? "text-amber-300 opacity-100" : "text-white/70 opacity-0 group-hover/c:opacity-100 hover:text-amber-300"}`}>
                          <Star className={`w-4 h-4 ${country.pinned ? "fill-current" : ""}`} />
                        </button>
                      </div>
                    );
                  };

                  const Row = (country) => {
                    const count = countryCount(country.id);
                    return (
                      <div key={country.id} className="flex items-center gap-3 bg-white border border-[#dce4ec] rounded-xl pl-2.5 pr-2 py-2 shadow-sm hover:border-[#c2410d]/40 hover:shadow transition-[border-color,box-shadow]">
                        <button onClick={(e) => { e.stopPropagation(); togglePinCountry(country); }} title={country.pinned ? "Unpin" : "Pin"} className={`shrink-0 p-1 rounded-lg transition-colors ${country.pinned ? "text-amber-400" : "text-slate-300 hover:text-amber-400"}`}>
                          <Star className={`w-4 h-4 ${country.pinned ? "fill-current" : ""}`} />
                        </button>
                        <button onClick={() => openCountry(country.id)} className="flex items-center gap-3 min-w-0 flex-1 text-left">
                          <CountryFlag flag={country.flag} imgClass="w-8 h-[22px]" textClass="text-2xl" />
                          <span className="font-bold text-[#122027] truncate flex-1">{country.name}</span>
                          <span className="text-[11px] font-black text-[#768994] tabular-nums">{count}</span>
                          <ChevronRight className="w-4 h-4 text-[#768994] shrink-0" />
                        </button>
                      </div>
                    );
                  };

                  const renderItems = (items) =>
                    doohViewMode === "grid"
                      ? <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 gap-3">{items.map(Card)}</div>
                      : <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">{items.map(Row)}</div>;

                  return (
                    <div className="space-y-6">
                      {visible.length === 0 && (
                        <p className="text-center text-sm font-bold text-[#768994] py-10">No countries match “{countrySearch}”.</p>
                      )}
                      {pinned.length > 0 && (() => {
                        const isOpen = q ? true : !!expandedRegions["Pinned"];
                        return (
                          <div>
                            <div role="button" tabIndex={0} onClick={() => toggleRegion("Pinned")}
                              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") toggleRegion("Pinned"); }}
                              className="flex items-center gap-1.5 mb-2.5 cursor-pointer select-none w-fit">
                              <ChevronRight className={`w-3.5 h-3.5 shrink-0 text-amber-500 transition-transform ${isOpen ? "rotate-90" : ""}`} />
                              <h3 className="text-xs font-black text-amber-500 uppercase tracking-widest flex items-center gap-1.5"><Star className="w-3.5 h-3.5 fill-current" /> Pinned</h3>
                              <span className="text-[10px] font-black text-amber-500/70">{pinned.length}</span>
                            </div>
                            {isOpen && renderItems(pinned)}
                          </div>
                        );
                      })()}
                      {REGION_ORDER.map((region) => {
                        const items = unpinned.filter((c) => regionOf(c.name) === region);
                        if (items.length === 0) return null;
                        // Europe starts expanded by default; every other region
                        // (and Europe itself, once toggled) respects the saved state.
                        const isOpen = q ? true : (region === "Europe" ? expandedRegions[region] ?? true : !!expandedRegions[region]);
                        return (
                          <div key={region}>
                            <div role="button" tabIndex={0} onClick={() => toggleRegion(region)}
                              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") toggleRegion(region); }}
                              className="flex items-center gap-1.5 mb-2.5 cursor-pointer select-none w-fit">
                              <ChevronRight className={`w-3.5 h-3.5 shrink-0 text-[#768994] transition-transform ${isOpen ? "rotate-90" : ""}`} />
                              <h3 className="text-xs font-black text-[#768994] uppercase tracking-widest">{region}</h3>
                              <span className="text-[10px] font-black text-[#768994]/70">{items.length}</span>
                            </div>
                            {isOpen && renderItems(items)}
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </CollapsibleCard>
              )}

              {/* Sits at the foot of Notes Canvas — see canvasTools. */}
              {canvasView === "notes" && !notesExpanded && (
                <EndOfCampaignNotesCard
                  campaigns={campaigns}
                  department={department}
                  covers={covers}
                  focusCampaign={focusCampaign}
                  onOpenCampaign={openCampaignNotes}
                />
              )}
              </div>
            </div>
          );
        })()}


        {/* --- CAMPAIGN DETAIL MODAL --- */}
        {activeCamp && (
          <div
            className="fixed inset-0 z-[9998] flex items-center justify-center p-4 sm:p-8 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
            onClick={(e) => { if (e.target === e.currentTarget) setExpandedCampId(null); }}
          >
            <div className="bg-white rounded-[2rem] w-full max-w-[92vw] xl:max-w-7xl shadow-2xl flex flex-col border border-[#dce4ec] relative h-[90vh] animate-in zoom-in-95 duration-200">

              {/* Dynamic Banner Header — overflow-hidden lives on the background
                  child only so absolutely-positioned dropdowns can escape */}
                <div
                  className="h-40 sm:h-56 w-full relative shrink-0 flex items-end p-6 sm:p-8 rounded-t-[2rem]"
                  style={{
                    background: activeCover
                      ? "#122027"
                      : generateGradient(activeCamp.title),
                  }}
                >
                  {/* Background art layer — clipped independently */}
                  <div className="absolute inset-0 rounded-t-[2rem] overflow-hidden pointer-events-none">
                    {activeCover && (
                      <>
                        <img
                          src={activeCover}
                          className="absolute inset-0 w-full h-full object-cover opacity-60"
                          alt="Banner"
                        />
                        <div className="absolute inset-0 bg-gradient-to-t from-[#122027] via-[#122027]/40 to-transparent" />
                      </>
                    )}
                  </div>

                  <div className="relative z-10 w-full flex justify-between items-end gap-4">
                    <div className="flex items-end gap-4 sm:gap-6">
                      <div className="hidden sm:flex p-4 bg-white/10 backdrop-blur-md rounded-3xl text-white border border-white/20 shadow-xl relative">
                        <Film className="w-8 h-8" />
                      </div>
                      <div>
                        {activeCamp.isManual && editingCampTitleId === activeCamp.id ? (
                          <form
                            onSubmit={(e) => { e.preventDefault(); handleRenameCampaign(activeCamp.id, editCampTitleText); }}
                            className="flex items-center gap-2 mb-1"
                          >
                            <input
                              autoFocus
                              value={editCampTitleText}
                              onChange={(e) => setEditCampTitleText(e.target.value)}
                              onBlur={() => handleRenameCampaign(activeCamp.id, editCampTitleText)}
                              onKeyDown={(e) => { if (e.key === "Escape") setEditingCampTitleId(null); }}
                              className="text-3xl sm:text-4xl font-black text-white tracking-tight leading-none bg-white/15 backdrop-blur-sm border border-white/30 rounded-xl px-3 py-1 outline-none focus:border-white/60 w-full"
                            />
                          </form>
                        ) : (
                          <h2
                            className="text-3xl sm:text-4xl font-black text-white tracking-tight drop-shadow-md leading-none mb-1 flex items-center gap-2 group/title"
                          >
                            {activeCamp.title}
                            {activeCamp.isManual && (
                              <button
                                onClick={() => { setEditingCampTitleId(activeCamp.id); setEditCampTitleText(activeCamp.title); }}
                                className="opacity-0 group-hover/title:opacity-60 hover:!opacity-100 transition-opacity p-1"
                                title="Rename"
                              >
                                <Edit2 className="w-4 h-4 text-white" />
                              </button>
                            )}
                          </h2>
                        )}
                        <p className="text-xs font-bold text-white/70 uppercase tracking-widest flex items-center gap-2 mt-1">
                          Campaign Command Centre
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleUpdateCover(activeCamp.id);
                            }}
                            className="px-2 py-1 bg-white/10 hover:bg-white/20 rounded-md transition-colors text-[9px] flex items-center gap-1 border border-white/10 ml-2"
                          >
                            <ImagePlus className="w-3 h-3" /> Edit Cover
                          </button>
                          {/* Studio override */}
                          <span className="relative inline-flex">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setStudioPickerCampId((prev) => prev === activeCamp.id ? null : activeCamp.id);
                              }}
                              className="px-2 py-1 bg-white/10 hover:bg-white/20 rounded-md transition-colors text-[9px] flex items-center gap-1 border border-white/10"
                              title="Change studio"
                            >
                              <Film className="w-3 h-3" /> {studioOverrides[activeCamp.id] || detectStudio(activeCamp.links) || activeCamp.studioHint || "Others"}
                            </button>
                            {studioPickerCampId === activeCamp.id && (
                              <div className="absolute top-full left-0 mt-1.5 bg-white rounded-2xl shadow-2xl border border-[#dce4ec] py-1.5 z-[9999] min-w-[140px] animate-in zoom-in-95 duration-100">
                                {STUDIO_ORDER.map((s) => {
                                  const cur = studioOverrides[activeCamp.id] || detectStudio(activeCamp.links) || activeCamp.studioHint || "Others";
                                  return (
                                    <button
                                      key={s}
                                      onClick={(e) => { e.stopPropagation(); handleSetStudio(activeCamp.id, s); }}
                                      className={`w-full text-left px-3 py-1.5 text-xs font-bold normal-case tracking-normal transition-colors ${
                                        cur === s ? "bg-[#c2410d]/10 text-[#c2410d]" : "text-[#122027] hover:bg-slate-50"
                                      }`}
                                    >
                                      {s}
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </span>
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 mb-2 sm:mb-0">
                      <button
                        onClick={() => togglePin(activeCamp.id)}
                        title={pinnedIds.includes(activeCamp.id) ? "Unpin from quick access" : "Pin for quick access"}
                        className={`p-2.5 rounded-full transition-colors backdrop-blur-md border ${
                          pinnedIds.includes(activeCamp.id)
                            ? "bg-amber-400/90 hover:bg-amber-400 text-[#122027] border-amber-300"
                            : "bg-white/10 hover:bg-white/20 text-white border-white/20"
                        }`}
                      >
                        <Pin className={`w-5 h-5 ${pinnedIds.includes(activeCamp.id) ? "fill-current" : ""}`} />
                      </button>
                      <button
                        onClick={() => handleToggleCamp(activeCamp.id)}
                        className="p-2.5 bg-white/10 hover:bg-white/20 text-white rounded-full transition-colors backdrop-blur-md border border-white/20"
                      >
                        <X className="w-5 h-5" />
                      </button>
                    </div>
                  </div>
                </div>

                {/* --- SEAMLESS SPLIT-PANE BODY --- */}
                <div className="p-6 sm:p-8 flex flex-col lg:flex-row gap-6 flex-1 overflow-hidden">
                  {/* LEFT PANE: Notes & Context */}
                  <div className="flex-1 flex flex-col h-full overflow-hidden min-w-0">
                    <div className="flex justify-between items-center mb-5 pb-4 border-b border-slate-100 shrink-0">
                      <h4 className="text-sm font-black text-[#122027] flex items-center gap-2">
                        <FileText className="w-5 h-5 text-[#c2410d]" /> Notes &
                        Context
                      </h4>
                      <div className="flex items-center gap-2 pr-2">
                        <button
                          onClick={() => setShowFoldersPanel((prev) => !prev)}
                          className={`px-4 py-2 rounded-xl transition-colors flex items-center gap-2 text-xs font-bold border ${
                            showFoldersPanel
                              ? "bg-[#c2410d]/10 text-[#c2410d] border-[#c2410d]/20"
                              : "text-[#c2410d] bg-[#c2410d]/5 hover:bg-[#c2410d]/10 border-[#c2410d]/10"
                          }`}
                        >
                          <Folder className="w-4 h-4" />{" "}
                          {(activeCamp.links || []).length} Folders
                        </button>
                        <button
                          onClick={() => {
                            setAddingNoteCampId(activeCamp.id);
                            setNewNoteText("");
                          }}
                          className="text-white bg-[#c2410d] hover:bg-[#9a3412] px-4 py-2 rounded-xl transition-colors flex items-center gap-2 text-xs font-bold shadow-sm"
                        >
                          <Plus className="w-4 h-4" /> Add Note
                        </button>
                      </div>
                    </div>

                    <div className="flex-1 overflow-y-auto pr-4 custom-scrollbar space-y-5 min-w-0">
                      {(activeCamp.notes || []).length === 0 &&
                        addingNoteCampId !== activeCamp.id && (
                          <div className="h-full flex flex-col items-center justify-center text-center opacity-50 py-10">
                            <FileText className="w-12 h-12 text-slate-400 mb-3" />
                            <p className="text-sm font-bold text-[#122027]">
                              No notes recorded.
                            </p>
                            <p className="text-xs text-[#768994] mt-1">
                              Click 'Add Note' to start tracking details.
                            </p>
                          </div>
                        )}

                      {(activeCamp.notes || []).map((note) => (
                        <div
                          key={note.id}
                          className="group/note relative border-b border-slate-100 last:border-0 pb-5 mb-5 last:pb-0 last:mb-0"
                        >
                          {editingNote.campId === activeCamp.id &&
                          editingNote.noteId === note.id ? (
                            <div className="flex flex-col gap-3 bg-slate-50 p-4 rounded-2xl border border-slate-200">
                              <div className="flex gap-1.5 border-b border-slate-200 pb-2">
                                <button
                                  onClick={() =>
                                    handleFormat(
                                      "bold",
                                      editNoteText,
                                      setEditNoteText,
                                      "edit-note-textarea"
                                    )
                                  }
                                  className="p-1.5 hover:bg-slate-200 rounded text-slate-600 transition-colors"
                                  title="Bold"
                                >
                                  <Bold className="w-4 h-4" />
                                </button>
                                <button
                                  onClick={() =>
                                    handleFormat(
                                      "italic",
                                      editNoteText,
                                      setEditNoteText,
                                      "edit-note-textarea"
                                    )
                                  }
                                  className="p-1.5 hover:bg-slate-200 rounded text-slate-600 transition-colors"
                                  title="Italic"
                                >
                                  <Italic className="w-4 h-4" />
                                </button>
                                <button
                                  onClick={() =>
                                    handleFormat(
                                      "link",
                                      editNoteText,
                                      setEditNoteText,
                                      "edit-note-textarea"
                                    )
                                  }
                                  className="p-1.5 hover:bg-slate-200 rounded text-slate-600 transition-colors"
                                  title="Add Link"
                                >
                                  <Link2 className="w-4 h-4" />
                                </button>
                              </div>
                              <div className="flex gap-3 items-start">
                                <textarea
                                  id="edit-note-textarea"
                                  autoFocus
                                  value={editNoteText}
                                  onChange={(e) =>
                                    setEditNoteText(e.target.value)
                                  }
                                  className="w-full text-sm text-[#122027] bg-transparent border-none resize-y min-h-[150px] outline-none focus:ring-0 p-0 leading-relaxed custom-scrollbar"
                                  rows="8"
                                />
                                <div className="flex flex-col gap-2 shrink-0">
                                  <button
                                    onClick={() =>
                                      handleSaveEdit(activeCamp.id, note.id)
                                    }
                                    className="p-2 bg-[#1cc1a5] text-white rounded-xl hover:bg-[#15a38b] shadow-sm transition-[background-color] focus-visible:ring-2 focus-visible:ring-[#c2410d]/40 focus-visible:outline-none"
                                  >
                                    <Check className="w-4 h-4" />
                                  </button>
                                  <button
                                    onClick={() =>
                                      setEditingNote({
                                        campId: null,
                                        noteId: null,
                                      })
                                    }
                                    className="p-2 bg-slate-200 text-[#768994] rounded-xl hover:bg-slate-300 transition-[background-color] focus-visible:ring-2 focus-visible:ring-[#c2410d]/40 focus-visible:outline-none"
                                  >
                                    <X className="w-4 h-4" />
                                  </button>
                                </div>
                              </div>
                            </div>
                          ) : (
                            <div className="flex justify-between items-start gap-6">
                              <div className="flex-1 min-w-0">
                                {note.isAutoGenerated && (
                                  <div className="flex items-center gap-1.5 mb-2">
                                    <Link2 className="w-3.5 h-3.5 text-[#c2410d]" />
                                    <span className="text-[10px] font-black text-[#c2410d] uppercase tracking-widest bg-[#c2410d]/5 px-2 py-0.5 rounded border border-[#c2410d]/20">
                                      Wrike Import
                                    </span>
                                  </div>
                                )}
                                <p
                                  className="text-[14px] text-[#323b43] leading-relaxed break-all whitespace-pre-wrap markdown-content"
                                  dangerouslySetInnerHTML={{
                                    __html: parseFormatting(note.text),
                                  }}
                                />
                              </div>
                              <div className="flex flex-col gap-1.5 shrink-0 opacity-0 group-hover/note:opacity-100 transition-opacity bg-white p-1.5 rounded-xl border border-slate-100 shadow-sm">
                                <button
                                  onClick={() =>
                                    startEditing(activeCamp.id, note, note.text)
                                  }
                                  className="p-2 text-[#768994] hover:text-[#c2410d] hover:bg-slate-50 rounded-lg transition-colors"
                                >
                                  <Edit2 className="w-4 h-4" />
                                </button>
                                <button
                                  onClick={() =>
                                    handleDeleteNote(activeCamp.id, note.id)
                                  }
                                  className="p-2 text-[#768994] hover:text-rose-500 hover:bg-rose-50 rounded-lg transition-colors"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      ))}

                      {/* Inline Add Note Input */}
                      {addingNoteCampId === activeCamp.id && (
                        <div className="flex flex-col gap-3 bg-[#c2410d]/5 p-4 rounded-2xl border border-[#c2410d]/20 animate-in fade-in slide-in-from-top-2">
                          <div className="flex gap-1.5 border-b border-[#c2410d]/20 pb-2">
                            <button
                              onClick={() =>
                                handleFormat(
                                  "bold",
                                  newNoteText,
                                  setNewNoteText,
                                  "add-note-textarea"
                                )
                              }
                              className="p-1.5 hover:bg-[#c2410d]/10 rounded text-[#c2410d] transition-colors focus-visible:ring-2 focus-visible:ring-[#c2410d]/40 focus-visible:outline-none"
                              title="Bold"
                            >
                              <Bold className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() =>
                                handleFormat(
                                  "italic",
                                  newNoteText,
                                  setNewNoteText,
                                  "add-note-textarea"
                                )
                              }
                              className="p-1.5 hover:bg-[#c2410d]/10 rounded text-[#c2410d] transition-colors focus-visible:ring-2 focus-visible:ring-[#c2410d]/40 focus-visible:outline-none"
                              title="Italic"
                            >
                              <Italic className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() =>
                                handleFormat(
                                  "link",
                                  newNoteText,
                                  setNewNoteText,
                                  "add-note-textarea"
                                )
                              }
                              className="p-1.5 hover:bg-[#c2410d]/10 rounded text-[#c2410d] transition-colors focus-visible:ring-2 focus-visible:ring-[#c2410d]/40 focus-visible:outline-none"
                              title="Add Link"
                            >
                              <Link2 className="w-4 h-4" />
                            </button>
                          </div>
                          <div className="flex gap-3 items-start">
                            <textarea
                              id="add-note-textarea"
                              autoFocus
                              placeholder="Type your new note here... Highlight text and click the buttons above to format."
                              value={newNoteText}
                              onChange={(e) => setNewNoteText(e.target.value)}
                              className="w-full text-sm text-[#122027] bg-transparent border-none resize-y min-h-[150px] outline-none focus:ring-0 p-0 placeholder:text-[#c2410d]/40 leading-relaxed custom-scrollbar"
                              rows="8"
                            />
                            <div className="flex flex-col gap-2 shrink-0">
                              <button
                                onClick={() => handleAddNote(activeCamp.id)}
                                className="p-2 bg-[#c2410d] text-white hover:bg-[#9a3412] rounded-xl transition-colors shadow-sm"
                              >
                                <Check className="w-4 h-4" />
                              </button>
                              <button
                                onClick={() => setAddingNoteCampId(null)}
                                className="p-2 bg-white text-[#768994] border border-slate-200 hover:bg-slate-50 rounded-xl transition-colors shadow-sm"
                              >
                                <X className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* RIGHT PANE: Folders (Pure CSS Flex-Basis Slide) */}
                  <div
                    className={`transition-[opacity,transform] duration-500 ease-[cubic-bezier(0.4,0,0.2,1)] overflow-hidden flex flex-col ${
                      showFoldersPanel
                        ? "w-full lg:w-[420px] xl:w-[520px] max-h-[500px] lg:max-h-full opacity-100 translate-x-0 mt-6 lg:mt-0 lg:ml-6"
                        : "w-full lg:w-0 max-h-0 lg:max-h-full opacity-0 lg:translate-x-6 mt-0 lg:ml-0"
                    }`}
                  >
                    {/* Inner rigid container prevents content squishing while the wrapper shrinks */}
                    <div className="w-full lg:w-[420px] xl:w-[520px] shrink-0 bg-slate-50 border border-[#dce4ec] rounded-2xl flex flex-col h-full shadow-inner min-h-[300px]">
                      <div className="p-4 border-b border-[#dce4ec] flex justify-between items-center bg-white shrink-0 rounded-t-2xl">
                        <div className="flex items-center gap-2.5">
                          <div className="p-1.5 bg-[#c2410d]/10 text-[#c2410d] rounded-lg">
                            <Folder className="w-4 h-4" />
                          </div>
                          <h3 className="font-black text-[#122027]">
                            Links & Folders
                          </h3>
                        </div>
                        <button
                          onClick={() => setShowFoldersPanel(false)}
                          className="p-1.5 text-[#768994] hover:bg-slate-100 hover:text-rose-500 rounded-full transition-colors"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>

                      <div className="flex-1 overflow-y-auto p-4 custom-scrollbar space-y-3">
                        {(activeCamp.links || []).length === 0 ? (
                          <div className="flex flex-col items-center justify-center py-10 text-slate-400">
                            <Link2 className="w-8 h-8 mb-3 opacity-50" />
                            <p className="text-sm font-medium">
                              No links/folders added yet.
                            </p>
                          </div>
                        ) : (
                          (activeCamp.links || []).map((link) => (
                            <React.Fragment key={link.id}>
                              {editingLink.campId === activeCamp.id &&
                              editingLink.linkId === link.id ? (
                                <div className="group relative bg-white border border-[#c2410d]/30 rounded-xl p-3 flex flex-col gap-2 shadow-sm animate-in fade-in zoom-in-95 duration-200">
                                  <input
                                    type="text"
                                    value={editLinkTitle}
                                    onChange={(e) =>
                                      setEditLinkTitle(e.target.value)
                                    }
                                    className="w-full bg-slate-50 border border-[#dce4ec] rounded-lg px-2.5 py-1.5 text-xs font-bold text-[#122027] outline-none focus:border-[#c2410d] focus:ring-1 focus:ring-[#c2410d] transition-[border-color,box-shadow]"
                                    placeholder="Link Title"
                                  />
                                  <textarea
                                    value={editLinkUrl}
                                    onChange={(e) =>
                                      setEditLinkUrl(e.target.value)
                                    }
                                    className="w-full bg-slate-50 border border-[#dce4ec] rounded-lg px-2.5 py-1.5 text-[10px] font-mono text-[#768994] outline-none focus:border-[#c2410d] focus:ring-1 focus:ring-[#c2410d] transition-[border-color,box-shadow] resize-y min-h-[60px] custom-scrollbar"
                                    placeholder="URL / Path"
                                  />
                                  <div className="flex justify-end gap-2 mt-1">
                                    <button
                                      onClick={cancelEditingLink}
                                      className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
                                      title="Cancel"
                                    >
                                      <X className="w-4 h-4" />
                                    </button>
                                    <button
                                      onClick={() =>
                                        handleSaveEditLink(
                                          activeCamp.id,
                                          link.id
                                        )
                                      }
                                      className="p-1.5 text-emerald-600 hover:text-white hover:bg-emerald-500 bg-emerald-50 rounded-lg transition-colors"
                                      title="Save Link"
                                    >
                                      <Check className="w-4 h-4" />
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <div className="group relative bg-white border border-slate-200 rounded-xl p-3 flex flex-col gap-3 hover:border-[#c2410d]/30 hover:shadow-sm transition-[border-color,box-shadow]">
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 mb-1.5">
                                      {link.isAutoGenerated && (
                                        <span className="text-[9px] font-black uppercase tracking-widest bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded border border-emerald-200">
                                          Auto
                                        </span>
                                      )}
                                      <h4 className="font-bold text-[#122027] break-words text-sm">
                                        {link.title}
                                      </h4>
                                    </div>
                                    <p className="text-[11px] text-[#768994] break-all whitespace-pre-wrap font-mono bg-slate-50 p-2.5 rounded-lg border border-slate-100 leading-relaxed">
                                      {link.url}
                                    </p>
                                  </div>

                                  <div className="flex items-center justify-end gap-2 shrink-0">
                                    <button
                                      onClick={() =>
                                        handleCopyLink(link.url, link.id)
                                      }
                                      className={`flex items-center justify-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold transition-[background-color,color,box-shadow] flex-1 focus-visible:ring-2 focus-visible:ring-[#c2410d]/40 focus-visible:outline-none ${
                                        copiedLinkId === link.id
                                          ? "bg-emerald-500 text-white shadow-sm shadow-emerald-500/20"
                                          : "bg-slate-100 text-[#323b43] hover:bg-[#c2410d]/5 hover:text-[#c2410d]"
                                      }`}
                                    >
                                      {copiedLinkId === link.id ? (
                                        <>
                                          <Check className="w-3.5 h-3.5" />{" "}
                                          Copied!
                                        </>
                                      ) : (
                                        <>
                                          <Copy className="w-3.5 h-3.5" /> Copy
                                          Link
                                        </>
                                      )}
                                    </button>

                                    {/* Edit Button */}
                                    <button
                                      onClick={() =>
                                        startEditingLink(activeCamp.id, link)
                                      }
                                      className="p-2 text-slate-400 hover:text-[#c2410d] hover:bg-[#c2410d]/5 rounded-lg transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100 focus-visible:ring-2 focus-visible:ring-[#c2410d]/40 focus-visible:outline-none"
                                      title="Edit Link"
                                    >
                                      <Edit2 className="w-4 h-4" />
                                    </button>

                                    <button
                                      onClick={() =>
                                        handleDeleteLink(activeCamp.id, link.id)
                                      }
                                      className="p-2 text-slate-400 hover:text-rose-500 hover:bg-rose-50 rounded-lg transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
                                      title="Delete Link"
                                    >
                                      <Trash2 className="w-4 h-4" />
                                    </button>
                                  </div>
                                </div>
                              )}
                            </React.Fragment>
                          ))
                        )}
                      </div>

                      <div className="p-4 bg-white border-t border-[#dce4ec] shrink-0 rounded-b-2xl">
                        <div className="flex flex-col gap-2">
                          <input
                            type="text"
                            value={newLinkTitle}
                            onChange={(e) => setNewLinkTitle(e.target.value)}
                            placeholder="Link or folder title..."
                            className="w-full bg-slate-50 border border-[#dce4ec] rounded-xl px-3 py-2 text-sm outline-none focus:border-[#c2410d] focus:ring-2 focus:ring-[#c2410d]/20 transition-[border-color,box-shadow]"
                          />
                          <div className="flex gap-2">
                            <input
                              type="text"
                              value={newLinkUrl}
                              onChange={(e) => setNewLinkUrl(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter")
                                  handleAddLink(activeCamp.id);
                              }}
                              placeholder="Paste URL..."
                              className="flex-1 min-w-0 bg-slate-50 border border-[#dce4ec] rounded-xl px-3 py-2 text-sm outline-none focus:border-[#c2410d] focus:ring-2 focus:ring-[#c2410d]/20 transition-[border-color,box-shadow] font-mono"
                            />
                            <button
                              onClick={() => handleAddLink(activeCamp.id)}
                              disabled={
                                !newLinkTitle.trim() || !newLinkUrl.trim()
                              }
                              className="bg-[#c2410d] hover:bg-[#9a3412] disabled:bg-slate-300 text-white p-2 rounded-xl transition-colors shadow-sm shrink-0 flex items-center justify-center focus-visible:ring-2 focus-visible:ring-[#c2410d]/40 focus-visible:outline-none"
                            >
                              <Plus className="w-5 h-5" />
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Footer Actions */}
                <div className="p-6 bg-slate-50 border-t border-[#dce4ec] shrink-0 rounded-b-[2rem]">
                  <div className="flex gap-4">
                    <button
                      disabled={
                        !activeCamp.matrices || activeCamp.matrices.length === 0
                      }
                      onClick={() => setSelectedMatrix(activeCamp.matrices[0])}
                      className="flex-1 flex items-center justify-center gap-2 bg-[#c2410d] hover:bg-[#9a3412] text-white py-4 rounded-2xl text-sm font-black uppercase tracking-widest transition-[background-color,box-shadow,transform] shadow-md active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100 focus-visible:ring-2 focus-visible:ring-[#c2410d]/40 focus-visible:outline-none"
                    >
                      <FileText className="w-5 h-5" /> View Asset Matrix
                    </button>
                    <a
                      href={activeCamp.wrikeLink}
                      target="_blank"
                      rel="noreferrer"
                      className="flex-1 flex items-center justify-center gap-2 bg-[#122027] hover:bg-[#1a2d37] text-white py-4 rounded-2xl text-sm font-black uppercase tracking-widest transition-[background-color,box-shadow,transform] shadow-md active:scale-95 focus-visible:ring-2 focus-visible:ring-[#c2410d]/40 focus-visible:outline-none"
                    >
                      <ExternalLink className="w-5 h-5" /> Open in Wrike
                    </a>
                    {/* Delete — only for manually-created campaigns */}
                    {activeCamp.isManual && (
                      deletingCampId === activeCamp.id ? (
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-rose-600 whitespace-nowrap">Sure?</span>
                          <button
                            onClick={() => handleDeleteCampaign(activeCamp.id)}
                            className="px-4 py-4 bg-rose-600 hover:bg-rose-700 text-white rounded-2xl text-sm font-black uppercase tracking-widest transition-[background-color,transform] active:scale-95 focus-visible:ring-2 focus-visible:ring-[#c2410d]/40 focus-visible:outline-none"
                          >
                            Yes, delete
                          </button>
                          <button
                            onClick={() => setDeletingCampId(null)}
                            className="px-4 py-4 bg-slate-200 hover:bg-slate-300 text-[#122027] rounded-2xl text-sm font-black uppercase tracking-widest transition-[background-color,transform] active:scale-95 focus-visible:ring-2 focus-visible:ring-[#c2410d]/40 focus-visible:outline-none"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setDeletingCampId(activeCamp.id)}
                          className="flex items-center justify-center gap-2 px-5 py-4 bg-rose-50 hover:bg-rose-100 text-rose-600 rounded-2xl text-sm font-black uppercase tracking-widest transition-[background-color,color,border-color,transform] active:scale-95 border border-rose-200 focus-visible:ring-2 focus-visible:ring-[#c2410d]/40 focus-visible:outline-none"
                        >
                          <Trash2 className="w-4 h-4" /> Delete
                        </button>
                      )
                    )}
                  </div>
                </div>
            </div>
          </div>
        )}

        {/* Campaign Generation Creation Overlay Modal */}

        {isModalOpen && (
          <div className="fixed inset-0 bg-[#122027]/60 backdrop-blur-sm flex items-center justify-center z-[9999] p-4">
            <div className="bg-white rounded-[24px] shadow-2xl w-full max-w-md overflow-hidden border border-[#dce4ec] animate-in zoom-in-95 duration-200">
              <div className="p-6 border-b border-[#dce4ec] flex justify-between items-center bg-slate-50/50">
                <div className="flex items-center gap-2.5">
                  <div className="p-2 bg-[#c2410d]/10 rounded-lg">
                    <Layout className="w-4 h-4 text-[#c2410d]" />
                  </div>
                  <h3 className="text-lg font-black text-[#122027] tracking-tight">
                    Add New Item
                  </h3>
                </div>
                <button
                  onClick={handleCloseModal}
                  className="text-[#768994] hover:text-rose-500 hover:bg-rose-50 p-2 rounded-xl transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="p-6 space-y-5">
                <div>
                  <label className="block text-[10px] font-black text-[#768994] uppercase tracking-widest mb-2">
                    Campaign Title
                  </label>
                  <input
                    autoFocus
                    value={newCampaignTitle}
                    onChange={(e) => setNewCampaignTitle(e.target.value)}
                    className="w-full bg-slate-50 border border-[#dce4ec] rounded-xl px-4 py-3 text-sm font-medium text-[#122027] focus:outline-none focus:border-[#c2410d] focus:ring-2 focus:ring-[#c2410d]/20 transition-[border-color,box-shadow] placeholder:text-slate-400"
                    placeholder="e.g., Scary Movie 6..."
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-black text-[#768994] uppercase tracking-widest mb-2">
                    Matrix Link
                  </label>
                  <input
                    value={newCampaignLink}
                    onChange={(e) => setNewCampaignLink(e.target.value)}
                    className="w-full bg-slate-50 border border-[#dce4ec] rounded-xl px-4 py-3 text-sm font-medium text-[#122027] focus:outline-none focus:border-[#c2410d] focus:ring-2 focus:ring-[#c2410d]/20 transition-[border-color,box-shadow] placeholder:text-slate-400"
                    placeholder="Paste Wrike URL here..."
                  />
                </div>
              </div>
              <div className="p-5 bg-slate-50 border-t border-[#dce4ec] flex justify-end gap-3">
                <button
                  onClick={handleCloseModal}
                  className="px-5 py-2.5 text-xs font-black text-[#768994] hover:text-[#122027] hover:bg-slate-200/50 rounded-xl transition-colors uppercase tracking-widest"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveNewCampaign}
                  className="px-6 py-2.5 bg-[#c2410d] hover:bg-[#9a3412] text-white text-xs font-black uppercase tracking-widest rounded-xl shadow-md hover:shadow-[#c2410d]/20 transition-[background-color,box-shadow,transform] active:scale-95 focus-visible:ring-2 focus-visible:ring-[#c2410d]/40 focus-visible:outline-none"
                >
                  Save Campaign
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ADD COUNTRY MODAL */}
        {isAddCountryOpen && (
          <div
            className="fixed inset-0 bg-[#122027]/60 backdrop-blur-sm flex items-center justify-center z-[9999] p-4"
            onClick={(e) => { if (e.target === e.currentTarget) setIsAddCountryOpen(false); }}
          >
            <div className="bg-white rounded-[24px] shadow-2xl w-full max-w-md overflow-hidden border border-[#dce4ec] animate-in zoom-in-95 duration-200">
              <div className="p-6 sm:p-7 bg-gradient-to-br from-[#122027] via-[#1b3a4b] to-[#12506e] flex items-center gap-4">
                <CountryFlag flag={codeToFlag(newCountryCode) || "🌐"} imgClass="w-12 h-8" textClass="text-4xl" />
                <div>
                  <h2 className="text-2xl font-black text-white tracking-tight leading-none">Add Country</h2>
                  <p className="text-[11px] font-bold text-white/70 uppercase tracking-widest mt-1.5">DOOH screen specs</p>
                </div>
              </div>
              <div className="p-6 sm:p-7 space-y-4">
                <div>
                  <label className="text-xs font-black text-[#768994] uppercase tracking-widest">Country name</label>
                  <input
                    autoFocus
                    value={newCountryName}
                    onChange={(e) => setNewCountryName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleAddCountry(); }}
                    placeholder="e.g. United Kingdom"
                    className="mt-1.5 w-full px-4 py-2.5 rounded-xl border border-[#dce4ec] focus:border-[#c2410d] outline-none text-sm font-bold text-[#122027]"
                  />
                </div>
                <div>
                  <label className="text-xs font-black text-[#768994] uppercase tracking-widest">ISO code <span className="font-bold normal-case text-[10px] opacity-70">(optional — for the flag, e.g. GB, PL, AE)</span></label>
                  <input
                    value={newCountryCode}
                    onChange={(e) => setNewCountryCode(e.target.value.slice(0, 2))}
                    onKeyDown={(e) => { if (e.key === "Enter") handleAddCountry(); }}
                    placeholder="GB"
                    maxLength={2}
                    className="mt-1.5 w-full px-4 py-2.5 rounded-xl border border-[#dce4ec] focus:border-[#c2410d] outline-none text-sm font-bold text-[#122027] uppercase"
                  />
                </div>
              </div>
              <div className="px-6 sm:px-7 pb-6 flex justify-end gap-2">
                <button
                  onClick={() => { setIsAddCountryOpen(false); setNewCountryName(""); setNewCountryCode(""); }}
                  className="px-5 py-2.5 text-[#768994] hover:text-[#122027] text-xs font-black uppercase tracking-widest rounded-xl hover:bg-slate-100 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAddCountry}
                  disabled={!newCountryName.trim()}
                  className="px-6 py-2.5 bg-[#c2410d] hover:bg-[#9a3412] disabled:opacity-50 text-white text-xs font-black uppercase tracking-widest rounded-xl shadow-md transition-[background-color,box-shadow,transform] active:scale-95 focus-visible:ring-2 focus-visible:ring-[#c2410d]/40 focus-visible:outline-none"
                >
                  Add Country
                </button>
              </div>
            </div>
          </div>
        )}

        {/* NEW FOLDER MODAL */}
        {isAddFolderOpen && (
          <div
            className="fixed inset-0 bg-[#122027]/60 backdrop-blur-sm flex items-center justify-center z-[9999] p-4"
            onClick={(e) => { if (e.target === e.currentTarget) setIsAddFolderOpen(false); }}
          >
            <div className="bg-white rounded-[24px] shadow-2xl w-full max-w-md overflow-hidden border border-[#dce4ec] animate-in zoom-in-95 duration-200">
              <div className="p-6 sm:p-7 bg-gradient-to-br from-[#122027] via-[#1b3a4b] to-[#12506e] flex items-center gap-4">
                <div className="w-12 h-12 rounded-2xl bg-amber-400/90 text-[#122027] flex items-center justify-center shadow">
                  <FolderPlus className="w-6 h-6" />
                </div>
                <div>
                  <h2 className="text-2xl font-black text-white tracking-tight leading-none">New Folder</h2>
                  <p className="text-[11px] font-bold text-white/70 uppercase tracking-widest mt-1.5">
                    Inside {(() => {
                      const f = doohFolders.find((x) => x.id === currentFolderId);
                      return f ? f.name : doohCountries.find((c) => c.id === selectedCountry)?.name || "country";
                    })()}
                  </p>
                </div>
              </div>
              <div className="p-6 sm:p-7">
                <label className="text-xs font-black text-[#768994] uppercase tracking-widest">Folder name</label>
                <input
                  autoFocus
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleAddFolder(); if (e.key === "Escape") setIsAddFolderOpen(false); }}
                  placeholder="e.g. LAGOH, Specs, Render Examples"
                  className="mt-1.5 w-full px-4 py-2.5 rounded-xl border border-[#dce4ec] focus:border-[#c2410d] outline-none text-sm font-bold text-[#122027]"
                />
              </div>
              <div className="px-6 sm:px-7 pb-6 flex justify-end gap-2">
                <button
                  onClick={() => { setIsAddFolderOpen(false); setNewFolderName(""); }}
                  className="px-5 py-2.5 text-[#768994] hover:text-[#122027] text-xs font-black uppercase tracking-widest rounded-xl hover:bg-slate-100 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAddFolder}
                  disabled={!newFolderName.trim()}
                  className="px-6 py-2.5 bg-[#c2410d] hover:bg-[#9a3412] disabled:opacity-50 text-white text-xs font-black uppercase tracking-widest rounded-xl shadow-md transition-[background-color,box-shadow,transform] active:scale-95 focus-visible:ring-2 focus-visible:ring-[#c2410d]/40 focus-visible:outline-none"
                >
                  Create Folder
                </button>
              </div>
            </div>
          </div>
        )}

        {/* FILE PREVIEW LIGHTBOX (images + PDFs) */}
        <AnimatePresence>
        {previewAsset && (
          <motion.div
            key="preview-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-0 z-[10000] bg-black/85 backdrop-blur-sm flex flex-col p-3 sm:p-6"
            onClick={(e) => { if (e.target === e.currentTarget) setPreviewAsset(null); }}
          >
            <div className="flex items-center justify-between gap-3 mb-3 shrink-0">
              <div className="flex items-center gap-2.5 min-w-0 text-white">
                <div className="shrink-0 w-9 h-9 rounded-xl bg-white/10 border border-white/20 flex items-center justify-center">
                  {previewAsset.type === "image" ? <ImageIcon className="w-4 h-4" /> : <FileText className="w-4 h-4" />}
                </div>
                <p className="font-bold truncate">{previewAsset.name}</p>
                {previewList.length > 1 && previewIndex >= 0 && (
                  <span className="shrink-0 text-[11px] font-bold text-white/60 bg-white/10 border border-white/15 px-2 py-0.5 rounded-full">
                    {previewIndex + 1} / {previewList.length}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <a
                  href={previewAsset.url}
                  download={previewAsset.name}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-bold border border-white/20 transition-colors"
                >
                  <Download className="w-4 h-4" /> <span className="hidden sm:inline">Download</span>
                </a>
                <a
                  href={previewAsset.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-bold border border-white/20 transition-colors"
                >
                  <ExternalLink className="w-4 h-4" /> <span className="hidden sm:inline">Open</span>
                </a>
                <button
                  onClick={() => setPreviewAsset(null)}
                  className="p-2 rounded-xl bg-white/10 hover:bg-rose-500 text-white border border-white/20 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="relative flex-1 min-h-0 rounded-2xl overflow-hidden bg-white/5 border border-white/10 flex items-center justify-center">
              {previewAsset.type === "image" ? (
                <motion.img
                  key={previewAsset.id}
                  src={previewAsset.url}
                  alt={previewAsset.name}
                  initial={{ opacity: 0, scale: 0.97 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                  className="max-h-full max-w-full object-contain"
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <iframe
                  key={previewAsset.id}
                  src={previewAsset.url}
                  title={previewAsset.name}
                  className="w-full h-full bg-white"
                  onClick={(e) => e.stopPropagation()}
                />
              )}

              {/* Prev / Next */}
              {previewIndex > 0 && (
                <button
                  onClick={(e) => { e.stopPropagation(); setPreviewAsset(previewList[previewIndex - 1]); }}
                  title="Previous (←)"
                  className="absolute left-3 top-1/2 -translate-y-1/2 p-3 rounded-full bg-black/50 hover:bg-black/70 text-white border border-white/20 backdrop-blur-sm transition-colors"
                >
                  <ChevronLeft className="w-6 h-6" />
                </button>
              )}
              {previewIndex >= 0 && previewIndex < previewList.length - 1 && (
                <button
                  onClick={(e) => { e.stopPropagation(); setPreviewAsset(previewList[previewIndex + 1]); }}
                  title="Next (→)"
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-3 rounded-full bg-black/50 hover:bg-black/70 text-white border border-white/20 backdrop-blur-sm transition-colors"
                >
                  <ChevronRight className="w-6 h-6" />
                </button>
              )}
            </div>
          </motion.div>
        )}
        </AnimatePresence>

        {/* SPREADSHEET TABLE MODAL OVERLAY */}
        {selectedMatrix && (
          <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-[#122027]/90 backdrop-blur-md animate-in fade-in duration-200">
            <div className="bg-white rounded-3xl w-full max-w-6xl h-[85vh] overflow-hidden shadow-2xl flex flex-col border border-white/20">
              <div className="p-6 border-b flex justify-between items-center bg-slate-50">
                <h2 className="text-xl font-black text-[#122027]">
                  {selectedMatrix.title}
                </h2>
                <button
                  onClick={() => setSelectedMatrix(null)}
                  className="p-2 hover:bg-slate-200 text-[#768994] hover:text-rose-600 rounded-full transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="p-6 overflow-auto bg-white flex-1 w-full max-w-full">
                <div
                  className="wrike-matrix-render overflow-x-auto min-w-full pb-4"
                  dangerouslySetInnerHTML={{ __html: selectedMatrix.tableHtml }}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
