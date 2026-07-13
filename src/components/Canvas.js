import React, { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { supabase } from "../lib/supabaseClient";
import { getFilmName } from "../lib/wrikeEnrich";
import MDEditor from "@uiw/react-md-editor";
import "@uiw/react-md-editor/markdown-editor.css";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import PageHeader, { pageHeaderActionClass } from "./shared/PageHeader";
import { FILM_MAPPINGS } from "../constants.js";
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

// --- Shared collapsible card shell for the two Reference note sections ---
function CollapsibleCard({ icon, title, subtitle, isOpen, onToggle, children }) {
  return (
    <section className="rounded-3xl bg-white/60 border border-[#dce4ec] shadow-sm p-5 sm:p-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onToggle(); }}
        className="flex items-center gap-3 cursor-pointer select-none"
      >
        <div className="w-9 h-9 rounded-xl bg-[#12a0e1]/10 text-[#12a0e1] flex items-center justify-center shadow-sm shrink-0">
          {icon}
        </div>
        <div className="mr-auto">
          <h2 className="text-lg font-black text-[#122027] tracking-tight leading-none">{title}</h2>
          <p className="text-[11px] font-bold text-[#768994] uppercase tracking-widest mt-1">{subtitle}</p>
        </div>
        <ChevronRight className={`w-4 h-4 text-[#768994] shrink-0 transition-transform ${isOpen ? "rotate-90" : ""}`} />
      </div>
      {isOpen && <div className="mt-4" onClick={(e) => e.stopPropagation()}>{children}</div>}
    </section>
  );
}

// --- Reference > End of Campaign Notes: pick a campaign, write markdown wrap-up notes ---
function EndOfCampaignNotesCard({ isOpen, onToggle, campaigns }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedCampaignId, setSelectedCampaignId] = useState(null);
  const [content, setContent] = useState("");
  const [loaded, setLoaded] = useState(false);
  const skipNextSaveRef = useRef(false);

  const selectedCampaign = campaigns.find((c) => c.id === selectedCampaignId);

  useEffect(() => {
    if (!selectedCampaignId) { setContent(""); setLoaded(false); return; }
    setLoaded(false);
    (async () => {
      const { data } = await supabase
        .from("campaign_eoc_notes")
        .select("content")
        .eq("campaign_id", selectedCampaignId)
        .maybeSingle();
      skipNextSaveRef.current = true;
      setContent(data?.content || "");
      setLoaded(true);
    })();
  }, [selectedCampaignId]);

  useEffect(() => {
    if (!selectedCampaignId || !loaded) return;
    if (skipNextSaveRef.current) { skipNextSaveRef.current = false; return; }
    const t = setTimeout(() => {
      supabase.from("campaign_eoc_notes").upsert({
        campaign_id: selectedCampaignId,
        content,
        updated_at: new Date().toISOString(),
      });
    }, 800);
    return () => clearTimeout(t);
  }, [content, selectedCampaignId, loaded]);

  const filteredCampaigns = campaigns.filter(
    (c) => !search.trim() || c.title.toLowerCase().includes(search.trim().toLowerCase())
  );

  return (
    <CollapsibleCard
      icon={<FileText className="w-5 h-5" />}
      title="End of Campaign Notes"
      subtitle="Wrap-up learnings · per campaign"
      isOpen={isOpen}
      onToggle={onToggle}
    >
      <div className="space-y-3">
        <div className="relative">
          <button
            onClick={() => setPickerOpen((v) => !v)}
            className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl border border-[#dce4ec] bg-white text-sm font-bold text-[#122027] hover:border-[#12a0e1]/40"
          >
            <span className={selectedCampaign ? "" : "text-[#768994] font-semibold"}>
              {selectedCampaign ? selectedCampaign.title : "Pick a campaign…"}
            </span>
            <ChevronRight className={`w-4 h-4 text-[#768994] shrink-0 transition-transform ${pickerOpen ? "rotate-90" : ""}`} />
          </button>
          {pickerOpen && (
            <div className="absolute z-20 mt-1 w-full max-h-64 overflow-y-auto rounded-xl border border-[#dce4ec] bg-white shadow-lg">
              <div className="p-2 sticky top-0 bg-white border-b border-[#dce4ec]">
                <input
                  autoFocus
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search campaigns…"
                  className="w-full px-2.5 py-1.5 rounded-lg border border-[#dce4ec] outline-none text-sm font-semibold"
                />
              </div>
              {filteredCampaigns.length === 0 && (
                <p className="p-3 text-xs font-bold text-[#768994]">No campaigns match.</p>
              )}
              {filteredCampaigns.map((c) => (
                <button
                  key={c.id}
                  onClick={() => { setSelectedCampaignId(c.id); setPickerOpen(false); setSearch(""); }}
                  className={`w-full text-left px-3 py-2 text-sm font-bold hover:bg-[#f2f6f9] ${c.id === selectedCampaignId ? "text-[#12a0e1]" : "text-[#122027]"}`}
                >
                  {c.title}
                </button>
              ))}
            </div>
          )}
        </div>

        {selectedCampaignId ? (
          <div data-color-mode="light" className="rounded-xl overflow-hidden border border-[#dce4ec]">
            <MDEditor value={content} onChange={(v) => setContent(v || "")} height={340} preview="live" />
          </div>
        ) : (
          <p className="text-center text-sm font-bold text-[#768994] py-8">Pick a campaign above to write its wrap-up notes.</p>
        )}
      </div>
    </CollapsibleCard>
  );
}

// --- Reference > Notes Canvas: folders/topics of freeform BlockNote pages ---
function NotesCanvasPageEditor({ page, onSave }) {
  const editor = useCreateBlockNote({
    initialContent: page.content && page.content.length ? page.content : undefined,
  });
  const saveTimerRef = useRef(null);
  const handleChange = () => {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => onSave(editor.document), 800);
  };
  useEffect(() => () => clearTimeout(saveTimerRef.current), []);
  return (
    <div className="min-h-[420px] max-h-[600px] overflow-y-auto">
      <BlockNoteView editor={editor} onChange={handleChange} theme="light" />
    </div>
  );
}

