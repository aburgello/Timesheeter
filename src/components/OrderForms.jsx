import React, { useCallback, useEffect, useRef, useState } from "react";
import { ClipboardList, FileSpreadsheet, Loader2, RefreshCw } from "lucide-react";
import PageHeader from "./shared/PageHeader";
import DropZone from "./orderForms/DropZone";
import FileSwitcher from "./orderForms/FileSwitcher";
import GoogleSource, { googleMessage } from "./orderForms/GoogleSource";
import MarketList from "./orderForms/MarketList";
import MarketView from "./orderForms/MarketView";
import { readXlsx } from "../lib/orderForms/readXlsx";
import { parseWorkbook } from "../lib/orderForms/parseWorkbook";
import { listFiles, saveFile, removeFile } from "../lib/orderForms/store";
import { connectGoogle, googleConfigured, googleConnected } from "../lib/orderForms/googleApi";
import { loadFilm } from "../lib/orderForms/loadFilm";
import { confirmAction } from "../lib/confirm";
import { notify } from "../lib/toast";
import { isoToday } from "../utils/dates";

// The PMs' readable view of the Paramount order forms. Orders come in two
// ways: a film read live from Google (every market's sheet, found through the
// index workbook), or a workbook dropped onto the page. Either way they are
// parsed in the browser and kept in this browser only (see lib/orderForms/
// store.js for why they never go to Supabase). Read-only: nothing here writes
// to Google or Wrike.

// `#orderforms/<fileId>/<market>` — the open file and market live in the hash,
// so a reload stays put and Back returns from a market to the overview.
const readHash = () => {
  const [page, fileId, market] = window.location.hash.slice(1).split("/");
  if (page !== "orderforms") return {};
  return { fileId: fileId || null, market: market ? decodeURIComponent(market) : null };
};
const hashFor = (fileId, market) =>
  `#orderforms${fileId ? `/${fileId}` : ""}${fileId && market ? `/${encodeURIComponent(market)}` : ""}`;

const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes("Files");

