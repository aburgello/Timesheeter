import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  X,
  ExternalLink,
  Link2,
  Copy,
  FolderOpen,
  Check,
  Download,
  Play,
  Square,
  Clock,
  RotateCcw,
  Film,
  Tag,
  MessageSquare,
  ChevronLeft,
  ChevronRight,
  TableProperties,
  ListTree,
} from "lucide-react";
import {
  TERRITORY_FLAGS,
  TERRITORIES,
  CATEGORIES,
  DEFAULT_JOBS,
} from "../constants";
import { supabase } from "../lib/supabaseClient";
import { parseWrikeData } from "../lib/wrikeEnrich";
import { guessFieldsFromTask } from "../utils/wrikeHelpers";
import SearchableSelect from "./shared/SearchableSelect";
import { parsePdfDeliverySpecs } from "../utils/pdfTableParser";
import DeliverySpecsModal from "./DeliverySpecsModal";
import { logTimeToWrike } from "../lib/wrikeApi";

// ── Local presentational helpers ──────────────────────────────────────────────

const FALLBACK_FLAGS = {
  UAE: "🇦🇪",
  SPAIN: "🇪🇸",
  ES: "🇪🇸",
  GER: "🇩🇪",
  GERMANY: "🇩🇪",
  FRA: "🇫🇷",
  FRANCE: "🇫🇷",
  TW: "🇹🇼",
  TAIWAN: "🇹🇼",
  CZ: "🇨🇿",
  CZECH: "🇨🇿",
  AUSTRIA: "🇦🇹",
  PHILIPPINES: "🇵🇭",
  PH: "🇵🇭",
  AUS: "🇦🇺",
  AUSTRALIA: "🇦🇺",
  BRA: "🇧🇷",
  BRAZIL: "🇧🇷",
  UK: "🇬🇧",
  GB: "🇬🇧",
  INT: "🌍",
  INTL: "🌍",
  ROW: "🌐",
  LATAM: "🌎",
  MEX: "🇲🇽",
  MEXICO: "🇲🇽",
  ITA: "🇮🇹",
  ITALY: "🇮🇹",
  NETHERLANDS: "🇳🇱",
  NL: "🇳🇱",
  MALAYSIA: "🇲🇾",
  MY: "🇲🇾",
  INDIA: "🇮🇳",
  IN: "🇮🇳",
  SLOVAKIA: "🇸🇰",
  SK: "🇸🇰",
  SIN: "🇸🇬",
  SINGAPORE: "🇸🇬",
  IRE: "🇮🇪",
  IRELAND: "🇮🇪",
  UY: "🇺🇾",
  HUNGARY: "🇭🇺",
  POL: "🇵🇱",
  POLAND: "🇵🇱",
  KR: "🇰🇷",
};

function getTerritoryData(title) {
  if (!title) return { name: "UNKNOWN", flag: "🎬" };
  const words = title.toUpperCase().split(/[\s\-_]+/);
  if (typeof TERRITORY_FLAGS !== "undefined" && TERRITORY_FLAGS) {
    for (const word of words) {
      if (TERRITORY_FLAGS[word])
        return { name: word, flag: TERRITORY_FLAGS[word] };
    }
  }
  for (const word of words) {
    if (FALLBACK_FLAGS[word]) return { name: word, flag: FALLBACK_FLAGS[word] };
  }
  return { name: "GLOBAL", flag: "🎬" };
}

function getTagStyle(tag) {
  const base =
    "text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded border whitespace-nowrap";
  if (!tag) return `${base} bg-slate-100 text-slate-500 border-slate-200`;
  const t = String(tag).toLowerCase();
  if (t.includes("to amend"))
    return `${base} bg-rose-50 text-rose-600 border-rose-200`;
  if (t.includes("render review"))
    return `${base} bg-indigo-50 text-indigo-600 border-indigo-200`;
  if (t.includes("revised"))
    return `${base} bg-teal-50 text-teal-600 border-teal-200`;
  if (t.includes("creative approved"))
    return `${base} bg-blue-50 text-blue-600 border-blue-200`;
  if (t.includes("content approved"))
    return `${base} bg-purple-50 text-purple-600 border-purple-200`;
  if (t.includes("client review") || t.includes("content review"))
    return `${base} bg-yellow-50 text-yellow-600 border-yellow-200`;
  if (t.includes("motion"))
    return `${base} bg-emerald-50 text-emerald-600 border-emerald-200`;
  if (t.includes("digital"))
    return `${base} bg-cyan-50 text-cyan-600 border-cyan-200`;
  if (t.includes("prep for delivery"))
    return `${base} bg-orange-50 text-orange-600 border-orange-200`;
  if (t === "delivering" || t === "delivery")
    return `${base} bg-yellow-100 text-yellow-700 border-yellow-400`;
  if (t.includes("on hold"))
    return `${base} bg-red-50 text-red-600 border-red-200`;
  if (t.includes("pm"))
    return `${base} bg-fuchsia-50 text-fuchsia-600 border-fuchsia-200`;
  if (t.includes("backlog"))
    return `${base} bg-slate-100 text-slate-500 border-slate-200`;
  return `${base} bg-slate-100 text-slate-500 border-slate-200`;
}