function NotesCanvasCard({ isOpen, onToggle }) {
  const [folders, setFolders] = useState([]);
  const [pages, setPages] = useState([]);
  const [selectedFolderId, setSelectedFolderId] = useState(null);
  const [selectedPageId, setSelectedPageId] = useState(null);
  const [addingFolder, setAddingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");

  useEffect(() => {
    if (!isOpen) return;
    (async () => {
      const [{ data: f }, { data: p }] = await Promise.all([
        supabase.from("canvas_notes_folders").select("*").order("created_at", { ascending: true }),
        supabase.from("canvas_notes_pages").select("*").order("created_at", { ascending: true }),
      ]);
      setFolders(f || []);
      setPages(p || []);
    })();
  }, [isOpen]);

  const addFolder = async () => {
    const name = newFolderName.trim();
    if (!name) { setAddingFolder(false); return; }
    const { data } = await supabase.from("canvas_notes_folders").insert({ name }).select().single();
    if (data) setFolders((prev) => [...prev, data]);
    setNewFolderName("");
    setAddingFolder(false);
  };

  const deleteFolder = async (folderId) => {
    await supabase.from("canvas_notes_folders").delete().eq("id", folderId);
    setFolders((prev) => prev.filter((f) => f.id !== folderId));
    setPages((prev) => prev.filter((p) => p.folder_id !== folderId));
    if (selectedFolderId === folderId) { setSelectedFolderId(null); setSelectedPageId(null); }
  };

  const addPage = async (folderId) => {
    const { data } = await supabase
      .from("canvas_notes_pages")
      .insert({ folder_id: folderId, title: "Untitled", content: [] })
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

  const savePageContent = async (pageId, blocks) => {
    setPages((prev) => prev.map((p) => (p.id === pageId ? { ...p, content: blocks } : p)));
    await supabase.from("canvas_notes_pages").update({ content: blocks, updated_at: new Date().toISOString() }).eq("id", pageId);
  };

  const selectedPage = pages.find((p) => p.id === selectedPageId);

  return (
    <CollapsibleCard
      icon={<Folder className="w-5 h-5" />}
      title="Notes Canvas"
      subtitle="Topics & pages · scratchpad"
      isOpen={isOpen}
      onToggle={onToggle}
    >
      <div className="flex flex-col sm:flex-row gap-4">
        {/* Sidebar: folders/topics + pages */}
        <div className="sm:w-56 shrink-0 space-y-3">
          <button
            onClick={() => setAddingFolder(true)}
            className="w-full flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#12a0e1]/10 text-[#12a0e1] text-[11px] font-black uppercase tracking-widest hover:bg-[#12a0e1]/20"
          >
            <FolderPlus className="w-3.5 h-3.5" /> New Topic
          </button>
          {addingFolder && (
            <div className="flex items-center gap-1.5">
              <input
                autoFocus
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") addFolder(); if (e.key === "Escape") { setAddingFolder(false); setNewFolderName(""); } }}
                placeholder="Topic name…"
                className="w-full px-2 py-1 rounded-lg border border-[#dce4ec] outline-none text-xs font-bold"
              />
              <button onClick={addFolder} className="p-1 rounded hover:bg-black/5"><Check className="w-3.5 h-3.5 text-[#12a0e1]" /></button>
            </div>
          )}
          <div className="space-y-1 max-h-[520px] overflow-y-auto">
            {folders.length === 0 && !addingFolder && (
              <p className="text-xs font-semibold text-[#768994] px-1">No topics yet.</p>
            )}
            {folders.map((folder) => {
              const folderPages = pages.filter((p) => p.folder_id === folder.id);
              const isExpanded = selectedFolderId === folder.id;
              return (
                <div key={folder.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedFolderId(isExpanded ? null : folder.id)}
                    className="group/folder flex items-center gap-1.5 px-1.5 py-1 rounded-lg cursor-pointer hover:bg-black/5"
                  >
                    <ChevronRight className={`w-3 h-3 shrink-0 text-[#768994] transition-transform ${isExpanded ? "rotate-90" : ""}`} />
                    <span className="text-xs font-bold text-[#122027] truncate flex-1">{folder.name}</span>
                    <span className="text-[10px] font-black text-[#768994]">{folderPages.length}</span>
                    <button
                      onClick={(e) => { e.stopPropagation(); deleteFolder(folder.id); }}
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
                          onClick={() => setSelectedPageId(page.id)}
                          className={`group/page flex items-center gap-1.5 px-1.5 py-1 rounded-lg cursor-pointer ${page.id === selectedPageId ? "bg-[#12a0e1]/10 text-[#12a0e1]" : "hover:bg-black/5 text-[#122027]"}`}
                        >
                          <FileText className="w-3 h-3 shrink-0" />
                          <span className="text-xs font-semibold truncate flex-1">{page.title || "Untitled"}</span>
                          <button
                            onClick={(e) => { e.stopPropagation(); deletePage(page.id); }}
                            className="opacity-0 group-hover/page:opacity-100 p-0.5 rounded hover:bg-red-50 text-red-400"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                      <button
                        onClick={() => addPage(folder.id)}
                        className="flex items-center gap-1 px-1.5 py-1 text-[11px] font-black text-[#12a0e1] hover:text-[#0f88c0]"
                      >
                        <Plus className="w-3 h-3" /> New page
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Main pane: selected page's BlockNote editor */}
        <div className="flex-1 min-w-0 rounded-xl border border-[#dce4ec] bg-white overflow-hidden">
          {selectedPage ? (
            <>
              <input
                value={selectedPage.title}
                onChange={(e) => renamePage(selectedPage.id, e.target.value)}
                className="w-full px-4 py-2.5 border-b border-[#dce4ec] outline-none text-sm font-black text-[#122027]"
                placeholder="Untitled"
              />
              <NotesCanvasPageEditor
                key={selectedPage.id}
                page={selectedPage}
                onSave={(blocks) => savePageContent(selectedPage.id, blocks)}
              />
            </>
          ) : (
            <p className="text-center text-sm font-bold text-[#768994] py-16 px-4">
              Pick or create a topic, then a page, to start scribbling.
            </p>
          )}
        </div>
      </div>
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
const STUDIO_ORDER = ["Universal", "Paramount", "Others", "Misc"];

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
      '<a href="$2" target="_blank" rel="noopener noreferrer" style="color: #12a0e1; text-decoration: underline; font-weight: 700;">$1</a>'
    ) // Links
    .replace(/\n/g, "<br/>"); // Newlines
  return html;
};

export default function CampaignCanvas({ wrikeData = [], folderCampaigns = [], triggerToast: _triggerToast, isLoading = false, syncNow, isSyncing = false, isAdmin = false, scanFilmMappings, isScanning = false, filmCodeMappings = {} }) {
  const triggerToast = _triggerToast ?? ((msg) => console.warn("Toast:", msg));
  const [campaigns, setCampaigns] = useState(INITIAL_CAMPAIGNS);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedMatrix, setSelectedMatrix] = useState(null);
  const [showMappingsPanel, setShowMappingsPanel] = useState(false);

  // --- COMMAND PALETTE STATE ---
  const [isPaletteOpen, setIsPaletteOpen] = useState(false);
  const [paletteSearch, setPaletteSearch] = useState("");

  // --- ACCORDION ANIMATION & SCROLL STATE ---
  const [expandedCampId, setExpandedCampId] = useState(null);

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

  // --- DOOH SPECS ---
  const [doohCountries, setDoohCountries] = useState([]);
  const [countryAssets, setCountryAssets] = useState({}); // { [countryId]: [asset] }
  const [selectedCountry, setSelectedCountry] = useState(null);
  const [isAddCountryOpen, setIsAddCountryOpen] = useState(false);
  const [newCountryName, setNewCountryName] = useState("");
  const [newCountryCode, setNewCountryCode] = useState("");
  const [countrySearch, setCountrySearch] = useState("");
  const [doohViewMode, setDoohViewMode] = useState(() => localStorage.getItem("dooh_view_mode") || "grid");

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
          studioHint: task.studioName || null,
        };
      } else if (!wrikeGroupedCampaigns[campaignTitle].studioHint && task.studioName) {
        wrikeGroupedCampaigns[campaignTitle].studioHint = task.studioName;
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
        document.documentElement.classList.toggle("dark-theme");
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
    <div className="min-h-screen bg-slate-100 text-[#122027] font-sans selection:bg-[#12a0e1]/30 selection:text-[#122027] pb-12">
      <style>{`
        /* --- SMOOTH ACCORDION ANIMATIONS --- */
        @keyframes accordionOpen {
          0% { opacity: 0; max-height: 0; margin-top: -2rem; margin-bottom: 0; transform: scaleY(0.95); transform-origin: top; }
          100% { opacity: 1; max-height: 1200px; margin-top: 1rem; margin-bottom: 3rem; transform: scaleY(1); transform-origin: top; }
        }
        @keyframes accordionClose {
          0% { opacity: 1; max-height: 1200px; margin-top: 1rem; margin-bottom: 3rem; transform: scaleY(1); transform-origin: top; }
          100% { opacity: 0; max-height: 0; margin-top: -2rem; margin-bottom: 0; transform: scaleY(0.95); transform-origin: top; }
        }
        .animate-accordion-open {
          animation: accordionOpen 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }
        .animate-accordion-close {
          animation: accordionClose 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }

        /* --- STANDARD STYLES --- */
        .wrike-matrix-render table { width: 100%; border-collapse: collapse; margin-top: 4px; font-size: 13px; }
        .wrike-matrix-render th { background-color: #122027; color: #ffffff; font-weight: 800; padding: 10px 14px; text-align: left; border: 1px solid #dce4ec; text-transform: uppercase; font-size: 11px; tracking: 0.05em; }
        .wrike-matrix-render td { padding: 10px 14px; border: 1px solid #dce4ec; font-weight: 500; color: #323b43; }
        .wrike-matrix-render tr:nth-child(even) { background-color: #f8fafc; }
        .wrike-matrix-render tr:hover { background-color: #12a0e1/5; }
        .wrike-matrix-render a { color: #12a0e1; font-weight: 700; text-decoration: underline; }
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
              <Search className="w-6 h-6 text-[#12a0e1]" />
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
                          <h4 className="text-base font-black text-[#122027] group-hover:text-[#12a0e1] tracking-tight transition-colors">
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
                      <span className="text-[10px] font-black uppercase tracking-widest text-[#768994] bg-white border border-slate-200 px-2.5 py-1.5 rounded-lg group-hover:text-[#12a0e1] group-hover:border-[#12a0e1]/30 group-hover:bg-[#12a0e1]/5 transition-colors flex items-center gap-1.5 shadow-sm">
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
                  <div className="bg-gradient-to-br from-[#12a0e1] to-[#1cc1a5] p-2.5 rounded-xl text-white shadow">
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
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-white border-b border-[#dce4ec]">
                    <tr>
                      <th className="text-left px-5 py-3 text-[10px] font-black tracking-widest text-[#768994] uppercase w-28">Code</th>
                      <th className="text-left px-5 py-3 text-[10px] font-black tracking-widest text-[#768994] uppercase">Film Name</th>
                      <th className="text-right px-5 py-3 text-[10px] font-black tracking-widest text-[#768994] uppercase">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allCodes.map((code, i) => {
                      const isHardcoded = !!hardcoded[code];
                      const name = hardcoded[code] || discovered[code];
                      return (
                        <tr key={code} className={i % 2 === 0 ? "bg-white" : "bg-slate-50/60"}>
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

      <div className="max-w-[1800px] mx-auto px-4 sm:px-6 pt-8">
        {/* --- PERFECTLY CENTERED ICON DOCK --- */}
        {isLoading && (
          <div className="flex items-center justify-center gap-2 py-3 text-xs font-bold text-[#768994]">
            <div className="w-3.5 h-3.5 border-2 border-[#12a0e1] border-t-transparent rounded-full animate-spin" />
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
            const studio = studioOverrides[camp.id] || auto || camp.studioHint || "Misc";
            const section = STUDIO_ORDER.includes(studio) ? studio : "Others";
            if (!acc[section]) acc[section] = [];
            acc[section].push(camp);
            return acc;
          }, {});

          // Others and Misc always show — Others for Sony/Warner/etc., Misc for manual adds
          const gallerySections = STUDIO_ORDER.filter(
            (s) => grouped[s]?.length > 0 || s === "Misc" || s === "Others"
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
            const isActive = updatedTs && (Date.now() - updatedTs) < 14 * 24 * 60 * 60 * 1000;

            return (
              <div
                key={camp.id}
                className="relative animate-in fade-in slide-in-from-bottom-3 duration-500"
                style={{ animationDelay: `${Math.min(index, 16) * 35}ms`, animationFillMode: "both" }}
              >
                <button
                  onClick={() => handleToggleCamp(camp.id)}
                  className="group relative w-full rounded-2xl overflow-hidden outline-none transition-[transform,box-shadow,filter] duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)] text-left aspect-[2/3] shadow-md hover:shadow-2xl hover:-translate-y-1"
                  style={{
                    background: hasCover ? "#122027" : generateGradient(camp.title),
                    filter: isActive ? "none" : "grayscale(60%) brightness(0.75)",
                    transition: "filter 0.5s cubic-bezier(0.34,1.56,0.64,1), transform 0.5s cubic-bezier(0.34,1.56,0.64,1), box-shadow 0.5s cubic-bezier(0.34,1.56,0.64,1)",
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
                    <div className="absolute inset-0 ring-4 ring-inset ring-[#12a0e1] rounded-2xl pointer-events-none" />
                  )}
                  {/* Top badges */}
                  <div className="absolute top-2.5 left-2.5 right-2.5 flex justify-between items-start">
                    {hasMatrix && isActive
                      ? <span className="w-2 h-2 rounded-full mt-0.5 bg-emerald-400 shadow-[0_0_6px_2px_rgba(52,211,153,0.5)]" />
                      : <span />}
                    {updatedTs ? (
                      <span className="text-[10px] font-bold bg-black/40 backdrop-blur-sm text-white/80 px-2 py-0.5 rounded-full">
                        {relativeDate(updatedTs)}
                      </span>
                    ) : null}
                  </div>
                  {/* Title */}
                  <div className="absolute bottom-0 left-0 right-0 p-3">
                    <p className={`text-sm font-black leading-tight text-white drop-shadow transition-colors line-clamp-2 ${isExpanded ? "text-[#12a0e1]" : ""}`}>
                      {camp.title}
                    </p>
                  </div>
                </button>
              </div>
            );
          };

          // ============ DETAIL VIEW (a studio is selected) ============
          if (selectedStudio) {
            const art = STUDIO_ART[selectedStudio] || STUDIO_ART.Misc;
            const detailCamps = grouped[selectedStudio] || [];
            const isMisc = selectedStudio === "Misc";

            return (
              <div key={`studio-${selectedStudio}`} className="mt-2 py-4 px-6 w-full">
                {/* Studio banner — uses the same gradient/logo as the gallery card so
                    the card appears to expand into the header (visual continuity). */}
                <div
                  className="relative rounded-3xl overflow-hidden p-6 sm:p-7 mb-8 shadow-md animate-in fade-in slide-in-from-top-4 zoom-in-95 duration-500"
                  style={{ background: art.gradient }}
                >
                  {/* Full-bleed photo for cover-type studios */}
                  {art.img && art.fit === "cover" && (
                    <img
                      src={art.img}
                      alt=""
                      onError={(e) => { e.currentTarget.style.display = "none"; }}
                      className="absolute inset-0 w-full h-full object-cover pointer-events-none"
                    />
                  )}
                  {/* Watermark logo for contain-type studios */}
                  {art.img && art.fit !== "cover" && (
                    <img
                      src={art.img}
                      alt=""
                      onError={(e) => { e.currentTarget.style.display = "none"; }}
                      className="absolute -right-4 top-1/2 -translate-y-1/2 h-[150%] object-contain opacity-15 pointer-events-none"
                    />
                  )}
                  <div className={`absolute inset-0 ${art.fit === "cover" ? "bg-gradient-to-r from-black/65 via-black/30 to-black/10" : "bg-gradient-to-r from-black/35 via-black/10 to-transparent"}`} />
                  <div className="relative flex justify-between items-start gap-4">
                    <div>
                      <button
                        onClick={() => setSelectedStudio(null)}
                        className="group/back flex items-center gap-1.5 text-[11px] font-black uppercase tracking-widest text-white/70 hover:text-white transition-colors"
                      >
                        <span className="text-base leading-none transition-transform group-hover/back:-translate-x-0.5">←</span> All Studios
                      </button>
                      <p className="text-3xl sm:text-4xl font-black text-white tracking-tight drop-shadow-md leading-none mt-3">
                        {selectedStudio}
                      </p>
                      <p className="text-[11px] font-bold text-white/70 uppercase tracking-widest mt-2">
                        {art.label} · {detailCamps.length} {detailCamps.length === 1 ? "campaign" : "campaigns"}
                      </p>
                    </div>
                    {/* New Campaign — only inside Misc */}
                    {isMisc && (
                      <button
                        onClick={() => setIsModalOpen(true)}
                        className="shrink-0 flex items-center gap-1.5 bg-white/15 hover:bg-white/25 backdrop-blur-md text-white px-4 py-2 rounded-xl font-bold text-xs border border-white/25 transition-colors active:scale-95"
                      >
                        <span className="text-base leading-none">+</span> New Campaign
                      </button>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-4">
                  {detailCamps.map((camp, i) => renderCampaignCard(camp, i))}
                </div>

                {detailCamps.length === 0 && (
                  <p className="text-center text-sm font-bold text-[#768994] py-16">
                    {isMisc ? "No campaigns here yet — use “+ New Campaign” to add one." : "No campaigns in this studio."}
                  </p>
                )}
              </div>
            );
          }

          // ============ COUNTRY DETAIL VIEW (a DOOH country is open) ============
          if (selectedCountry) {
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
                        className="flex items-center gap-2 bg-[#12a0e1] hover:bg-[#0f88c0] disabled:opacity-60 text-white px-4 py-2.5 rounded-xl font-black text-xs uppercase tracking-widest border border-white/10 transition-colors active:scale-95 shadow-md"
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
                      <Link2 className="w-4 h-4 text-[#12a0e1] shrink-0" />
                      <span className="text-[10px] font-black text-[#768994] uppercase tracking-widest shrink-0">{label}</span>
                      {editing ? (
                        <>
                          <input
                            autoFocus
                            value={editSourceText}
                            onChange={(e) => setEditSourceText(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") handleSaveSource(editSourceText); if (e.key === "Escape") setEditingSourceFolderId(null); }}
                            placeholder="/Volumes/… or https://drive.google.com/…"
                            className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg border border-[#dce4ec] focus:border-[#12a0e1] outline-none text-sm font-medium text-[#122027]"
                          />
                          <button onClick={() => handleSaveSource(editSourceText)} className="p-1.5 bg-[#12a0e1] hover:bg-[#0f88c0] text-white rounded-lg transition-colors shrink-0"><Check className="w-4 h-4" /></button>
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
                              title="Copy" className="p-1.5 text-[#768994] hover:text-[#12a0e1] hover:bg-slate-50 rounded-lg transition-colors shrink-0"
                            ><Copy className="w-4 h-4" /></button>
                          )}
                          {src && isUrl && (
                            <a href={src} target="_blank" rel="noopener noreferrer" title="Open" className="p-1.5 text-[#768994] hover:text-[#12a0e1] hover:bg-slate-50 rounded-lg transition-colors shrink-0"><ExternalLink className="w-4 h-4" /></a>
                          )}
                          <button
                            onClick={() => { setEditSourceText(src); setEditingSourceFolderId(node.id); }}
                            title={src ? "Edit" : "Add source path"} className="p-1.5 text-[#768994] hover:text-[#12a0e1] hover:bg-slate-50 rounded-lg transition-colors shrink-0"
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
                            className="w-full flex items-center gap-3 bg-white border border-[#dce4ec] rounded-2xl p-3.5 shadow-sm hover:border-[#12a0e1]/50 hover:shadow transition-all text-left"
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
                            <button onClick={() => setDeletingFolderId(f.id)} title="Delete folder" className="absolute top-2 right-2 p-1.5 text-[#768994] hover:text-rose-500 hover:bg-rose-50 rounded-lg opacity-0 group-hover:opacity-100 transition-all"><Trash2 className="w-3.5 h-3.5" /></button>
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
                      <button onClick={() => { setNewFolderName(""); setIsAddFolderOpen(true); }} className="flex items-center gap-1.5 px-4 py-2 rounded-xl border border-[#dce4ec] hover:border-[#12a0e1] hover:text-[#12a0e1] text-xs font-black uppercase tracking-widest transition-colors"><FolderPlus className="w-4 h-4" /> New folder</button>
                      <button onClick={() => countryFileInputRef.current?.click()} className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#12a0e1] hover:bg-[#0f88c0] text-white text-xs font-black uppercase tracking-widest transition-colors"><Upload className="w-4 h-4" /> Add files</button>
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
                        <div key={asset.id} className="group relative flex items-center gap-3 bg-white border border-[#dce4ec] rounded-2xl p-3 shadow-sm hover:border-[#12a0e1]/40 hover:shadow transition-all">
                          <button type="button" onClick={() => openPreview(asset, previewable)} className="flex items-center gap-3 min-w-0 flex-1 text-left cursor-pointer">
                            <div className="shrink-0 w-10 h-10 rounded-xl bg-[#12a0e1]/10 text-[#12a0e1] flex items-center justify-center">
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
                            <button onClick={() => setDeletingAssetId(asset.id)} className="shrink-0 p-2 text-[#768994] hover:text-rose-500 hover:bg-rose-50 rounded-lg opacity-0 group-hover:opacity-100 transition-all"><Trash2 className="w-4 h-4" /></button>
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
          return (
            <div key="studio-gallery" className="mt-2 py-4 px-6 w-full">
              <div className="flex items-center gap-2.5 mb-4 px-1">
                <div className="w-9 h-9 rounded-xl bg-[#12a0e1]/10 text-[#12a0e1] flex items-center justify-center shadow-sm">
                  <Film className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-lg font-black text-[#122027] tracking-tight leading-none">Studios</h2>
                  <p className="text-[11px] font-bold text-[#768994] uppercase tracking-widest mt-1">Campaign libraries</p>
                </div>
              </div>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-5">
                {gallerySections.map((section, i) => {
                  const art = STUDIO_ART[section] || STUDIO_ART.Misc;
                  const count = grouped[section]?.length || 0;
                  return (
                    <div
                      key={section}
                      className="animate-in fade-in slide-in-from-bottom-4 zoom-in-95"
                      style={{ animationDelay: `${i * 60}ms`, animationFillMode: "both" }}
                    >
                    <button
                      onClick={() => setSelectedStudio(section)}
                      className="group relative w-full rounded-3xl overflow-hidden aspect-[5/6] sm:aspect-[4/5] shadow-md hover:shadow-2xl hover:-translate-y-1.5 outline-none [filter:saturate(0.4)_brightness(0.9)] hover:[filter:saturate(1.08)_brightness(1.05)]"
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
                          className="absolute left-1/2 top-[44%] -translate-x-1/2 -translate-y-1/2 max-h-[38%] max-w-[64%] object-contain drop-shadow-lg transition-transform duration-500 ease-out group-hover:scale-110 group-hover:-translate-y-[55%]"
                        />
                      )}
                      {/* Legibility veil — stronger for cover photos */}
                      <div className={`absolute inset-0 ${art.fit === "cover" ? "bg-gradient-to-t from-black/80 via-black/25 to-black/20" : "bg-gradient-to-t from-black/60 via-black/5 to-black/10"}`} />
                      {/* Count */}
                      <span className="absolute top-3.5 right-3.5 text-[11px] font-black bg-white/15 backdrop-blur-md text-white px-2.5 py-1 rounded-full border border-white/25 transition-transform duration-300 group-hover:scale-105">
                        {count}
                      </span>
                      {/* Wordmark */}
                      <div className="absolute bottom-0 left-0 right-0 p-5 text-left transition-transform duration-300 group-hover:-translate-y-1">
                        <p className="text-xl font-black text-white tracking-tight drop-shadow-md leading-none">
                          {section}
                        </p>
                        <p className="text-[11px] font-bold text-white/75 uppercase tracking-widest mt-1.5">
                          {art.label}
                        </p>
                        <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-white/0 group-hover:text-white/80 transition-colors duration-300 mt-2">
                          View campaigns <span className="transition-transform group-hover:translate-x-0.5">→</span>
                        </span>
                      </div>
                    </button>
                    </div>
                  );
                })}
              </div>

              {/* ============ PINNED CAMPAIGNS ============ */}
              {pinnedCamps.length > 0 && (
                <section className="mt-10 animate-in fade-in slide-in-from-bottom-4 duration-500">
                  <div className="flex items-center gap-2.5 mb-4 px-1">
                    <div className="w-9 h-9 rounded-xl bg-amber-100 text-amber-600 flex items-center justify-center shadow-sm">
                      <Pin className="w-5 h-5 fill-current" />
                    </div>
                    <div>
                      <h2 className="text-lg font-black text-[#122027] tracking-tight leading-none">Pinned</h2>
                      <p className="text-[11px] font-bold text-[#768994] uppercase tracking-widest mt-1">Quick access · {pinnedCamps.length}</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                    {pinnedCamps.map((camp, i) => (
                      <div key={`pin-${camp.id}`} className="relative group/pin">
                        {renderCampaignCard(camp, i)}
                        <button
                          onClick={(e) => { e.stopPropagation(); togglePin(camp.id); }}
                          title="Unpin"
                          className="absolute top-2.5 left-2.5 z-20 p-1.5 rounded-lg bg-amber-400/95 hover:bg-amber-400 text-[#122027] shadow opacity-0 group-hover/pin:opacity-100 transition-opacity backdrop-blur-sm"
                        >
                          <Pin className="w-3.5 h-3.5 fill-current" />
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* ============ DOOH SPECS ============ */}
              <div className="mt-12 mb-8 flex items-center gap-4" aria-hidden="true">
                <div className="h-px flex-1 bg-gradient-to-r from-transparent via-[#cdd7e1] to-[#cdd7e1]" />
                <span className="text-[10px] font-black uppercase tracking-[0.2em] text-[#94a3b8]">Reference</span>
                <div className="h-px flex-1 bg-gradient-to-l from-transparent via-[#cdd7e1] to-[#cdd7e1]" />
              </div>
              <section className="rounded-3xl bg-white/60 border border-[#dce4ec] shadow-sm p-5 sm:p-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
                <div className="flex flex-wrap items-center gap-3 mb-5 px-1">
                  <div className="w-9 h-9 rounded-xl bg-[#12a0e1]/10 text-[#12a0e1] flex items-center justify-center shadow-sm shrink-0">
                    <Globe className="w-5 h-5" />
                  </div>
                  <div className="mr-auto">
                    <h2 className="text-lg font-black text-[#122027] tracking-tight leading-none">DOOH Specs</h2>
                    <p className="text-[11px] font-bold text-[#768994] uppercase tracking-widest mt-1">Screen specs by country · {doohCountries.length}</p>
                  </div>
                  <div className="relative">
                    <Search className="w-4 h-4 text-[#768994] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      value={countrySearch}
                      onChange={(e) => setCountrySearch(e.target.value)}
                      placeholder="Search country…"
                      className="w-44 sm:w-56 pl-9 pr-3 py-2 rounded-xl border border-[#dce4ec] focus:border-[#12a0e1] outline-none text-sm font-semibold text-[#122027] bg-white"
                    />
                  </div>
                  <div className="flex items-center bg-white border border-[#dce4ec] rounded-xl p-0.5">
                    <button onClick={() => setViewMode("grid")} title="Grid view" className={`p-1.5 rounded-lg transition-colors ${doohViewMode === "grid" ? "bg-[#12a0e1] text-white" : "text-[#768994] hover:text-[#122027]"}`}><LayoutGrid className="w-4 h-4" /></button>
                    <button onClick={() => setViewMode("list")} title="List view" className={`p-1.5 rounded-lg transition-colors ${doohViewMode === "list" ? "bg-[#12a0e1] text-white" : "text-[#768994] hover:text-[#122027]"}`}><List className="w-4 h-4" /></button>
                  </div>
                  <button onClick={() => setIsAddCountryOpen(true)} className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#12a0e1] hover:bg-[#0f88c0] text-white text-xs font-black uppercase tracking-widest transition-colors active:scale-95">
                    <Plus className="w-4 h-4" /> Add
                  </button>
                  <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
                    <button onClick={() => setAllRegionsExpanded(true)} className="text-[10px] font-black uppercase tracking-widest text-[#12a0e1] hover:text-[#0f88c0] px-1">Expand all</button>
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
                        <button onClick={() => openCountry(country.id)} className="w-full group relative rounded-xl overflow-hidden min-h-[104px] outline-none shadow-sm hover:shadow-lg hover:-translate-y-0.5 bg-gradient-to-br from-[#1b3a4b] to-[#12506e] flex flex-col items-center justify-center gap-2 px-2 py-3 transition-[transform,box-shadow] duration-300">
                          <span className="transition-transform duration-500 group-hover:scale-110"><CountryFlag flag={country.flag} imgClass="w-11 h-[30px]" textClass="text-3xl" /></span>
                          <p className="text-[11px] font-bold text-white text-center leading-tight line-clamp-2 px-0.5">{country.name}</p>
                          {count > 0 && <span className="absolute top-1.5 right-1.5 text-[9px] font-black bg-white/15 backdrop-blur-md text-white w-5 h-5 flex items-center justify-center rounded-full border border-white/25">{count}</span>}
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); togglePinCountry(country); }} title={country.pinned ? "Unpin" : "Pin"} className={`absolute top-1.5 left-1.5 p-1 rounded-lg transition-all ${country.pinned ? "text-amber-300 opacity-100" : "text-white/70 opacity-0 group-hover/c:opacity-100 hover:text-amber-300"}`}>
                          <Star className={`w-4 h-4 ${country.pinned ? "fill-current" : ""}`} />
                        </button>
                      </div>
                    );
                  };

                  const Row = (country) => {
                    const count = countryCount(country.id);
                    return (
                      <div key={country.id} className="flex items-center gap-3 bg-white border border-[#dce4ec] rounded-xl pl-2.5 pr-2 py-2 shadow-sm hover:border-[#12a0e1]/40 hover:shadow transition-all">
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
                        const isOpen = q ? true : !!expandedRegions[region];
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
              </section>

              <div className="mt-6 space-y-6">
                <EndOfCampaignNotesCard
                  isOpen={expandedRegions["eocNotes"] ?? true}
                  onToggle={() => toggleRegion("eocNotes")}
                  campaigns={campaigns}
                />
                <NotesCanvasCard
                  isOpen={expandedRegions["notesCanvas"] ?? true}
                  onToggle={() => toggleRegion("notesCanvas")}
                />
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
                              <Film className="w-3 h-3" /> {studioOverrides[activeCamp.id] || detectStudio(activeCamp.links) || activeCamp.studioHint || "Misc"}
                            </button>
                            {studioPickerCampId === activeCamp.id && (
                              <div className="absolute top-full left-0 mt-1.5 bg-white rounded-2xl shadow-2xl border border-[#dce4ec] py-1.5 z-[9999] min-w-[140px] animate-in zoom-in-95 duration-100">
                                {STUDIO_ORDER.map((s) => {
                                  const cur = studioOverrides[activeCamp.id] || detectStudio(activeCamp.links) || activeCamp.studioHint || "Misc";
                                  return (
                                    <button
                                      key={s}
                                      onClick={(e) => { e.stopPropagation(); handleSetStudio(activeCamp.id, s); }}
                                      className={`w-full text-left px-3 py-1.5 text-xs font-bold normal-case tracking-normal transition-colors ${
                                        cur === s ? "bg-[#12a0e1]/10 text-[#12a0e1]" : "text-[#122027] hover:bg-slate-50"
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
                  <div className="flex-1 flex flex-col h-full overflow-hidden min-w-0 transition-all duration-500">
                    <div className="flex justify-between items-center mb-5 pb-4 border-b border-slate-100 shrink-0">
                      <h4 className="text-sm font-black text-[#122027] flex items-center gap-2">
                        <FileText className="w-5 h-5 text-[#12a0e1]" /> Notes &
                        Context
                      </h4>
                      <div className="flex items-center gap-2 pr-2">
                        <button
                          onClick={() => setShowFoldersPanel((prev) => !prev)}
                          className={`px-4 py-2 rounded-xl transition-colors flex items-center gap-2 text-xs font-bold border ${
                            showFoldersPanel
                              ? "bg-indigo-100 text-indigo-700 border-indigo-200"
                              : "text-indigo-600 bg-indigo-50 hover:bg-indigo-100 border-indigo-100"
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
                          className="text-white bg-[#12a0e1] hover:bg-[#0f88c0] px-4 py-2 rounded-xl transition-colors flex items-center gap-2 text-xs font-bold shadow-sm"
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
                                    className="p-2 bg-[#1cc1a5] text-white rounded-xl hover:bg-[#15a38b] shadow-sm transition-all"
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
                                    className="p-2 bg-slate-200 text-[#768994] rounded-xl hover:bg-slate-300 transition-all"
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
                                    <Link2 className="w-3.5 h-3.5 text-indigo-500" />
                                    <span className="text-[10px] font-black text-indigo-500 uppercase tracking-widest bg-indigo-50 px-2 py-0.5 rounded border border-indigo-100">
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
                                  className="p-2 text-[#768994] hover:text-[#12a0e1] hover:bg-slate-50 rounded-lg transition-colors"
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
                        <div className="flex flex-col gap-3 bg-indigo-50/50 p-4 rounded-2xl border border-indigo-100 animate-in fade-in slide-in-from-top-2">
                          <div className="flex gap-1.5 border-b border-indigo-100 pb-2">
                            <button
                              onClick={() =>
                                handleFormat(
                                  "bold",
                                  newNoteText,
                                  setNewNoteText,
                                  "add-note-textarea"
                                )
                              }
                              className="p-1.5 hover:bg-indigo-100 rounded text-indigo-600 transition-colors"
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
                              className="p-1.5 hover:bg-indigo-100 rounded text-indigo-600 transition-colors"
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
                              className="p-1.5 hover:bg-indigo-100 rounded text-indigo-600 transition-colors"
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
                              className="w-full text-sm text-[#122027] bg-transparent border-none resize-y min-h-[150px] outline-none focus:ring-0 p-0 placeholder:text-indigo-300 leading-relaxed custom-scrollbar"
                              rows="8"
                            />
                            <div className="flex flex-col gap-2 shrink-0">
                              <button
                                onClick={() => handleAddNote(activeCamp.id)}
                                className="p-2 bg-[#12a0e1] text-white hover:bg-[#0f88c0] rounded-xl transition-colors shadow-sm"
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
                    className={`transition-all duration-500 ease-[cubic-bezier(0.4,0,0.2,1)] overflow-hidden flex flex-col ${
                      showFoldersPanel
                        ? "w-full lg:w-[420px] xl:w-[520px] max-h-[500px] lg:max-h-full opacity-100 mt-6 lg:mt-0 lg:ml-6"
                        : "w-full lg:w-0 max-h-0 lg:max-h-full opacity-0 mt-0 lg:ml-0"
                    }`}
                  >
                    {/* Inner rigid container prevents content squishing while the wrapper shrinks */}
                    <div className="w-full lg:w-[420px] xl:w-[520px] shrink-0 bg-slate-50 border border-[#dce4ec] rounded-2xl flex flex-col h-full shadow-inner min-h-[300px]">
                      <div className="p-4 border-b border-[#dce4ec] flex justify-between items-center bg-white shrink-0 rounded-t-2xl">
                        <div className="flex items-center gap-2.5">
                          <div className="p-1.5 bg-indigo-100 text-indigo-600 rounded-lg">
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
                                <div className="group relative bg-white border border-indigo-300 rounded-xl p-3 flex flex-col gap-2 shadow-sm animate-in fade-in zoom-in-95 duration-200">
                                  <input
                                    type="text"
                                    value={editLinkTitle}
                                    onChange={(e) =>
                                      setEditLinkTitle(e.target.value)
                                    }
                                    className="w-full bg-slate-50 border border-[#dce4ec] rounded-lg px-2.5 py-1.5 text-xs font-bold text-[#122027] outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all"
                                    placeholder="Link Title"
                                  />
                                  <textarea
                                    value={editLinkUrl}
                                    onChange={(e) =>
                                      setEditLinkUrl(e.target.value)
                                    }
                                    className="w-full bg-slate-50 border border-[#dce4ec] rounded-lg px-2.5 py-1.5 text-[10px] font-mono text-[#768994] outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all resize-y min-h-[60px] custom-scrollbar"
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
                                <div className="group relative bg-white border border-slate-200 rounded-xl p-3 flex flex-col gap-3 hover:border-indigo-300 hover:shadow-sm transition-all">
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
                                      className={`flex items-center justify-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex-1 ${
                                        copiedLinkId === link.id
                                          ? "bg-emerald-500 text-white shadow-sm shadow-emerald-500/20"
                                          : "bg-slate-100 text-[#323b43] hover:bg-indigo-50 hover:text-indigo-600"
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
                                      className="p-2 text-slate-400 hover:text-indigo-500 hover:bg-indigo-50 rounded-lg transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
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
                            className="w-full bg-slate-50 border border-[#dce4ec] rounded-xl px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition-all"
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
                              className="flex-1 min-w-0 bg-slate-50 border border-[#dce4ec] rounded-xl px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition-all font-mono"
                            />
                            <button
                              onClick={() => handleAddLink(activeCamp.id)}
                              disabled={
                                !newLinkTitle.trim() || !newLinkUrl.trim()
                              }
                              className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 text-white p-2 rounded-xl transition-colors shadow-sm shrink-0 flex items-center justify-center"
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
                      className="flex-1 flex items-center justify-center gap-2 bg-[#12a0e1] hover:bg-[#0f88c0] text-white py-4 rounded-2xl text-sm font-black uppercase tracking-widest transition-all shadow-md active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100"
                    >
                      <FileText className="w-5 h-5" /> View Asset Matrix
                    </button>
                    <a
                      href={activeCamp.wrikeLink}
                      target="_blank"
                      rel="noreferrer"
                      className="flex-1 flex items-center justify-center gap-2 bg-[#122027] hover:bg-[#1a2d37] text-white py-4 rounded-2xl text-sm font-black uppercase tracking-widest transition-all shadow-md active:scale-95"
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
                            className="px-4 py-4 bg-rose-600 hover:bg-rose-700 text-white rounded-2xl text-sm font-black uppercase tracking-widest transition-all active:scale-95"
                          >
                            Yes, delete
                          </button>
                          <button
                            onClick={() => setDeletingCampId(null)}
                            className="px-4 py-4 bg-slate-200 hover:bg-slate-300 text-[#122027] rounded-2xl text-sm font-black uppercase tracking-widest transition-all active:scale-95"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setDeletingCampId(activeCamp.id)}
                          className="flex items-center justify-center gap-2 px-5 py-4 bg-rose-50 hover:bg-rose-100 text-rose-600 rounded-2xl text-sm font-black uppercase tracking-widest transition-all active:scale-95 border border-rose-200"
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
                  <div className="p-2 bg-[#12a0e1]/10 rounded-lg">
                    <Layout className="w-4 h-4 text-[#12a0e1]" />
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
                    className="w-full bg-slate-50 border border-[#dce4ec] rounded-xl px-4 py-3 text-sm font-medium text-[#122027] focus:outline-none focus:border-[#12a0e1] focus:ring-2 focus:ring-[#12a0e1]/20 transition-all placeholder:text-slate-400"
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
                    className="w-full bg-slate-50 border border-[#dce4ec] rounded-xl px-4 py-3 text-sm font-medium text-[#122027] focus:outline-none focus:border-[#12a0e1] focus:ring-2 focus:ring-[#12a0e1]/20 transition-all placeholder:text-slate-400"
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
                  className="px-6 py-2.5 bg-[#12a0e1] hover:bg-[#0f88c0] text-white text-xs font-black uppercase tracking-widest rounded-xl shadow-md hover:shadow-[#12a0e1]/20 transition-all active:scale-95"
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
                    className="mt-1.5 w-full px-4 py-2.5 rounded-xl border border-[#dce4ec] focus:border-[#12a0e1] outline-none text-sm font-bold text-[#122027]"
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
                    className="mt-1.5 w-full px-4 py-2.5 rounded-xl border border-[#dce4ec] focus:border-[#12a0e1] outline-none text-sm font-bold text-[#122027] uppercase"
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
                  className="px-6 py-2.5 bg-[#12a0e1] hover:bg-[#0f88c0] disabled:opacity-50 text-white text-xs font-black uppercase tracking-widest rounded-xl shadow-md transition-all active:scale-95"
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
                  className="mt-1.5 w-full px-4 py-2.5 rounded-xl border border-[#dce4ec] focus:border-[#12a0e1] outline-none text-sm font-bold text-[#122027]"
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
                  className="px-6 py-2.5 bg-[#12a0e1] hover:bg-[#0f88c0] disabled:opacity-50 text-white text-xs font-black uppercase tracking-widest rounded-xl shadow-md transition-all active:scale-95"
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
