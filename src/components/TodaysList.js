import React, { useState, useEffect, useRef, useMemo } from "react";
import { motion } from "framer-motion";
import {
  LayoutList,
  Film,
  Paperclip,
  ChevronDown,
  Star,
  Sparkle,
} from "lucide-react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { TERRITORY_FLAGS, MOTION_TEAM_NAME_MAP } from "../constants";
import { supabase } from "../lib/supabaseClient";
import { fullName as cleanFullName } from "../lib/formatName";
import { useMotionBoardTasks } from "../hooks/useMotionBoardTasks";
import PageHeader from "./shared/PageHeader";
import TaskDetailModal, { FilePreviewLightbox } from "./TaskDetailModal";

gsap.registerPlugin(useGSAP);

const TEAM_MEMBERS = ["Antonio", "Aaron", "Jacqui", "Maria", "Nicholas", "Luke", "Turk"];

// Each artist owns a lane ("track") and an identity gradient — the same
// colour-as-identity system Home's rows use for pages, applied to people.
// Gradients are tuned so white display-size type holds ≥3:1 on the left
// edge; any lane whose gradient can't carry white flips to dark ink
// (ink: "dark") — the same rule Home applies to its amber row.
const MEMBER_LANES = {
  Antonio: { gradient: "from-blue-500 to-indigo-600",   ink: "light", dot: "bg-blue-500" },
  Aaron:   { gradient: "from-purple-500 to-violet-600", ink: "light", dot: "bg-purple-500" },
  Jacqui:  { gradient: "from-fuchsia-500 to-pink-600",  ink: "light", dot: "bg-fuchsia-500" },
  Maria:   { gradient: "from-emerald-600 to-teal-600",  ink: "light", dot: "bg-emerald-600" },
  Nicholas:{ gradient: "from-cyan-600 to-sky-600",      ink: "light", dot: "bg-cyan-600" },
  Luke:    { gradient: "from-orange-600 to-red-600",    ink: "light", dot: "bg-orange-600" },
  Turk:    { gradient: "from-red-600 to-rose-600",      ink: "light", dot: "bg-red-600" },
};

// Palette for department boards whose roster comes from profiles (Print and
// any future department) — assigned by lane index. Reuses the Motion lanes'
// tuned gradients + the same white/dark ink contrast rule.
const LANE_PALETTE = [
  { gradient: "from-blue-500 to-indigo-600",    ink: "light", dot: "bg-blue-500" },
  { gradient: "from-emerald-600 to-teal-600",   ink: "light", dot: "bg-emerald-600" },
  { gradient: "from-pink-600 to-rose-600",      ink: "light", dot: "bg-pink-600" },
  { gradient: "from-amber-300 to-yellow-400",   ink: "dark",  dot: "bg-amber-400" },
  { gradient: "from-purple-500 to-violet-600",  ink: "light", dot: "bg-purple-500" },
  { gradient: "from-orange-600 to-red-600",     ink: "light", dot: "bg-orange-600" },
  { gradient: "from-cyan-600 to-sky-600",       ink: "light", dot: "bg-cyan-600" },
  { gradient: "from-fuchsia-600 to-pink-600",   ink: "light", dot: "bg-fuchsia-600" },
  { gradient: "from-lime-400 to-green-500",     ink: "dark",  dot: "bg-lime-500" },
  { gradient: "from-slate-500 to-slate-700",    ink: "light", dot: "bg-slate-500" },
];