const readAt = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export default function OrderForms() {
  const [files, setFiles] = useState(null); // null until the store has answered
  const [view, setView] = useState(readHash);
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(null); // { done, total }
  const [signedInTick, setSignedInTick] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const dragDepth = useRef(0);
  const today = isoToday();

  useEffect(() => {
    listFiles().then(setFiles);
  }, []);

  useEffect(() => {
    const onHashChange = () => setView(readHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const go = useCallback((fileId, market, { replace = false } = {}) => {
    const hash = hashFor(fileId, market);
    if (window.location.hash !== hash) window.history[replace ? "replaceState" : "pushState"]({}, "", hash);
    setView({ fileId, market });
  }, []);

  const file = files?.find((f) => f.id === view.fileId) || files?.[0] || null;
  const market = file && view.market ? file.markets.find((m) => m.name === view.market && !m.unreadable) : null;

  // Take a parsed file into the page and the store. `replaces` is the loaded
  // file it supersedes (same name), already agreed to by the caller.
  const adopt = useCallback(async (parsed, replaces, keepMarket) => {
    if (replaces) await removeFile(replaces.id);
    const kept = await saveFile(parsed);
    setFiles((prev) => [parsed, ...(prev || []).filter((f) => f.id !== replaces?.id)]);
    go(parsed.id, keepMarket || null, { replace: !!replaces });
    const readable = parsed.markets.filter((m) => !m.unreadable).length;
    if (kept) notify(`${readable} of ${parsed.markets.length} markets read`, "success");
    else notify("Loaded for now. This browser couldn't store it, so it won't be here after a reload.", "error");
  }, [go]);

  const confirmReplace = (name) => confirmAction({
    title: "Replace what's loaded?",
    message: `${name} is already loaded. Replace it with this newer read?`,
    confirmLabel: "Replace",
  });

  const addFile = useCallback(async (picked) => {
    setError("");
    setBusy(true);
    try {
      const parsed = parseWorkbook(await readXlsx(picked), picked.name);
      if (!parsed) {
        setError("This doesn't look like an order form. No market tabs were found in it.");
        return;
      }
      const existing = (files || []).find((f) => f.name === parsed.name);
      if (existing && !(await confirmReplace(parsed.name))) return;
      await adopt(parsed, existing);
    } catch (err) {
      // Only the reason is kept: a workbook's contents never go into an error.
      setError(err.message === "not-xlsx"
        ? "That isn't an .xlsx file. In Google Sheets, choose File, Download, Microsoft Excel (.xlsx)."
        : "That file couldn't be read. Download it again from Google Sheets and retry.");
    } finally {
      setBusy(false);
    }
  }, [files, adopt]);

  const addFilm = useCallback(async (loaded) => {
    const existing = (files || []).find((f) => f.name === loaded.name);
    if (existing && !(await confirmReplace(loaded.name))) return;
    await adopt(loaded, existing);
  }, [files, adopt]);

  // Read a Google-loaded film again from the same index tab. Asking to refresh
  // is the confirmation, so the old read is replaced without a second prompt.
  const refresh = async () => {
    const current = file;
    setError("");
    setRefreshing({ done: 0, total: 0 });
    try {
      if (!googleConnected()) {
        await connectGoogle();
        setSignedInTick((n) => n + 1);
      }
      const loaded = await loadFilm({
        ...current.source,
        onProgress: (done, total) => setRefreshing({ done, total }),
      });
      if (loaded) await adopt(loaded, current, market?.name);
      else setError("That tab of the index no longer lists any markets.");
    } catch (err) {
      setError(googleMessage(err));
    } finally {
      setRefreshing(null);
    }
  };

  const dropFile = async (target) => {
    const ok = await confirmAction({
      title: "Remove this from the page?",
      message: `${target.name} will be removed from this browser. Nothing in Google is affected.`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    await removeFile(target.id);
    setFiles((prev) => prev.filter((f) => f.id !== target.id));
    if (file?.id === target.id) go(null, null, { replace: true });
  };

  // The whole page is the drop target, so a second file can be added from the
  // overview. dragenter/leave fire for every child element, hence the depth.
  const onDragEnter = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragLeave = (e) => {
    if (!hasFiles(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped && !working) addFile(dropped);
  };

  const working = busy || googleBusy || !!refreshing;
  const empty = files && files.length === 0;

  return (
    <div
      className="min-h-screen bg-slate-100 text-[#122027] font-sans pb-16"
      onDragEnter={onDragEnter}
      onDragOver={(e) => hasFiles(e) && e.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <PageHeader
        pageId="orderforms"
        icon={ClipboardList}
        title="Client Orders"
        subtitle="Market orders at a glance"
      />

      <div className="max-w-[1800px] mx-auto px-4 sm:px-6 py-6 space-y-4">
        {files === null && <div className="h-64 rounded-2xl bg-white/60 border border-[#dce4ec] animate-pulse" />}

        {files && googleConfigured() && <GoogleSource onLoaded={addFilm} onBusy={setGoogleBusy} signedInTick={signedInTick} />}

        {empty && <DropZone onFile={addFile} busy={busy} dragging={dragging} error={error} />}

        {files && files.length > 0 && (
          <>
            <div className="flex flex-wrap items-stretch gap-2">
              <FileSwitcher
                files={files}
                selectedId={file?.id}
                onSelect={(id) => go(id, null)}
                onRemove={dropFile}
                onFile={addFile}
                busy={working}
              />
              {file?.source && (
                <button
                  onClick={refresh}
                  disabled={working}
                  title={`Read from Google at ${readAt(file.loadedAt)}`}
                  className="ml-auto flex items-center gap-2 px-4 rounded-xl bg-white border border-[#dce4ec] hover:border-[#12a0e1] text-sm font-bold text-[#122027] transition-colors disabled:opacity-60 min-h-[52px]"
                >
                  {refreshing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                  {refreshing ? `Reading ${refreshing.done} of ${refreshing.total || "…"}` : `Refresh · read at ${readAt(file.loadedAt)}`}
                </button>
              )}
            </div>
            {error && <p role="alert" className="text-sm font-medium text-rose-600">{error}</p>}
            {market
              ? <MarketView market={market} kind={market.kind || file.kind} today={today} onBack={() => go(file.id, null)} />
              : <MarketList file={file} today={today} onOpen={(name) => go(file.id, name)} />}
          </>
        )}
      </div>

      {dragging && !empty && (
        <div className="fixed inset-0 z-[9000] pointer-events-none flex items-center justify-center bg-[#122027]/60 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 px-10 py-8 rounded-2xl border-2 border-dashed border-white/70 text-white">
            <FileSpreadsheet className="w-10 h-10" strokeWidth={1.5} />
            <p className="font-display text-2xl font-bold tracking-tight">Drop to add this order form</p>
          </div>
        </div>
      )}
    </div>
  );
}