function isOverdue(d) {
  if (!d || d === "No Due Date") return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(d) < today;
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;
function extractLinks(text) {
  if (!text) return [];
  return [...new Set(text.match(URL_RE) || [])];
}

function extractFolderPaths(notesText, extractedPathData) {
  const seen = new Set();
  const results = [];
  if (notesText) {
    const lines = notesText.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (/^\/volumes\//i.test(line)) {
        let label = "";
        for (let j = i - 1; j >= 0; j--) {
          const prev = lines[j].trim();
          if (prev && !/^\/volumes\//i.test(prev)) {
            label = prev.replace(/:$/, "").trim().toUpperCase();
            break;
          }
        }
        const key = line.toUpperCase();
        if (!seen.has(key)) {
          seen.add(key);
          const parts = line.split("/").filter(Boolean);
          const derived = parts
            .slice(-2)
            .map((s) => s.replace(/_/g, " "))
            .join(" / ")
            .toUpperCase();
          results.push({ url: line, title: label || derived, isAuto: false });
        }
      }
    }
  }
  if (extractedPathData) {
    extractedPathData
      .split(" ")
      .filter((p) => p.includes("/VOLUMES/"))
      .forEach((pathStr) => {
        const key = pathStr.toUpperCase();
        const isPrefix = results.some((r) =>
          r.url.toUpperCase().startsWith(key)
        );
        if (!seen.has(key) && !isPrefix) {
          seen.add(key);
          const parts = pathStr.split("/").filter(Boolean);
          const last2 = parts
            .slice(-2)
            .map((s) => decodeURIComponent(s).replace(/_/g, " "))
            .join(" / ")
            .toUpperCase();
          results.push({ url: pathStr, title: last2 || pathStr, isAuto: true });
        }
      });
  }
  return results;
}