// Derive a board team from profiles tagged with `department` (Print, and any
// department that later gets its own board). Members, lane colours, the
// Wrike-id→member map (for id-based task assignment) and the id list for the
// task fetch all come straight from the profiles rows. Disabled → empty, so
// the Motion board (which passes enabled=false) never triggers the query.
function useDepartmentTeam(department, enabled) {
  const empty = { members: [], lanes: {}, wrikeIdToMember: {}, teamWrikeIds: [] };
  const [team, setTeam] = useState({ ...empty, loading: enabled });

  useEffect(() => {
    if (!enabled) { setTeam({ ...empty, loading: false }); return; }
    let cancelled = false;
    setTeam((t) => ({ ...t, loading: true }));
    supabase
      .from("profiles")
      .select("wrike_user_id, first_name, last_name")
      .eq("department", department)
      .order("first_name")
      .then(({ data }) => {
        if (cancelled) return;
        const rows = (data || []).filter((p) => p.wrike_user_id);
        const members = [], lanes = {}, wrikeIdToMember = {}, teamWrikeIds = [];
        const seen = new Set();
        rows.forEach((p, i) => {
          const base = cleanFullName(p.first_name, p.last_name, p.wrike_user_id);
          // Keep lane keys unique even if two people share a display name.
          let label = base, n = 2;
          while (seen.has(label)) label = `${base} (${n++})`;
          seen.add(label);
          members.push(label);
          lanes[label] = LANE_PALETTE[i % LANE_PALETTE.length];
          wrikeIdToMember[p.wrike_user_id] = label;
          teamWrikeIds.push(p.wrike_user_id);
        });
        setTeam({ members, lanes, wrikeIdToMember, teamWrikeIds, loading: false });
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [department, enabled]);

  return team;
}

// Play the full lane entrance once per app session; later visits get the
// shortened rise — same pacing contract as Home's menu.
let boardEntrancePlayed = false;

const prefersReducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const INITIAL_CAMPAIGNS = [];

const FALLBACK_FLAGS = {
  UAE: "🇦🇪", SPAIN: "🇪🇸", ES: "🇪🇸", GER: "🇩🇪", GERMANY: "🇩🇪",
  FRA: "🇫🇷", FRANCE: "🇫🇷", TW: "🇹🇼", TAIWAN: "🇹🇼", CZ: "🇨🇿",
  CZECH: "🇨🇿", AUSTRIA: "🇦🇹", PHILIPPINES: "🇵🇭", PH: "🇵🇭",
  AUS: "🇦🇺", AUSTRALIA: "🇦🇺", BRA: "🇧🇷", BRAZIL: "🇧🇷",
  UK: "🇬🇧", GB: "🇬🇧", INT: "🌍", INTL: "🌍", ROW: "🌐", LATAM: "🌎",
  MEX: "🇲🇽", MEXICO: "🇲🇽", ITA: "🇮🇹", ITALY: "🇮🇹",
  NETHERLANDS: "🇳🇱", NL: "🇳🇱", MALAYSIA: "🇲🇾", MY: "🇲🇾",
  INDIA: "🇮🇳", IN: "🇮🇳", SLOVAKIA: "🇸🇰", SK: "🇸🇰",
  SIN: "🇸🇬", SINGAPORE: "🇸🇬", IRE: "🇮🇪", IRELAND: "🇮🇪",
  UY: "🇺🇾", HUNGARY: "🇭🇺",
};

const getTerritoryData = (title) => {
  if (!title) return { name: "UNKNOWN", flag: "🎬" };
  const words = title.toUpperCase().split(/[\s\-_]+/);
  if (typeof TERRITORY_FLAGS !== "undefined" && TERRITORY_FLAGS) {
    for (const word of words) {
      if (TERRITORY_FLAGS[word]) return { name: word, flag: TERRITORY_FLAGS[word] };
    }
  }
  for (const word of words) {
    if (FALLBACK_FLAGS[word]) return { name: word, flag: FALLBACK_FLAGS[word] };
  }
  return { name: "GLOBAL", flag: "🎬" };
};

const getTagStyle = (tag) => {
  const base = "text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded border whitespace-nowrap";
  if (!tag) return `${base} bg-slate-100 text-slate-500 border-slate-200`;
  const t = String(tag).toLowerCase();
  if (t.includes("to amend"))          return `${base} bg-rose-50 text-rose-600 border-rose-200`;
  if (t.includes("render review"))     return `${base} bg-indigo-50 text-indigo-600 border-indigo-200`;
  if (t.includes("revised"))           return `${base} bg-teal-50 text-teal-600 border-teal-200`;
  if (t.includes("creative approved")) return `${base} bg-blue-50 text-blue-600 border-blue-200`;
  if (t.includes("content approved"))  return `${base} bg-purple-50 text-purple-600 border-purple-200`;
  if (t.includes("client review") || t.includes("content review")) return `${base} bg-yellow-50 text-yellow-600 border-yellow-200`;
  if (t.includes("motion"))            return `${base} bg-emerald-50 text-emerald-600 border-emerald-200`;
  if (t.includes("digital"))           return `${base} bg-cyan-50 text-cyan-600 border-cyan-200`;
  if (t.includes("prep for delivery")) return `${base} bg-orange-50 text-orange-600 border-orange-200`;
  if (t === "delivering" || t === "delivery") return `${base} bg-yellow-100 text-yellow-700 border-yellow-400`;
  if (t.includes("on hold"))           return `${base} bg-red-50 text-red-600 border-red-200`;
  if (t.includes("pm"))                return `${base} bg-fuchsia-50 text-fuchsia-600 border-fuchsia-200`;
  if (t.includes("backlog"))           return `${base} bg-slate-100 text-slate-500 border-slate-200`;
  return `${base} bg-slate-100 text-slate-500 border-slate-200`;
};

const getBorderColorClass = (tag) => {
  if (!tag) return "border-l-slate-300";
  const t = String(tag).toLowerCase();
  if (t.includes("to amend"))          return "border-l-rose-400";
  if (t.includes("render review"))     return "border-l-indigo-400";
  if (t.includes("revised"))           return "border-l-teal-400";
  if (t.includes("creative approved")) return "border-l-blue-400";
  if (t.includes("content approved"))  return "border-l-purple-400";
  if (t.includes("client review") || t.includes("content review")) return "border-l-yellow-400";
  if (t.includes("motion"))            return "border-l-emerald-400";
  if (t.includes("digital"))           return "border-l-cyan-400";
  if (t.includes("prep for delivery")) return "border-l-orange-400";
  if (t === "delivering" || t === "delivery") return "border-l-yellow-500";
  if (t.includes("on hold"))           return "border-l-red-400";
  if (t.includes("pm"))                return "border-l-fuchsia-400";
  return "border-l-transparent";
};

// Same hue as getBorderColorClass, as text — lets the status word in the
// card's meta line carry the accent instead of a full chip.
const getTagTextColorClass = (tag) => {
  if (!tag) return "text-slate-400";
  const t = String(tag).toLowerCase();
  if (t.includes("to amend"))          return "text-rose-500";
  if (t.includes("render review"))     return "text-indigo-500";
  if (t.includes("revised"))           return "text-teal-600";
  if (t.includes("creative approved")) return "text-blue-500";
  if (t.includes("content approved"))  return "text-purple-500";
  if (t.includes("client review") || t.includes("content review")) return "text-yellow-600";
  if (t.includes("motion"))            return "text-emerald-600";
  if (t.includes("digital"))           return "text-cyan-600";
  if (t.includes("prep for delivery")) return "text-orange-500";
  if (t === "delivering" || t === "delivery") return "text-yellow-700";
  if (t.includes("on hold"))           return "text-red-500";
  if (t.includes("pm"))                return "text-fuchsia-500";
  return "text-slate-500";
};

// Status as a small dot — used on the dark slate where the light chip
// palette of getTagStyle would not survive. Same semantic hues as
// getBorderColorClass (literal classes so Tailwind's scanner sees them).
const getStatusDotClass = (tag) => {
  if (!tag) return "bg-slate-400";
  const t = String(tag).toLowerCase();
  if (t.includes("to amend"))          return "bg-rose-400";
  if (t.includes("render review"))     return "bg-indigo-400";
  if (t.includes("revised"))           return "bg-teal-400";
  if (t.includes("creative approved")) return "bg-blue-400";
  if (t.includes("content approved"))  return "bg-purple-400";
  if (t.includes("client review") || t.includes("content review")) return "bg-yellow-400";
  if (t.includes("motion"))            return "bg-emerald-400";
  if (t.includes("digital"))           return "bg-cyan-400";
  if (t.includes("prep for delivery")) return "bg-orange-400";
  if (t === "delivering" || t === "delivery") return "bg-yellow-500";
  if (t.includes("on hold"))           return "bg-red-400";
  if (t.includes("pm"))                return "bg-fuchsia-400";
  return "bg-slate-400";
};

const sortTasksByStatus = (tasks) => {
  const getPriority = (tag) => {
    if (!tag) return 50;
    const t = tag.toLowerCase();
    if (t.includes("to amend"))  return 1;
    if (t.includes("motion"))    return 2;
    if (t.includes("digital"))   return 3;
    if (t.includes("revised"))   return 4;
    if (t.includes("review"))    return 5;
    if (t.includes("approved"))  return 6;
    if (t.includes("prep"))      return 7;
    if (t.includes("deliver"))   return 8;
    if (t.includes("pm"))        return 9;
    if (t.includes("backlog"))   return 10;
    if (t.includes("on hold"))   return 100;
    return 50;
  };
  return [...tasks].sort((a, b) => {
    const pA = getPriority(a.tag), pB = getPriority(b.tag);
    if (pA !== pB) return pA - pB;
    const cA = a.campaignName || "", cB = b.campaignName || "";
    if (cA !== cB) return cA.localeCompare(cB);
    return (a.title || "").localeCompare(b.title || "");
  });
};

// Resolve a usable MIME type for a Wrike attachment (its download response is
// often application/octet-stream, which makes the browser show a blank page).
function mimeForAttachment(att) {
  if (att.contentType && att.contentType !== "application/octet-stream") return att.contentType;
  const ext = (att.name || "").split(".").pop().toLowerCase();
  const MAP = {
    pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp", bmp: "image/bmp", tiff: "image/tiff",
    svg: "image/svg+xml", mp4: "video/mp4", mov: "video/quicktime", txt: "text/plain",
  };
  return MAP[ext] || "application/octet-stream";
}

function attachmentKind(att) {
  const mime = mimeForAttachment(att);
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("video/")) return "video";
  return "other";
}

function AttachmentThumb({ attachment, large = false, onPreview }) {
  const [loading, setLoading] = useState(false);
  const ext = (attachment.name || "").split(".").pop().toLowerCase();
  const dim = large ? "w-24 h-24" : "w-14 h-14";
  const kind = attachmentKind(attachment);

  const { icon, bg } = kind === "pdf"
    ? { icon: "📄", bg: "bg-red-50 border-red-200" }
    : kind === "image"
    ? { icon: "🖼️", bg: "bg-sky-50 border-sky-200" }
    : kind === "video"
    ? { icon: "🎬", bg: "bg-purple-50 border-purple-200" }
    : ["psd","ai","eps","aep","prproj"].includes(ext)
    ? { icon: "🎨", bg: "bg-orange-50 border-orange-200" }
    : ["zip","rar","7z"].includes(ext)
    ? { icon: "📦", bg: "bg-slate-100 border-slate-200" }
    : ["doc","docx","txt"].includes(ext)
    ? { icon: "📝", bg: "bg-blue-50 border-blue-200" }
    : ["xls","xlsx","csv"].includes(ext)
    ? { icon: "📊", bg: "bg-green-50 border-green-200" }
    : { icon: "📎", bg: "bg-slate-50 border-slate-200" };

  // The /tasks/{id}/attachments objects don't carry a usable `url`; build the
  // documented download endpoint from the attachment id instead.
  const downloadUrl = `/api/wrike/attachments/${attachment.id}/download`;

  const handleOpen = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (loading) return;
    setLoading(true);
    try {
      const res = await fetch(downloadUrl);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const raw = await res.blob();
      // Re-type the blob so the browser knows how to render it
      const typed = new Blob([raw], { type: mimeForAttachment(attachment) });
      const obj = URL.createObjectURL(typed);
      onPreview?.({ url: obj, name: attachment.name, kind, isObjectUrl: true });
    } catch (err) {
      console.warn("Attachment preview failed:", err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={handleOpen}
      title={attachment.name}
      className={`relative shrink-0 ${dim} rounded-xl border ${bg} flex flex-col items-center justify-center gap-1 hover:shadow-md hover:scale-105 transition-all`}
    >
      {loading ? (
        <div className="w-4 h-4 border-2 border-slate-300 border-t-[#12a0e1] rounded-full animate-spin" />
      ) : (
        <>
          <span className={large ? "text-3xl" : "text-xl"}>{icon}</span>
          <span className="text-[7px] font-black text-slate-400 uppercase tracking-wide px-1 text-center leading-none">
            {(ext || "file").slice(0, 6)}
          </span>
        </>
      )}
    </button>
  );
}

export default function TodaysList({ wrikeData, triggerToast: _triggerToast, isActive = true, department }) {
  const triggerToast = _triggerToast ?? ((msg) => console.warn("Toast:", msg));

  // Every non-Motion department (Print, AM, Digital, ...) drives the board
  // off its own profiles-tagged roster; Motion keeps its hardcoded team +
  // Riccardo slate exactly as before. `board` is the single config the rest
  // of the component reads — members, lane colours, how tasks map to people,
  // and the slate.
  const usesDeptRoster = !!department && department !== "Motion";
  const deptTeam = useDepartmentTeam(department, usesDeptRoster);
  const board = useMemo(() => (
    usesDeptRoster
      ? {
          members: deptTeam.members,
          lanes: deptTeam.lanes,
          subtitle: `${department} Tasks Allocation`,
          matchBy: "id",
          wrikeIdToMember: deptTeam.wrikeIdToMember,
          slateLead: null,
          slateName: null,
        }
      : {
          members: TEAM_MEMBERS,
          lanes: MEMBER_LANES,
          subtitle: "Motioners Tasks Allocation",
          matchBy: "name",
          nameMap: MOTION_TEAM_NAME_MAP,
          slateLead: "Riccardo",
          slateName: "Riccardo's Slate",
        }
  ), [usesDeptRoster, department, deptTeam]);

  // Each non-Motion department scopes its board state cache under its own
  // key so saved assignments never collide across departments or with
  // Motion's.
  const storageKey = usesDeptRoster
    ? `${department.toLowerCase()}_board_state_v1`
    : "motion_board_state_v1";

  // Motion resolves its team internally (undefined); every other department
  // feeds its roster's Wrike ids so the fetch only pulls that team's tasks.
  const { boardTasks } = useMotionBoardTasks(usesDeptRoster ? deptTeam.teamWrikeIds : undefined);
  const boardRef = useRef(null);
  const wasActiveRef = useRef(false);

  const [campaigns, setCampaigns] = useState(INITIAL_CAMPAIGNS);
  const [assignments, setAssignments] = useState(
    TEAM_MEMBERS.reduce((acc, name) => ({ ...acc, [name]: [] }), {})
  );
  const [timeframe, setTimeframe] = useState("Today");
  const [focusedPerson, setFocusedPerson] = useState(null);
  const saveTimeout = useRef(null);

  // --- Jacqui/Maria lane-cap hover flourish: stars + glitter, re-rolled
  // fresh on every hover rather than a single fixed layout. A bump counter
  // per person (rather than storing the particle arrays directly) keeps the
  // random draw itself inside the memo below, deterministic per render.
  const GLITTER_PEOPLE = ["Jacqui", "Maria"];
  const [glitterNonce, setGlitterNonce] = useState({ Jacqui: 0, Maria: 0 });
  const rollGlitter = (person) => {
    if (!GLITTER_PEOPLE.includes(person)) return;
    setGlitterNonce((n) => ({ ...n, [person]: n[person] + 1 }));
  };
  const glitterParticles = useMemo(() => {
    // Small seeded PRNG (mulberry32) — deterministic per (person, nonce) pair
    // so a re-render mid-hover doesn't reshuffle particles under the cursor.
    const mulberry32 = (seed) => () => {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
      t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const build = (baseSeed) => {
      const next = mulberry32(baseSeed);
      const particle = (kind) => ({
        kind,
        left: `${Math.round(next() * 94) + 2}%`,
        size: kind === "star" ? 7 + Math.round(next() * 8) : 4 + Math.round(next() * 5),
        delay: Math.round(next() * 500),
        duration: kind === "star" ? 900 + Math.round(next() * 700) : 700 + Math.round(next() * 600),
        drift: Math.round((next() - 0.5) * 40),
        rotMid: Math.round(next() * 90 - 20),
        rotEnd: Math.round(next() * 260 + 60),
        hue: Math.round(next() * 360),
      });
      const stars = Array.from({ length: 5 + Math.floor(next() * 3) }, () => particle("star"));
      const glitter = Array.from({ length: 7 + Math.floor(next() * 5) }, () => particle("glitter"));
      return [...stars, ...glitter];
    };
    return {
      Jacqui: build(1000 + glitterNonce.Jacqui * 977),
      Maria: build(5000 + glitterNonce.Maria * 977),
    };
  }, [glitterNonce]);

  const [taskAttachments, setTaskAttachments] = useState({});
  const [attachmentsLoading, setAttachmentsLoading] = useState(false);
  const [showFilesPanel, setShowFilesPanel] = useState(false);
  const [selectedTask, setSelectedTask] = useState(null);
  const [previewFile, setPreviewFile] = useState(null);
  const [previewAttachments, setPreviewAttachments] = useState([]);

  // Revoke the object URL when the preview closes / changes
  useEffect(() => {
    return () => {
      if (previewFile?.isObjectUrl) URL.revokeObjectURL(previewFile.url);
    };
  }, [previewFile]);

  const TIMEFRAMES = ["Today", "Tomorrow", "Next Week"];

  // ── Entrance choreography ─────────────────────────────────────────────────
  // The board stays mounted while hidden, so the entrance runs when the tab
  // becomes active rather than on mount. Same vocabulary as Home: lane-cap
  // names masked-rise inside their overflow-hidden caps (no opacity on type),
  // cards drift up with a light fade. Full ceremony once per session, the
  // shortened rise on every visit after. Also replays (lane + card layer
  // only, not the outer page fade) whenever the timeframe filter changes,
  // since that swaps out the board's contents same as a fresh activation
  // would.
  useGSAP(
    () => {
      if (!isActive || prefersReducedMotion()) {
        wasActiveRef.current = isActive;
        return;
      }
      const q = gsap.utils.selector(boardRef);
      const rises = q("[data-lane-rise]");
      const cards = q("[data-card-rise]");
      if (!rises.length) { wasActiveRef.current = isActive; return; }

      const justActivated = !wasActiveRef.current;
      wasActiveRef.current = true;

      const first = !boardEntrancePlayed;
      boardEntrancePlayed = true;

      const tl = gsap.timeline();

      // The board stays mounted across nav (see App.jsx) instead of going
      // through the other pages' AnimatePresence/PAGE_VARIANTS swap, so it
      // never got their y:12->0 fade-up on the outer container — it just
      // popped in via the display:none/block toggle. Replicate that same
      // page-swap motion here, only on a real tab activation (not on a
      // timeframe switch, where the page is already sitting in view).
      if (justActivated) {
        gsap.set(boardRef.current, { y: 12, opacity: 0 });
        tl.to(boardRef.current, { y: 0, opacity: 1, duration: 0.25, ease: "power2.out" }, 0);
      }

      // Cards scatter in — random landing offset + rotation per card — rather
      // than a uniform y-drift in DOM order, so the kanban chips and lane
      // cards read as settling into place instead of marching in one by one.
      gsap.set(cards, {
        x: () => gsap.utils.random(-16, 16),
        y: () => gsap.utils.random(-10, 24),
        rotation: () => gsap.utils.random(-4, 4),
        opacity: 0,
      });
      tl
        .set(rises, { yPercent: first ? 120 : 45 }, 0)
        .to(rises, {
          yPercent: 0,
          duration: first ? 0.7 : 0.35,
          ease: "expo.out",
          stagger: first ? 0.05 : 0.02,
        }, 0.05)
        // Position and opacity run on separate eases so the card doesn't
        // read fully-visible-but-still-sliding: power3.out front-loads the
        // landing motion, while opacity ramps in on power1.in — slow at
        // first, catching up to finish alongside the settle instead of
        // racing ahead of it.
        .to(cards, {
          x: 0,
          y: 0,
          rotation: 0,
          duration: 0.45,
          ease: "power3.out",
          stagger: 0.015,
        }, 0.05)
        .to(cards, {
          opacity: 1,
          duration: 0.45,
          ease: "power1.in",
          stagger: 0.015,
        }, 0.05);
    },
    { dependencies: [isActive, timeframe], scope: boardRef }
  );

  // ── Board persistence ─────────────────────────────────────────────────────
  // Load saved board state from Supabase on mount
  useEffect(() => {
    const local = localStorage.getItem(storageKey);
    if (local) {
      try {
        const parsed = JSON.parse(local);
        if (parsed.campaigns) setCampaigns(parsed.campaigns);
        if (parsed.assignments) setAssignments(parsed.assignments);
        if (parsed.timeframe) setTimeframe(parsed.timeframe);
      } catch (e) { /* ignore */ }
    }
  }, [storageKey]);

  // Fetch attachments for all tasks currently on the board.
  // Scoped to assigned tasks (~30) so we can fire one request per task without
  // worrying about rate limits — no reliance on unreliable hasAttachments field.
  useEffect(() => {
    if (!localStorage.getItem("wrike_user_id")) return;

    const assignedTasks = Object.values(assignments).flat();
    const seen = new Set();
    const unique = assignedTasks.filter(t => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });

    if (unique.length === 0) { setTaskAttachments({}); return; }

    setAttachmentsLoading(true);
    Promise.all(
      unique.map(boardTask => {
        return fetch(`/api/wrike/tasks/${boardTask.id}/attachments`)
          .then(r => r.json())
          // Only PDFs matter here (delivery specs) — images/docs/etc. are
          // dropped before they ever reach state or render a thumbnail.
          .then(data => ({ task: boardTask, attachments: (data.data || []).filter(a => attachmentKind(a) === "pdf") }))
          .catch(() => ({ task: boardTask, attachments: [] }));
      })
    ).then(results => {
      const map = {};
      results.forEach(({ task, attachments }) => {
        if (attachments.length > 0) map[task.id] = { task, attachments };
      });
      setTaskAttachments(map);
      setAttachmentsLoading(false);
    });
  }, [assignments]);

  // Debounced save whenever board state changes
  const saveBoardState = (newCampaigns, newAssignments, newTimeframe) => {
    const state = { campaigns: newCampaigns, assignments: newAssignments, timeframe: newTimeframe, savedAt: new Date().toISOString() };
    localStorage.setItem(storageKey, JSON.stringify(state));
    // Clear pending save
    if (saveTimeout.current) clearTimeout(saveTimeout.current);
  };


  const handleAutoAssign = (targetTimeframe = timeframe) => {
    if (!boardTasks || boardTasks.length === 0) {
      triggerToast("No Wrike data available yet.");
      return;
    }
    const freshAssignments = board.members.reduce((acc, name) => ({ ...acc, [name]: [] }), {});
    const freshBacklog = {};
    const now = new Date(); now.setHours(0, 0, 0, 0);
    let minDate, maxDate;
    if (targetTimeframe === "Today") {
      minDate = new Date(0);
      maxDate = new Date(now); maxDate.setHours(23, 59, 59, 999);
    } else if (targetTimeframe === "Tomorrow") {
      minDate = new Date(now); minDate.setDate(now.getDate() + 1);
      maxDate = new Date(minDate); maxDate.setHours(23, 59, 59, 999);
    } else {
      // Snap to the actual next Mon–Fri work week (matching the Timesheeter
      // tab's own Mon–Fri convention), not a rolling 7-day window — a fixed
      // +2..+8 offset drifts off the real calendar week depending on which
      // weekday "today" is, sometimes grabbing days still in *this* week
      // and cutting off days that are genuinely part of next week.
      const dayOfWeek = now.getDay(); // 0 = Sunday .. 6 = Saturday
      const daysUntilNextMonday = ((8 - dayOfWeek) % 7) || 7;
      minDate = new Date(now); minDate.setDate(now.getDate() + daysUntilNextMonday);
      maxDate = new Date(minDate); maxDate.setDate(minDate.getDate() + 4); maxDate.setHours(23, 59, 59, 999);
    }
    boardTasks.forEach((task) => {
      if (task.status !== "Active") return;
      if (!task.dueDate || task.dueDate === "No Due Date") return;
      const taskDate = new Date(task.dueDate);
      if (isNaN(taskDate.getTime()) || taskDate < minDate || taskDate > maxDate) return;
      const wrikeLink = task.permalink || `https://www.wrike.com/open.htm?id=${task.id}`;
      const card = {
        id: task.id, title: task.title,
        campaignId: task.parentIds?.[0] || "unknown",
        campaignName: task.projectName || "Wrike Import",
        tag: task.customStatusName || "Wrike",
        customStatusId: task.customStatusId,
        permalink: wrikeLink,
        dueDate: task.dueDate || null,
      };

      if (board.matchBy === "id") {
        // Print (profiles-derived): assign by Wrike responsibleId → member,
        // no slate. responsibleIds survive enrichment via the task spread.
        const targets = [...new Set((task.responsibleIds || []).map((id) => board.wrikeIdToMember[id]).filter(Boolean))];
        targets.forEach((boardName) => {
          if (freshAssignments[boardName]) freshAssignments[boardName].push(card);
        });
        return;
      }

      // Motion (name-based): the lead's tasks form the slate, everyone else's
      // land in their lane via the hardcoded name map.
      if (!task.assignees) return;
      if (board.slateLead && task.assignees.includes(board.slateLead)) {
        const campId = task.parentIds?.[0] || "camp-misc";
        const campName = task.projectName || "Misc / Uncategorized";
        if (!freshBacklog[campId]) freshBacklog[campId] = { id: campId, name: campName, subtasks: [] };
        freshBacklog[campId].subtasks.push({
          id: task.id, title: task.title,
          tag: task.customStatusName || "Backlog",
          customStatusId: task.customStatusId,
          permalink: wrikeLink,
        });
      } else {
        Object.keys(board.nameMap).forEach((wrikeName) => {
          if (task.assignees.includes(wrikeName)) {
            const boardName = board.nameMap[wrikeName];
            if (freshAssignments[boardName]) freshAssignments[boardName].push(card);
          }
        });
      }
    });
    for (const key in freshAssignments) freshAssignments[key] = sortTasksByStatus(freshAssignments[key]);
    const freshCampaigns = Object.values(freshBacklog);
    setAssignments(freshAssignments);
    setCampaigns(freshCampaigns);
    saveBoardState(freshCampaigns, freshAssignments, targetTimeframe);
  };

  // Rebuild the board from scratch whenever boardTasks gets a new reference —
  // the initial narrow fetch on mount, or a webhook-triggered update
  // (useMotionBoardTasks.js). No periodic polling involved on either side.
  useEffect(() => {
    if (!boardTasks || boardTasks.length === 0) return;
    handleAutoAssign(timeframe);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardTasks]);

  // Stats
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const isOverdue = (d) => d && d !== "No Due Date" && new Date(d) < today;
  const allAssigned = Object.values(assignments).flat();
  const backlogCount = campaigns.reduce((s, c) => s + c.subtasks.length, 0);
  const motionCount = allAssigned.filter((t) => (t.tag || "").toLowerCase().includes("motion")).length;
  const overdueCount = allAssigned.filter((t) => isOverdue(t.dueDate)).length;

  return (
    <div ref={boardRef} className="min-h-screen bg-slate-100 text-[#122027] font-sans selection:bg-[#12a0e1]/30 selection:text-[#122027]">
      <PageHeader pageId="todayslist" icon={LayoutList} title={`${timeframe}'s List`} subtitle={board.subtitle}>
        {/* The day's summary lives in the header, like a call sheet's totals —
            white figures on the page gradient instead of a floating card row */}
        <div className="flex items-center gap-6 mr-2">
          <div className="text-right">
            <div className="font-display text-2xl font-bold text-white leading-none">{allAssigned.length}</div>
            <div className="text-[9px] font-black uppercase tracking-widest text-white/70">on the board</div>
          </div>
          {board.slateLead && (
            <div className="text-right">
              <div className="font-display text-2xl font-bold text-white leading-none">{backlogCount}</div>
              <div className="text-[9px] font-black uppercase tracking-widest text-white/70">backlog</div>
            </div>
          )}
          <div className="text-right">
            <div className="font-display text-2xl font-bold text-white leading-none">{usesDeptRoster ? overdueCount : motionCount}</div>
            <div className="text-[9px] font-black uppercase tracking-widest text-white/70">{usesDeptRoster ? "overdue" : "motion"}</div>
          </div>
        </div>
        <div className="hidden sm:block w-px h-8 bg-white/20 mr-1" />
        <div className="flex bg-white/15 border border-white/20 backdrop-blur-sm p-1.5 rounded-xl">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              onClick={() => { setTimeframe(tf); handleAutoAssign(tf); }}
              className={`relative isolate px-4 py-2 text-xs font-black uppercase tracking-wider rounded-lg transition-colors ${
                timeframe === tf
                  ? "text-[#122027]"
                  : "text-white/80 hover:text-white hover:bg-white/10"
              }`}
            >
              {/* Shared layoutId — the pill slides between buttons instead
                  of popping on the newly-active one. */}
              {timeframe === tf && (
                <motion.span
                  layoutId="timeframe-pill"
                  className="absolute inset-0 bg-white rounded-lg shadow-sm"
                  transition={{ type: "spring", stiffness: 500, damping: 32 }}
                />
              )}
              <span className="relative z-10">{tf}</span>
            </button>
          ))}
        </div>
      </PageHeader>

      <div className="max-w-[1800px] mx-auto px-4 sm:px-6 py-6 flex flex-col gap-4">

        {/* ── The lead's Slate ─────────────────────────────────────────────
            The lead's triage pile as a film slate: one dark strip of ink,
            white type, campaign-grouped chips. The only dark block on the
            page — everything below it stays quiet so it reads as "not yet
            allocated" at a glance. Motion-only (Riccardo); department boards
            with no configured lead skip it. */}
        {board.slateLead && (
        <div className="bg-[#122027] rounded-2xl overflow-hidden shrink-0">
          <div className="flex items-center gap-4 px-5 pt-4 pb-3">
            <div className="overflow-hidden">
              <div data-lane-rise className="flex items-baseline gap-3">
                <h2 className="font-display text-lg font-bold text-white tracking-tight leading-none">{board.slateName}</h2>
                <span className="text-[10px] font-black uppercase tracking-widest text-white/50">
                  {campaigns.reduce((s, c) => s + c.subtasks.length, 0)} unallocated
                </span>
              </div>
            </div>
          </div>
          <div className="flex gap-6 px-5 pb-4 overflow-x-auto scrollbar-thin-dark">
            {campaigns.length === 0 ? (
              <p className="text-xs text-white/40 italic pb-1">Nothing on the slate for {timeframe.toLowerCase()}.</p>
            ) : campaigns.map((campaign) => (
              <div key={campaign.id} data-card-rise className="shrink-0 max-w-[340px]">
                <div className="flex items-center gap-1.5 mb-2">
                  <Film className="w-3 h-3 text-white/40 shrink-0" />
                  <h3 className="text-[10px] font-black text-white/60 uppercase tracking-widest truncate">{campaign.name}</h3>
                  <span className="text-[10px] font-bold text-white/35 shrink-0">{campaign.subtasks.length}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {campaign.subtasks.map((task) => {
                    const terr = getTerritoryData(task.title);
                    return (
                      <button
                        key={task.id}
                        onClick={() => setSelectedTask(task)}
                        title={`${task.title} — ${task.tag || ""}`}
                        className="flex items-center gap-1.5 bg-white/10 hover:bg-white/20 border border-white/10 rounded-lg px-2 py-1 transition-colors"
                      >
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${getStatusDotClass(task.tag)}`} />
                        <span className="text-xs leading-none shrink-0">{terr.flag}</span>
                        <span className="text-[10px] font-bold text-white/90 truncate max-w-[180px]">{task.title}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
        )}

          {/* Files panel */}
          {(attachmentsLoading || Object.keys(taskAttachments).length > 0) && (
            <div className="bg-white rounded-2xl border border-[#dce4ec] shadow-sm overflow-hidden shrink-0">
              <button
                onClick={() => setShowFilesPanel(p => !p)}
                className="w-full flex items-center gap-2 px-4 py-2.5 hover:bg-slate-50/60 transition-colors"
              >
                <Paperclip className="w-3.5 h-3.5 text-[#12a0e1]" />
                <span className="text-sm font-black text-[#122027] tracking-tight">Upcoming Files</span>
                <span className="text-[10px] font-bold text-[#768994] ml-1">
                  {attachmentsLoading
                    ? "Loading…"
                    : `${Object.values(taskAttachments).reduce((s, { attachments }) => s + attachments.length, 0)} files · ${Object.keys(taskAttachments).length} tasks`}
                </span>
                <ChevronDown
                  className={`w-3.5 h-3.5 text-slate-400 ml-auto transition-transform duration-200 ${showFilesPanel ? "" : "-rotate-90"}`}
                />
              </button>
              {showFilesPanel && !attachmentsLoading && (
                <div className="flex gap-6 px-4 pb-3 pt-0.5 overflow-x-auto scrollbar-thin">
                  {Object.values(taskAttachments).map(({ task, attachments }) => (
                    <div key={task.id} className="shrink-0 flex flex-col gap-1.5">
                      <div>
                        <p className="text-[9px] font-black uppercase tracking-widest text-[#12a0e1] truncate max-w-[200px]">
                          {task.projectName || ""}
                        </p>
                        <a
                          href={task.permalink || `https://www.wrike.com/open.htm?id=${task.id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[10px] font-bold text-[#122027] hover:text-[#12a0e1] truncate max-w-[200px] block transition-colors"
                        >
                          {task.title}
                        </a>
                      </div>
                      <div className="flex gap-1.5 flex-wrap" style={{ maxWidth: 200 }}>
                        {attachments.map(att => (
                          <AttachmentThumb key={att.id} attachment={att} onPreview={(file) => {
                            setPreviewFile(file);
                            setPreviewAttachments(attachments);
                          }} />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

        {/* ── The tracks ───────────────────────────────────────────────────
            One lane per artist, stacked like an edit timeline. The lane cap
            speaks Home's row language: display-type name, identity gradient
            that sweeps in on hover (origin left, ink flips), and stays
            washed while the lane is focused. Clicking a cap expands the
            lane; the others compress to slivers. */}
        <div className="bg-white rounded-2xl border border-[#dce4ec] shadow-sm overflow-hidden">
          {board.members.length === 0 && (
            <p className="text-sm text-slate-400 italic px-6 py-8 text-center">
              {usesDeptRoster
                ? `No ${department} team members yet — tag people's department as “${department}” in Administration › People.`
                : "No team members."}
            </p>
          )}
          {board.members.map((person, laneIdx) => {
            const tasks = assignments[person] || [];
            const lane = board.lanes[person];
            const isFocused = focusedPerson === person;
            const isCollapsed = focusedPerson !== null && !isFocused;
            const personOverdue = tasks.filter((t) => isOverdue(t.dueDate)).length;
            const inkHover = lane.ink === "dark" ? "group-hover:text-[#122027]" : "group-hover:text-white";
            const inkFocus = lane.ink === "dark" ? "text-[#122027]" : "text-white";

            return (
              <div
                key={person}
                className={`flex items-stretch transition-all duration-300 ease-in-out ${
                  laneIdx > 0 ? "border-t border-[#dce4ec]" : ""
                  // +8px over the "natural" 6.5rem/72 heights — the thin
                  // scrollbar's own height comes out of a fixed-height flex
                  // row's content box, so without this the cards lose that
                  // space and their titles clip instead of the scrollbar
                  // just sitting in a bit of slack underneath them.
                } ${isCollapsed ? "h-12" : isFocused ? "h-[18.5rem]" : "h-[7rem]"}`}
              >
                {/* Lane cap */}
                <button
                  onClick={() => setFocusedPerson((p) => (p === person ? null : person))}
                  onMouseEnter={() => rollGlitter(person)}
                  className="group relative w-44 sm:w-52 shrink-0 text-left px-5 border-r border-[#dce4ec] overflow-hidden"
                >
                  <div
                    className={`absolute inset-0 bg-gradient-to-r ${lane.gradient} origin-left transition-transform duration-300 ease-out ${
                      isFocused ? "scale-x-100" : "scale-x-0 group-hover:scale-x-100"
                    }`}
                  />
                  {/* Hover flourish, Jacqui & Maria only — a randomized
                      cascade of stars + glitter falling within this lane
                      cap's own bounding box (the button's overflow-hidden
                      clips them). onMouseEnter re-rolls the particle set
                      (glitterParticles memo above) so it's a fresh scatter
                      every hover, not one fixed layout; each particle's own
                      keyframe animation only exists while :hover applies via
                      group-hover:, so it restarts clean each time too. */}
                  {(person === "Jacqui" || person === "Maria") && (
                    <div className="absolute inset-0 z-[5] pointer-events-none overflow-hidden">
                      {glitterParticles[person].map((p, i) => {
                        const vars = {
                          left: `${p.left}`,
                          width: p.size,
                          height: p.size,
                          animationDelay: `${p.delay}ms`,
                          animationDuration: `${p.duration}ms`,
                          "--drift": `${p.drift}px`,
                          "--rot-mid": `${p.rotMid}deg`,
                          "--rot-end": `${p.rotEnd}deg`,
                        };
                        if (p.kind === "star") {
                          return (
                            <Star
                              key={i}
                              style={vars}
                              className={`absolute top-0 opacity-0 fill-current group-hover:animate-star-fall ${
                                lane.ink === "dark" ? "text-[#122027]/70" : "text-white/90"
                              }`}
                            />
                          );
                        }
                        return (
                          <Sparkle
                            key={i}
                            style={{ ...vars, color: `hsl(${p.hue}, 85%, 80%)` }}
                            className="absolute top-0 opacity-0 fill-current group-hover:animate-glitter-twinkle"
                          />
                        );
                      })}
                    </div>
                  )}
                  <div className="relative z-10 h-full flex flex-col justify-center overflow-hidden">
                    <div data-lane-rise className="flex items-baseline justify-between gap-2">
                      <span
                        className={`font-display font-bold tracking-tight leading-none transition-all duration-300 ${
                          isCollapsed ? "text-sm" : "text-xl sm:text-2xl"
                        } ${isFocused ? inkFocus : `text-[#122027] ${inkHover}`}`}
                      >
                        {person}
                      </span>
                      <span
                        className={`font-display font-bold leading-none transition-colors duration-300 ${
                          isCollapsed ? "text-sm" : "text-xl"
                        } ${
                          isFocused
                            ? lane.ink === "dark" ? "text-[#122027]/60" : "text-white/60"
                            : `text-[#c6d0da] ${lane.ink === "dark" ? "group-hover:text-[#122027]/60" : "group-hover:text-white/60"}`
                        }`}
                      >
                        {tasks.length}
                      </span>
                    </div>
                    {!isCollapsed && personOverdue > 0 && (
                      <span
                        className={`mt-1.5 self-start text-[9px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded transition-colors duration-300 ${
                          isFocused || lane.ink === "dark"
                            ? "bg-[#122027]/15"
                            : "bg-rose-50 text-rose-600 group-hover:bg-white/20"
                        } ${isFocused ? (lane.ink === "dark" ? "text-[#122027]" : "text-white") : lane.ink === "dark" ? "text-rose-600" : "group-hover:text-white"}`}
                      >
                        {personOverdue} overdue
                      </span>
                    )}
                  </div>
                </button>

                {/* Lane body — tasks flow horizontally like clips on a track */}
                <div className={`flex-1 min-w-0 flex items-stretch gap-2 overflow-x-auto overflow-y-hidden scrollbar-thin ${isCollapsed ? "px-3 py-1.5" : "p-3"}`}>
                  {isCollapsed ? (
                    <div className="flex items-center gap-1.5">
                      {tasks.slice(0, 12).map((t) => (
                        <span key={t.id} title={t.title} className={`w-2 h-2 rounded-full shrink-0 ${getStatusDotClass(t.tag)}`} />
                      ))}
                      {tasks.length > 12 && <span className="text-[10px] font-bold text-[#768994]">+{tasks.length - 12}</span>}
                    </div>
                  ) : tasks.length === 0 ? (
                    <p className="self-center text-xs italic text-slate-300">Clear — nothing due</p>
                  ) : (
                    tasks.map((task) => {
                      const terr = getTerritoryData(task.title);
                      const overdue = isOverdue(task.dueDate);
                      return (
                        // A clip, not a dashboard widget: the left bar is the
                        // single colour statement (status), the title is the
                        // single loud element, and everything else — campaign,
                        // status word, files — recedes to muted plain text.
                        // No chips inside cards inside lanes.
                        <div
                          key={task.id}
                          data-card-rise
                          onClick={() => setSelectedTask(task)}
                          className={`shrink-0 cursor-pointer rounded-lg border-l-[3px] ${getBorderColorClass(task.tag)} border-y border-r border-slate-200/70 ${
                            overdue ? "bg-rose-50/40" : "bg-white"
                          } hover:shadow-md hover:-translate-y-0.5 transition-all ${
                            isFocused ? "w-72 p-3.5" : "w-60 px-3 py-2.5"
                          } flex flex-col min-h-0 overflow-hidden`}
                        >
                          <div className="flex items-center justify-between gap-2 min-w-0">
                            <p className="text-[9px] font-bold uppercase text-[#768994] tracking-widest truncate">
                              {task.campaignName}
                            </p>
                            <span className="text-xs leading-none shrink-0" title={terr.name}>{terr.flag}</span>
                          </div>
                          <p className={`text-xs font-bold text-[#122027] leading-snug mt-1 ${isFocused ? "line-clamp-3" : "line-clamp-2"}`}>
                            {task.title}
                          </p>
                          <div className="mt-auto pt-1.5 flex items-center gap-1 text-[10px] font-medium text-[#768994] min-w-0">
                            {task.tag && (
                              <span className={`truncate font-bold ${getTagTextColorClass(task.tag)}`}>
                                {task.tag.toLowerCase()}
                              </span>
                            )}
                            {overdue && (
                              <>
                                <span className="shrink-0">·</span>
                                <span className="text-rose-500 font-bold shrink-0">overdue</span>
                              </>
                            )}
                            {isFocused && !overdue && task.dueDate && (
                              <>
                                <span className="shrink-0">·</span>
                                <span className="shrink-0">
                                  due {new Date(task.dueDate).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
                                </span>
                              </>
                            )}
                            {taskAttachments[task.id] && (
                              <span className="flex items-center gap-0.5 shrink-0 ml-auto">
                                <Paperclip className="w-2.5 h-2.5" />
                                {taskAttachments[task.id].attachments.length}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })}
        </div>

      </div>

      {/* Task detail modal (shared component — same as Profile Hub) */}
      <TaskDetailModal
        task={selectedTask}
        wrikeData={wrikeData}
        attachments={selectedTask ? taskAttachments[selectedTask.id]?.attachments : undefined}
        onClose={() => setSelectedTask(null)}
        triggerToast={triggerToast}
      />

    {/* File preview lightbox (Upcoming Files panel) */}
    <FilePreviewLightbox
      file={previewFile}
      onClose={() => setPreviewFile(null)}
      allAttachments={previewAttachments}
      onNavigate={setPreviewFile}
    />
    </div>
  );
}