function mimeForAttachment(att) {
  if (att.contentType && att.contentType !== "application/octet-stream")
    return att.contentType;
  const ext = (att.name || "").split(".").pop().toLowerCase();
  const MAP = {
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    tiff: "image/tiff",
    svg: "image/svg+xml",
    mp4: "video/mp4",
    mov: "video/quicktime",
    txt: "text/plain",
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

// ── CSV Preview Modal ─────────────────────────────────────────────────────────

export function CsvPreviewModal({
  rawSpecs,
  pdfName,
  campaignName,
  taskTitle,
  territoryName,
  sourceFolder,
  onClose,
}) {
  const [copied, setCopied] = useState(false);

  const formattedData = React.useMemo(() => {
    if (!rawSpecs) return [];
    const validSpecs = rawSpecs.filter(
      (row) => row.pixelWidth || row.pixelHeight || row.duration
    );

    return validSpecs.map((row) => {
      const rawSize = `${row.pixelWidth || ""} ${row.pixelHeight || ""}`;
      const sizeNums = rawSize.match(/\d+/g);
      const size =
        sizeNums && sizeNums.length >= 2
          ? `${sizeNums[0]}x${sizeNums[1]}`
          : rawSize.trim();

      let artwork = "DOOH";
      if (row.artworkType) {
        const artMatch = row.artworkType.match(/(DOOH|DINTH|FOH)/i);
        if (artMatch) artwork = artMatch[0].toUpperCase();
      }

      let duration = "";
      if (row.duration) {
        const durMatch = row.duration.toString().match(/[\d-]+/);
        if (durMatch) duration = durMatch[0];
      }

      return {
        "Artwork:": artwork,
        "Campaign:": row.campaignSelection
          ? row.campaignSelection.toString().trim()
          : campaignName || "UNKNOWN",
        "Size:": size,
        "Duration:": duration,
        "Country:": territoryName || "UNKNOWN", // 👈 Added the new Country column!
      };
    });
  }, [rawSpecs, campaignName, territoryName]);

  const csvString = React.useMemo(() => {
    if (!formattedData.length) return "";
    const headers = Object.keys(formattedData[0]);
    const rows = [
      headers.join(","),
      ...formattedData.map((row) =>
        headers
          .map((header) => {
            const cellValue = (row[header] || "")
              .toString()
              .replace(/"/g, '""');
            return `"${cellValue}"`;
          })
          .join(",")
      ),
    ];
    return rows.join("\n");
  }, [formattedData]);

const handleCopy = () => {
    let batchStr = "";
    
    if (taskTitle) {
      const explicitBatchMatch = taskTitle.match(/batch\s*[\w\d]+/i);
      
      if (explicitBatchMatch) {
        // If it explicitly says "Batch XYZ", grab it and underscore it
        batchStr = explicitBatchMatch[0].replace(/\s+/g, "_");
      } else if (territoryName) {
        // Fallback: Look for text after the territory name
        const safeTerr = territoryName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Match territory name and capture everything after, ignoring leading symbols/spaces
        const regex = new RegExp(`${safeTerr}[\\s\\W]*([^$]+)`, "i");
        const match = taskTitle.match(regex);
        
        if (match && match[1]) {
          let afterText = match[1].trim();
          // Remove the word "batch" if it happens to be at the start of the captured text
          afterText = afterText.replace(/^batch[\s\W]*/i, "");
          // Replace any spaces or remaining symbols with underscores, and trim ends
          afterText = afterText.replace(/[\s\W]+/g, "_").replace(/^_|_$/g, "");
          
          if (afterText) {
            batchStr = `Batch_${afterText}`;
          }
        }
      }
    }

    const metadata = `[METADATA]\nTerritory: ${
      territoryName || ""
    }\nBatch: ${batchStr}\nSource Folder: ${
      sourceFolder || ""
    }\n[/METADATA]\n\n`;
    const payload = metadata + csvString;

    navigator.clipboard.writeText(payload).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const baseName = (pdfName || "specs").replace(/\.pdf$/i, "");
    const blob = new Blob([csvString], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", `${baseName}_export.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  if (!formattedData.length) return null;

  return (
    <div
      className="fixed inset-0 z-[10005] bg-[#122027]/80 backdrop-blur-sm flex items-center justify-center p-4 sm:p-8"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl flex flex-col overflow-hidden border border-[#dce4ec] max-h-full"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#dce4ec] bg-slate-50">
          <div>
            <h2 className="text-base font-black text-[#122027]">CSV Preview</h2>
            <p className="text-xs text-slate-500 font-medium mt-0.5">
              Please review the extracted rows before downloading.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-slate-200 rounded-xl text-slate-400 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Table Content */}
        <div className="flex-1 overflow-auto bg-slate-50/50 p-6">
          <div className="rounded-xl border border-slate-200 bg-white overflow-hidden shadow-sm">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-[10px] uppercase font-black tracking-widest text-slate-500">
                <tr>
                  {Object.keys(formattedData[0]).map((h, i) => (
                    <th key={i} className="px-4 py-3">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {formattedData.map((row, i) => (
                  <tr key={i} className="hover:bg-slate-50/50">
                    {Object.values(row).map((val, j) => (
                      <td
                        key={j}
                        className="px-4 py-2.5 text-slate-700 font-medium whitespace-nowrap"
                      >
                        {val}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="px-6 py-4 border-t border-[#dce4ec] bg-white flex items-center justify-between">
          <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">
            {formattedData.length} valid rows found
          </span>
          <div className="flex items-center gap-3">
            <button
              onClick={handleCopy}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold transition-all"
            >
              {copied ? (
                <Check className="w-4 h-4 text-emerald-500" />
              ) : (
                <Copy className="w-4 h-4" />
              )}
              {copied ? "Copied to clipboard" : "Copy CSV"}
            </button>
            <button
              onClick={handleDownload}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-bold transition-all shadow-sm"
            >
              <Download className="w-4 h-4" />
              Download CSV file
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Attachment Thumb ─────────────────────────────────────────────────────────

export function AttachmentThumb({
  attachment,
  large = false,
  onPreview,
  onSpecsParsed,
  onCsvPreview,
}) {
  const [loading, setLoading] = useState(false);
  const [specsLoading, setSpecsLoading] = useState(false);
  const [csvLoading, setCsvLoading] = useState(false);

  const ext = (attachment.name || "").split(".").pop().toLowerCase();
  const dim = large ? "w-24 h-24" : "w-14 h-14";
  const kind = attachmentKind(attachment);

  const { icon, bg } =
    kind === "pdf"
      ? { icon: "📄", bg: "bg-red-50 border-red-200" }
      : kind === "image"
      ? { icon: "🖼️", bg: "bg-sky-50 border-sky-200" }
      : kind === "video"
      ? { icon: "🎬", bg: "bg-purple-50 border-purple-200" }
      : ["psd", "ai", "eps", "aep", "prproj"].includes(ext)
      ? { icon: "🎨", bg: "bg-orange-50 border-orange-200" }
      : ["zip", "rar", "7z"].includes(ext)
      ? { icon: "📦", bg: "bg-slate-100 border-slate-200" }
      : ["doc", "docx", "txt"].includes(ext)
      ? { icon: "📝", bg: "bg-blue-50 border-blue-200" }
      : ["xls", "xlsx", "csv"].includes(ext)
      ? { icon: "📊", bg: "bg-green-50 border-green-200" }
      : { icon: "📎", bg: "bg-slate-50 border-slate-200" };

  const downloadUrl = `/api/wrike/attachments/${attachment.id}/download`;

  const fetchBlob = async () => {
    const res = await fetch(downloadUrl);
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.blob();
  };

  const handleOpen = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (loading) return;
    setLoading(true);
    try {
      const raw = await fetchBlob();
      const typed = new Blob([raw], { type: mimeForAttachment(attachment) });
      const obj = URL.createObjectURL(typed);
      onPreview?.({
        url: obj,
        name: attachment.name,
        kind,
        isObjectUrl: true,
        attachmentId: attachment.id,
      });
    } catch (err) {
      console.warn("Attachment preview failed:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleSpecs = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (specsLoading || csvLoading) return;
    setSpecsLoading(true);
    try {
      const raw = await fetchBlob();
      const specs = await parsePdfDeliverySpecs(raw);
      onSpecsParsed?.({ specs, name: attachment.name });
    } catch (err) {
      console.warn("PDF specs parse failed:", err);
      onSpecsParsed?.({ specs: null, name: attachment.name });
    } finally {
      setSpecsLoading(false);
    }
  };

  const handleCsvPreviewTrigger = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (specsLoading || csvLoading) return;
    setCsvLoading(true);
    try {
      const raw = await fetchBlob();
      const specs = await parsePdfDeliverySpecs(raw);
      if (specs && specs.length > 0) {
        onCsvPreview?.({ rawSpecs: specs, name: attachment.name });
      } else {
        console.warn("No tabular data found to export.");
      }
    } catch (err) {
      console.warn("PDF CSV parsing failed:", err);
    } finally {
      setCsvLoading(false);
    }
  };

  return (
    <div className="relative shrink-0 flex flex-col items-center gap-1">
      <button
        onClick={handleOpen}
        title={attachment.name}
        className={`${dim} rounded-xl border ${bg} flex flex-col items-center justify-center gap-1 hover:shadow-md hover:scale-105 transition-all overflow-hidden`}
      >
        {loading ? (
          <div className="w-4 h-4 border-2 border-slate-300 border-t-[#12a0e1] rounded-full animate-spin" />
        ) : (
          // Icon-only placeholder for every kind, including images — no
          // eager <img src> here. Rendering attachment.previewUrl directly
          // made the browser download the actual image bytes for every
          // image attachment on every task opened, whether viewed or not;
          // now the real fetch only happens on click, via handleOpen.
          <>
            <span className={large ? "text-3xl" : "text-xl"}>{icon}</span>
            <span className="text-[7px] font-black text-slate-400 uppercase tracking-wide px-1 text-center leading-none">
              {(ext || "file").slice(0, 6)}
            </span>
          </>
        )}
      </button>

      {kind === "pdf" && onSpecsParsed && (
        <div className="flex gap-1 mt-0.5">
          <button
            onClick={handleSpecs}
            title="Extract delivery specs"
            className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#12a0e1] hover:bg-[#0d8bc4] text-white text-[8px] font-black uppercase tracking-wide transition-colors shadow-sm"
          >
            {specsLoading ? (
              <div className="w-2 h-2 border border-white/40 border-t-white rounded-full animate-spin" />
            ) : (
              <TableProperties className="w-2 h-2" />
            )}
            Specs
          </button>

          <button
            onClick={handleCsvPreviewTrigger}
            title="Preview and Export CSV"
            className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500 hover:bg-emerald-600 text-white text-[8px] font-black uppercase tracking-wide transition-colors shadow-sm"
          >
            {csvLoading ? (
              <div className="w-2 h-2 border border-white/40 border-t-white rounded-full animate-spin" />
            ) : (
              <Download className="w-2 h-2" />
            )}
            CSV
          </button>
        </div>
      )}
    </div>
  );
}

// ── File Preview Lightbox ─────────────────────────────────────────────────────

export function FilePreviewLightbox({
  file,
  onClose,
  allAttachments = [],
  onNavigate,
}) {
  const [navLoading, setNavLoading] = useState(false);

  const currentIdx = allAttachments.findIndex(
    (a) => a.id === file?.attachmentId
  );
  const hasPrev = currentIdx > 0;
  const hasNext = currentIdx >= 0 && currentIdx < allAttachments.length - 1;

  const navigateTo = async (att) => {
    if (navLoading) return;
    setNavLoading(true);
    try {
      const res = await fetch(`/api/wrike/attachments/${att.id}/download`);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const raw = await res.blob();
      const typed = new Blob([raw], { type: mimeForAttachment(att) });
      const obj = URL.createObjectURL(typed);
      const kind = attachmentKind(att);
      onNavigate?.({
        url: obj,
        name: att.name,
        kind,
        isObjectUrl: true,
        attachmentId: att.id,
      });
    } catch (err) {
      console.warn("Navigation fetch failed:", err);
    } finally {
      setNavLoading(false);
    }
  };

  useEffect(() => {
    if (!file) return;
    const handler = (e) => {
      if (e.key === "ArrowLeft" && hasPrev)
        navigateTo(allAttachments[currentIdx - 1]);
      if (e.key === "ArrowRight" && hasNext)
        navigateTo(allAttachments[currentIdx + 1]);
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [file, currentIdx, hasPrev, hasNext]);

  if (!file) return null;

  const showArrows = allAttachments.length > 1 && currentIdx >= 0;

  return (
    <div
      className="fixed inset-0 z-[10000] flex flex-col p-4 sm:p-8 bg-[#122027]/90 backdrop-blur-md"
      onClick={onClose}
    >
      <div
        className="flex items-center justify-between gap-3 mb-3 shrink-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 min-w-0">
          {showArrows && (
            <span className="text-xs font-bold text-white/50 shrink-0">
              {currentIdx + 1} / {allAttachments.length}
            </span>
          )}
          <p className="text-sm font-bold text-white truncate">{file.name}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <a
            href={file.url}
            download={file.name}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-bold border border-white/20 transition-colors"
          >
            <Download className="w-4 h-4" />{" "}
            <span className="hidden sm:inline">Download</span>
          </a>
          <button
            onClick={onClose}
            className="p-2 rounded-xl bg-white/10 hover:bg-rose-500 text-white border border-white/20 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      <div
        className="relative flex-1 min-h-0 flex items-center gap-3"
        onClick={onClose}
      >
        {showArrows && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (hasPrev) navigateTo(allAttachments[currentIdx - 1]);
            }}
            disabled={!hasPrev || navLoading}
            className="shrink-0 p-2.5 rounded-full bg-white/10 hover:bg-white/25 disabled:opacity-20 disabled:cursor-not-allowed text-white border border-white/20 transition-all"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
        )}

        <div
          className="relative flex-1 min-h-0 h-full rounded-2xl overflow-hidden bg-white/5 border border-white/10 flex items-center justify-center"
          onClick={(e) => e.stopPropagation()}
        >
          {navLoading ? (
            <div className="flex flex-col items-center gap-3 text-white/60">
              <div className="w-8 h-8 border-2 border-white/20 border-t-white rounded-full animate-spin" />
              <span className="text-xs font-medium">Loading…</span>
            </div>
          ) : file.kind === "image" ? (
            <img
              src={file.url}
              alt={file.name}
              className="max-h-full max-w-full object-contain"
            />
          ) : file.kind === "video" ? (
            <video src={file.url} controls className="max-h-full max-w-full" />
          ) : file.kind === "pdf" ? (
            <iframe
              src={`${file.url}#zoom=350`}
              title={file.name}
              className="w-full h-full bg-white"
            />
          ) : (
            <div className="flex flex-col items-center gap-3 text-white/70">
              <p className="text-sm">
                This file type can't be previewed in-browser.
              </p>
              <a
                href={file.url}
                download={file.name}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-bold border border-white/20 transition-colors"
              >
                <Download className="w-4 h-4" /> Download file
              </a>
            </div>
          )}
        </div>

        {showArrows && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (hasNext) navigateTo(allAttachments[currentIdx + 1]);
            }}
            disabled={!hasNext || navLoading}
            className="shrink-0 p-2.5 rounded-full bg-white/10 hover:bg-white/25 disabled:opacity-20 disabled:cursor-not-allowed text-white border border-white/20 transition-all"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
        )}
      </div>
    </div>
  );
}

// ── Time-log panel ────────────────────────────────────────────────────────────

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function fmtClock(totalSecs) {
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

function TimeLogPanel({ task, fullTask, jobOptions, onLogTime, onLogged, triggerToast }) {
  const prefill = React.useMemo(
    () => guessFieldsFromTask(fullTask, jobOptions || []),
    [fullTask, jobOptions]
  );

  const [jobNumber, setJobNumber] = useState(
    prefill.jobNumber && prefill.jobNumber !== "⚠️ Unassigned"
      ? prefill.jobNumber
      : ""
  );
  const [territory, setTerritory] = useState(
    prefill.territory && prefill.territory !== "⚠️ Unassigned"
      ? prefill.territory
      : ""
  );
  const [category, setCategory] = useState(
    CATEGORIES.includes(prefill.category) ? prefill.category : ""
  );
  const [notes, setNotes] = useState(task.title || "");
  const [activeDropdown, setActiveDropdown] = useState(null);

  const today = new Date();
  const dayOfWeek = WEEKDAYS[today.getDay()];

  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(null);
  const intervalRef = useRef(null);

  const [manualH, setManualH] = useState("");
  const [manualM, setManualM] = useState("");

  useEffect(() => {
    if (running) {
      startRef.current = Date.now() - elapsed * 1000;
      intervalRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
      }, 1000);
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [running]);

  const manualSecs =
    parseInt(manualH || 0, 10) * 3600 + parseInt(manualM || 0, 10) * 60;
  const finalSecs = manualSecs > 0 ? manualSecs : elapsed;

  const canLog = !!category && finalSecs > 0;

  const handleLog = () => {
    if (!canLog) return;
    setRunning(false);
    onLogTime?.({
      id: Date.now(),
      jobNumber,
      territory,
      category,
      notes,
      dayOfWeek,
      rawSeconds: finalSecs,
      additionalSeconds: 0,
      date: today.toLocaleDateString("en-GB"),
      taskId: task.id,
    });
    onLogged?.(finalSecs);
    logTimeToWrike(task.id, finalSecs).then((ok) => {
      triggerToast?.(ok ? "Synced to Wrike task." : "Logged locally, but Wrike sync failed.", ok ? "success" : "info");
    });
    setElapsed(0);
    setManualH("");
    setManualM("");
  };

  const inputCls =
    "w-full text-xs font-medium bg-white border border-[#dce4ec] rounded-lg px-2.5 py-2 text-[#122027] placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-[#12a0e1]/30 focus:border-[#12a0e1] transition-all";
  const labelCls =
    "text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1 block";

  return (
    <div className="bg-[#12a0e1]/5 rounded-2xl border border-[#12a0e1]/20 overflow-visible">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[#12a0e1]/15 bg-white/60 rounded-t-2xl">
        <Clock className="w-3.5 h-3.5 text-[#12a0e1]" />
        <span className="text-[9px] font-black uppercase tracking-widest text-[#12a0e1]">
          Log time to timesheet
        </span>
        <span className="ml-auto text-[9px] font-bold text-slate-400">
          {dayOfWeek}
        </span>
      </div>

      <div className="p-4 flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <div className="font-mono text-2xl font-black text-[#122027] tabular-nums tracking-tight">
            {fmtClock(elapsed)}
          </div>
          <div className="flex items-center gap-1.5 ml-auto">
            {!running ? (
              <button
                onClick={() => setRunning(true)}
                className="flex items-center gap-1.5 text-xs font-bold text-white bg-emerald-500 hover:bg-emerald-600 rounded-lg px-3 py-2 transition-all"
              >
                <Play className="w-3.5 h-3.5" /> Start
              </button>
            ) : (
              <button
                onClick={() => setRunning(false)}
                className="flex items-center gap-1.5 text-xs font-bold text-white bg-rose-500 hover:bg-rose-600 rounded-lg px-3 py-2 transition-all"
              >
                <Square className="w-3.5 h-3.5" /> Stop
              </button>
            )}
            {elapsed > 0 && !running && (
              <button
                onClick={() => setElapsed(0)}
                title="Reset"
                className="p-2 text-slate-400 hover:text-rose-500 hover:bg-white rounded-lg transition-all"
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">
            Or enter manually
          </span>
          <input
            type="number"
            min="0"
            placeholder="Hrs"
            value={manualH}
            onChange={(e) => setManualH(e.target.value)}
            className={`${inputCls} w-16`}
          />
          <input
            type="number"
            min="0"
            max="59"
            placeholder="Min"
            value={manualM}
            onChange={(e) => setManualM(e.target.value)}
            className={`${inputCls} w-16`}
          />
        </div>

        <div className="flex flex-col gap-2.5">
          <div>
            <label className={labelCls}>Job number</label>
            <SearchableSelect
              options={
                jobOptions && jobOptions.length ? jobOptions : DEFAULT_JOBS
              }
              value={jobNumber}
              onChange={setJobNumber}
              placeholder="Type to search or add…"
              icon={Film}
              isGrouped={true}
              dropdownId="hub-job"
              activeDropdown={activeDropdown}
              setActiveDropdown={setActiveDropdown}
            />
          </div>
          <div>
            <label className={labelCls}>Territory</label>
            <SearchableSelect
              options={TERRITORIES}
              value={territory}
              onChange={setTerritory}
              placeholder="Search territory…"
              getPrefix={(val) => TERRITORY_FLAGS[val]}
              dropdownId="hub-territory"
              activeDropdown={activeDropdown}
              setActiveDropdown={setActiveDropdown}
            />
          </div>
          <div>
            <label className={labelCls}>
              Category <span className="text-rose-400">*</span>
            </label>
            <SearchableSelect
              options={CATEGORIES}
              value={category}
              onChange={setCategory}
              placeholder="Search category…"
              icon={Tag}
              isGrouped={true}
              dropdownId="hub-category"
              activeDropdown={activeDropdown}
              setActiveDropdown={setActiveDropdown}
            />
          </div>
          <div>
            <label className={labelCls}>Notes</label>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional notes"
              className={inputCls}
            />
          </div>
        </div>

        <button
          onClick={handleLog}
          disabled={!canLog}
          className="w-full flex items-center justify-center gap-2 text-xs font-black uppercase tracking-widest text-white bg-[#12a0e1] hover:bg-[#0d8abf] disabled:bg-slate-300 disabled:cursor-not-allowed rounded-xl px-4 py-2.5 transition-all"
        >
          <Check className="w-4 h-4" />
          Log {finalSecs > 0 ? fmtClock(finalSecs) : "time"} to today
        </button>
        {!category && (
          <p className="text-[10px] text-amber-600 text-center font-bold">
            Pick a category to log.
          </p>
        )}
      </div>
    </div>
  );
}

// ── Main modal ────────────────────────────────────────────────────────────────

export default function TaskDetailModal({
  task,
  wrikeData,
  attachments: attachmentsProp,
  onClose,
  enableTimeLog = false,
  onLogTime,
  jobOptions,
  triggerToast,
}) {
  const [previewFile, setPreviewFile] = useState(null);
  const [deliverySpecs, setDeliverySpecs] = useState(null);
  const [csvPreviewData, setCsvPreviewData] = useState(null);
  const [fetchedAttachments, setFetchedAttachments] = useState(null);
  const [amendNote, setAmendNote] = useState(null);
  const [amendLoading, setAmendLoading] = useState(false);
  const [fetchedFullTask, setFetchedFullTask] = useState(null);
  const [subtasks, setSubtasks] = useState([]);
  const [subtasksLoading, setSubtasksLoading] = useState(false);
  const [checkedSubtaskIds, setCheckedSubtaskIds] = useState(new Set());

  // Personal note-keeping checklist, separate from Wrike's own subtask
  // status — persisted per parent task so it survives closing/reopening
  // the modal, but never written back to Wrike.
  const subtaskCheckKey = (taskId) => `subtask_checks_${taskId}`;

  useEffect(() => {
    if (!task?.id) { setCheckedSubtaskIds(new Set()); return; }
    try {
      const saved = JSON.parse(localStorage.getItem(subtaskCheckKey(task.id)) || "[]");
      setCheckedSubtaskIds(new Set(saved));
    } catch {
      setCheckedSubtaskIds(new Set());
    }
  }, [task?.id]);

  const toggleSubtaskCheck = (subtaskId) => {
    setCheckedSubtaskIds((prev) => {
      const next = new Set(prev);
      if (next.has(subtaskId)) next.delete(subtaskId);
      else next.add(subtaskId);
      if (task?.id) localStorage.setItem(subtaskCheckKey(task.id), JSON.stringify([...next]));
      return next;
    });
  };

  // Fetch the full task fresh by ID whenever the modal opens. The `task` prop
  // is often a stripped-down board card (no description/subTaskIds), and the
  // shared wrikeData cache only holds it by coincidence now that some views
  // fetch independently — so we always pull the authoritative copy here. This
  // gives us the real description (for notes) and subTaskIds (for the subtask
  // list below), regardless of which view opened the modal.
  useEffect(() => {
    setFetchedFullTask(null);
    setSubtasks([]);
    if (!task?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/wrike/tasks/${task.id}`);
        const full = (await res.json()).data?.[0];
        if (cancelled || !full) return;
        setFetchedFullTask(full);

        const subIds = full.subTaskIds || [];
        if (subIds.length === 0) return;
        setSubtasksLoading(true);

        // Resolve customStatusId -> human name via the last-synced status
        // dictionary (same source the enrichment pipeline uses).
        let statusDict = {};
        try {
          const { data: meta } = await supabase
            .from("wrike_sync_meta")
            .select("status_dictionary")
            .order("last_synced_at", { ascending: false })
            .limit(1)
            .single();
          statusDict = meta?.status_dictionary || {};
        } catch (_) { /* fall back to raw status below */ }

        const sres = await fetch(`/api/wrike/tasks/${subIds.join(",")}`);
        const subs = (await sres.json()).data || [];
        if (cancelled) return;
        setSubtasks(
          subs.map((s) => ({
            id: s.id,
            title: s.title,
            status: s.status,
            statusName: s.customStatusId ? (statusDict[s.customStatusId] || s.status) : s.status,
            permalink: s.permalink || `https://www.wrike.com/open.htm?id=${s.id}`,
          }))
        );
      } catch (_) {
        /* best-effort — modal still renders without subtasks */
      } finally {
        if (!cancelled) setSubtasksLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [task?.id]);

  useEffect(() => {
    if (!task || attachmentsProp) return;
    let cancelled = false;
    fetch(`/api/wrike/tasks/${task.id}/attachments`)
      .then((r) => r.json())
      .then((data) => {
        // Only PDFs matter here (delivery specs) — images/docs/etc. are
        // dropped before they ever reach state or render a thumbnail.
        if (!cancelled) setFetchedAttachments((data.data || []).filter((a) => attachmentKind(a) === "pdf"));
      })
      .catch(() => {
        if (!cancelled) setFetchedAttachments([]);
      });
    return () => {
      cancelled = true;
    };
  }, [task, attachmentsProp]);

  useEffect(() => {
    setAmendNote(null);
    if (!task) return;
    const status = (
      task.tag ||
      task.customStatusName ||
      task.status ||
      ""
    ).toLowerCase();
    if (!status.includes("amend")) return;
    let cancelled = false;
    setAmendLoading(true);
    fetch(`/api/wrike/tasks/${task.id}/comments?plainText=true`)
      .then((r) => r.json())
      .then(async (data) => {
        const comments = data.data || [];
        if (comments.length === 0) return null;
        const latest = [...comments].sort(
          (a, b) => new Date(b.createdDate || 0) - new Date(a.createdDate || 0)
        )[0];
        let author = "";
        try {
          const cRes = await fetch(`/api/wrike/contacts/${latest.authorId}`);
          const cJson = await cRes.json();
          const c = cJson.data?.[0];
          if (c) author = `${c.firstName || ""} ${c.lastName || ""}`.trim();
        } catch (_) {}
        return {
          text: (latest.text || "").trim(),
          author,
          date: latest.createdDate,
        };
      })
      .then((note) => {
        if (!cancelled && note) setAmendNote(note);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setAmendLoading(false); });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id]);

  useEffect(() => {
    return () => {
      if (previewFile?.isObjectUrl) URL.revokeObjectURL(previewFile.url);
    };
  }, [previewFile]);

  // 👇 1. Move fullTask and prefill ABOVE the early return 👇
  const fullTask = wrikeData?.find((t) => t.id === task?.id) || task;

  const prefill = React.useMemo(
    () => guessFieldsFromTask(fullTask, jobOptions || []),
    [fullTask, jobOptions]
  );

  // 👇 2. Now it is safe to return early if there is no task 👇
  if (!task) return null;

  // 👇 3. The rest of your variables stay down here 👇
  // Parse the freshly-fetched raw description the same way the enrichment
  // pipeline does (splits out the MATRIX table, decodes entities) so notes
  // read cleanly even for tasks that were never in the shared cache.
  const parsedFetched = fetchedFullTask?.description
    ? parseWrikeData(fetchedFullTask.description)
    : null;
  const notes =
    fullTask.notesText ||
    parsedFetched?.notesText ||
    (fullTask.description
      ? fullTask.description.replace(/<[^>]*>/g, "").trim()
      : "") ||
    "";
  const links = extractLinks(notes);
  const folderPaths = extractFolderPaths(
    notes,
    fullTask.extractedPathData || parsedFetched?.extractedPathData
  );
  const attachments = attachmentsProp ?? fetchedAttachments ?? [];
  const overdue = isOverdue(task.dueDate);
  const terr = getTerritoryData(task.title);

  const smartTerritory =
    prefill.territory && prefill.territory !== "⚠️ Unassigned"
      ? prefill.territory
      : terr.name;

  const campaignName = task.campaignName || task.projectName || "";
  const tag = task.tag || task.customStatusName || task.status;
  const permalink =
    task.permalink || `https://www.wrike.com/open.htm?id=${task.id}`;

  return createPortal(
    <>
      <div
        className="fixed inset-0 bg-[#122027]/60 backdrop-blur-sm flex items-center justify-center z-[9999] p-4"
        onClick={onClose}
      >
        <div
          className="bg-white rounded-[24px] shadow-2xl w-full max-w-6xl max-h-[90vh] flex flex-col overflow-hidden border border-[#dce4ec]"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-6 py-4 border-b border-[#dce4ec] bg-slate-50/60 flex items-start justify-between gap-3 shrink-0">
            <div className="min-w-0">
              {campaignName && (
                <p className="text-[9px] font-black uppercase text-[#12a0e1] tracking-widest mb-0.5">
                  {campaignName}
                </p>
              )}
              <div className="flex items-center gap-2">
                <span className="text-lg leading-none" title={terr.name}>
                  {terr.flag}
                </span>
                <h2 className="text-base font-black text-[#122027] leading-snug">
                  {task.title}
                </h2>
              </div>
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                {tag && <span className={getTagStyle(tag)}>{tag}</span>}
                {overdue && (
                  <span className="text-[9px] font-black bg-rose-500 text-white px-1.5 py-0.5 rounded-full">
                    OVERDUE
                  </span>
                )}
                {task.dueDate && task.dueDate !== "No Due Date" && (
                  <span className="text-[10px] font-bold text-slate-400">
                    Due{" "}
                    {new Date(task.dueDate).toLocaleDateString("en-GB", {
                      day: "numeric",
                      month: "short",
                    })}
                  </span>
                )}
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 hover:bg-slate-100 rounded-xl text-slate-400 hover:text-slate-600 transition-colors shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex flex-1 min-h-0 overflow-hidden divide-x divide-[#dce4ec]">
            <div className="flex-1 min-w-0 flex flex-col overflow-y-auto p-5 gap-4">
              {(amendLoading || amendNote) && (
                <div className="bg-rose-50 rounded-2xl border border-rose-200">
                  <div className="flex items-center gap-2 px-4 py-2.5 border-b border-rose-200/70 bg-white/60">
                    <MessageSquare className="w-3.5 h-3.5 text-rose-500" />
                    <span className="text-[9px] font-black uppercase tracking-widest text-rose-500">
                      Latest amend note
                    </span>
                    {amendNote?.author && (
                      <span className="ml-auto text-[10px] font-bold text-rose-400">
                        {amendNote.author}
                        {amendNote.date &&
                          ` · ${new Date(amendNote.date).toLocaleDateString(
                            "en-GB",
                            { day: "numeric", month: "short" }
                          )}`}
                      </span>
                    )}
                  </div>
                  <div className="p-4 max-h-48 overflow-y-auto">
                    {amendLoading && !amendNote ? (
                      <div className="flex items-center gap-2 text-xs text-rose-400">
                        <div className="w-3.5 h-3.5 border-2 border-rose-200 border-t-rose-500 rounded-full animate-spin" />
                        Fetching latest comment…
                      </div>
                    ) : amendNote?.text ? (
                      <p className="text-xs text-slate-700 whitespace-pre-line leading-relaxed">
                        {amendNote.text}
                      </p>
                    ) : (
                      <p className="text-xs text-slate-400 italic">
                        No comments on this task yet.
                      </p>
                    )}
                  </div>
                </div>
              )}

              <div className="bg-slate-50 rounded-2xl border border-slate-200/60 overflow-hidden">
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200/60 bg-white">
                  <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">
                    Notes &amp; Context
                  </span>
                  <span className="text-[8px] font-black uppercase tracking-widest bg-[#12a0e1]/10 text-[#12a0e1] px-2 py-0.5 rounded-full border border-[#12a0e1]/20">
                    WRIKE IMPORT
                  </span>
                </div>
                <div className="p-4 max-h-48 overflow-y-auto">
                  {notes ? (
                    <p className="text-xs text-slate-600 whitespace-pre-line leading-relaxed">
                      {notes}
                    </p>
                  ) : (
                    <p className="text-xs text-slate-400 italic">
                      No description on this task
                    </p>
                  )}
                </div>
              </div>

              {(subtasksLoading || subtasks.length > 0) && (
                <div className="bg-slate-50 rounded-2xl border border-slate-200/60 overflow-hidden">
                  <div className="flex items-center gap-2 px-4 py-2.5 border-b border-slate-200/60 bg-white">
                    <ListTree className="w-3.5 h-3.5 text-slate-400" />
                    <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">
                      Subtasks{subtasks.length ? ` (${subtasks.length})` : ""}
                    </span>
                    {subtasks.length > 0 && (
                      <span className="ml-auto text-[10px] font-bold text-slate-400">
                        {checkedSubtaskIds.size}/{subtasks.length} checked
                      </span>
                    )}
                  </div>
                  <div className="p-2 max-h-56 overflow-y-auto flex flex-col gap-1">
                    {subtasksLoading && subtasks.length === 0 ? (
                      <div className="flex items-center gap-2 text-xs text-slate-400 px-2 py-1.5">
                        <div className="w-3.5 h-3.5 border-2 border-slate-200 border-t-[#12a0e1] rounded-full animate-spin" />
                        Loading subtasks…
                      </div>
                    ) : (
                      subtasks.map((st) => {
                        const checked = checkedSubtaskIds.has(st.id);
                        return (
                          <div
                            key={st.id}
                            onClick={() => toggleSubtaskCheck(st.id)}
                            className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-white transition-colors cursor-pointer"
                          >
                            {checked ? (
                              <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                            ) : (
                              <Square className="w-3.5 h-3.5 text-slate-300 shrink-0" />
                            )}
                            <span
                              className={`text-xs font-medium flex-1 truncate ${
                                checked ? "text-slate-400 line-through" : "text-slate-700"
                              }`}
                            >
                              {st.title}
                            </span>
                            <span className={getTagStyle(st.statusName)}>{st.statusName}</span>
                            <a
                              href={st.permalink}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              title="Open in Wrike"
                              className="shrink-0 text-slate-300 hover:text-[#12a0e1] transition-colors"
                            >
                              <ExternalLink className="w-3 h-3" />
                            </a>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              )}

              {enableTimeLog && (
                <TimeLogPanel
                  task={task}
                  fullTask={fullTask}
                  jobOptions={jobOptions}
                  onLogTime={onLogTime}
                  triggerToast={triggerToast}
                  onLogged={(secs) => {
                    triggerToast?.(`Logged ${fmtClock(secs)} to your timesheet.`, "success");
                  }}
                />
              )}

              {attachments.length > 0 && (
                <div>
                  <h3 className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-2.5">
                    Files &amp; Attachments ({attachments.length})
                  </h3>
                  <div className="flex gap-3 flex-wrap">
                    {attachments.map((att) => (
                      <div
                        key={att.id}
                        className="flex flex-col items-center gap-1"
                      >
                        <AttachmentThumb
                          attachment={att}
                          large
                          onPreview={setPreviewFile}
                          onSpecsParsed={({ specs, name }) =>
                            setDeliverySpecs({ specs, name })
                          }
                          onCsvPreview={({ rawSpecs, name }) =>
                            setCsvPreviewData({ rawSpecs, name })
                          }
                        />
                        <p className="text-[8px] text-slate-400 font-bold truncate max-w-[96px] text-center">
                          {att.name}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="w-72 shrink-0 flex flex-col overflow-y-auto p-5 gap-4">
              {links.length > 0 && (
                <div>
                  <h3 className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-2.5 flex items-center gap-1.5">
                    <Link2 className="w-3 h-3" /> Links
                  </h3>
                  <div className="flex flex-col gap-1.5">
                    {links.map((link, i) => {
                      let label = link;
                      try {
                        label = new URL(link).hostname.replace(/^www\./, "");
                      } catch (_) {}
                      return (
                        <a
                          key={i}
                          href={link}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center gap-2 text-[11px] font-bold text-[#12a0e1] hover:text-[#0d8abf] bg-[#12a0e1]/5 hover:bg-[#12a0e1]/10 rounded-xl px-3 py-2 transition-all truncate"
                        >
                          <ExternalLink className="w-3 h-3 shrink-0" />
                          <span className="truncate">{label}</span>
                        </a>
                      );
                    })}
                  </div>
                </div>
              )}

              {folderPaths.length > 0 && (
                <div>
                  <h3 className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-2.5 flex items-center gap-1.5">
                    <FolderOpen className="w-3 h-3" /> Folders
                  </h3>
                  <div className="flex flex-col gap-2">
                    {folderPaths.map((fp, i) => (
                      <FolderRow key={i} fp={fp} />
                    ))}
                  </div>
                </div>
              )}

              {links.length === 0 && folderPaths.length === 0 && (
                <div className="flex flex-col items-center justify-center h-full gap-2 text-slate-300">
                  <Link2 className="w-6 h-6" />
                  <p className="text-xs italic text-center">
                    No links or folder paths found in description
                  </p>
                </div>
              )}
            </div>
          </div>

          <div className="px-6 py-3 border-t border-[#dce4ec] bg-slate-50/60 flex items-center justify-between shrink-0">
            <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">
              {attachments.length} {attachments.length === 1 ? "file" : "files"}{" "}
              · {links.length} {links.length === 1 ? "link" : "links"} ·{" "}
              {folderPaths.length} {folderPaths.length === 1 ? "path" : "paths"}
            </span>
            <a
              href={permalink}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-white bg-[#12a0e1] hover:bg-[#0d8abf] rounded-xl px-4 py-2 transition-all"
            >
              <ExternalLink className="w-3 h-3" /> Open in Wrike
            </a>
          </div>
        </div>
      </div>

      <FilePreviewLightbox
        file={previewFile}
        onClose={() => setPreviewFile(null)}
        allAttachments={attachments || []}
        onNavigate={setPreviewFile}
      />

      {deliverySpecs && (
        <DeliverySpecsModal
          specs={deliverySpecs.specs}
          pdfName={deliverySpecs.name}
          onClose={() => setDeliverySpecs(null)}
        />
      )}

      {csvPreviewData && (
        <CsvPreviewModal
          rawSpecs={csvPreviewData.rawSpecs}
          pdfName={csvPreviewData.name}
          campaignName={campaignName}
          taskTitle={task.title}
          territoryName={smartTerritory}
          sourceFolder={
            folderPaths.find((f) => f.title.toUpperCase() === "FOLDER")?.url || 
            folderPaths[0]?.url || 
            ""
          }
          onClose={() => setCsvPreviewData(null)}
        />
      )}
    </>,
    document.body
  );
}

function FolderRow({ fp }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group flex items-center gap-2 bg-slate-50 hover:bg-slate-100 border border-slate-200/60 rounded-xl px-3 py-2.5 transition-all">
      <FolderOpen className="w-3.5 h-3.5 text-amber-500 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-[9px] font-black uppercase tracking-wider text-slate-500 truncate">
          {fp.title}
        </p>
        <p className="text-[9px] text-slate-400 truncate font-mono">{fp.url}</p>
      </div>
      <button
        onClick={() => {
          navigator.clipboard.writeText(fp.url).catch(() => {});
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="shrink-0 text-slate-400 hover:text-[#12a0e1] transition-colors"
        title="Copy path"
      >
        {copied ? (
          <Check className="w-3.5 h-3.5 text-emerald-500" />
        ) : (
          <Copy className="w-3.5 h-3.5" />
        )}
      </button>
    </div>
  );
}
