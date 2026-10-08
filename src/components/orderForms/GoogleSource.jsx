import React, { useEffect, useState } from "react";
import { CloudDownload, Film, Loader2, Link2 } from "lucide-react";
import SearchableSelect from "../shared/SearchableSelect";
import { connectGoogle, disconnectGoogle, googleConnected, readIndexTabs } from "../../lib/orderForms/googleApi";
import { driveIdFromLink, indexColumns, filmFromTab } from "../../lib/orderForms/googleIndex";
import { loadFilm } from "../../lib/orderForms/loadFilm";

// Loading a film straight from Google: connect, point at the index workbook
// once, pick a film. The sign-in lasts for this tab; nothing is written to
// Google.

// Only the index's id is remembered, so the link isn't pasted every visit.
const INDEX_KEY = "xyi_orders_index_id";

export const GOOGLE_MESSAGES = {
  "not-configured": "Google sign-in isn't set up for this copy of TimeHub.",
  offline: "Google's sign-in couldn't be loaded. Check your connection.",
  denied: "Google didn't grant access. Use your xyi.com account and allow read access.",
  cancelled: "Sign-in was closed before it finished.",
  popup: "The Google sign-in window was blocked. Allow pop-ups for this site and retry.",
  "signed-out": "Your Google sign-in has lapsed. Connect again.",
  "not-found": "That spreadsheet couldn't be found. Check the link.",
  "no-access": "Your Google account can't open that spreadsheet.",
  failed: "Google couldn't be reached. Try again in a moment.",
};
export const googleMessage = (err) => GOOGLE_MESSAGES[err?.reason] || "Something went wrong reading from Google.";

const inputClass =
  "px-3 py-2 text-sm border border-[#dce4ec] rounded-xl outline-none focus:border-[#12a0e1] bg-white min-w-0";
const buttonClass =
  "press flex items-center gap-2 px-4 py-2 bg-[#122027] hover:bg-[#25373c] text-white text-sm font-bold rounded-xl transition-colors disabled:opacity-50 shrink-0";

// `onPartial` gets the markets read so far while a film loads, then null.
export default function GoogleSource({ onLoaded, onBusy, onPartial, signedInTick }) {
  const [connected, setConnected] = useState(googleConnected);
  const [indexId, setIndexId] = useState(() => localStorage.getItem(INDEX_KEY) || "");
  const [linkDraft, setLinkDraft] = useState("");
  const [index, setIndex] = useState(null); // { title, films: [{ title, columns }] }
  const [tab, setTab] = useState("");
  const [contains, setContains] = useState("");
  const [working, setWorking] = useState("");
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState("");

  const fail = (err) => {
    if (err?.reason === "signed-out") setConnected(false);
    setError(googleMessage(err));
  };

  const openIndex = async (id) => {
    setError("");
    setWorking("Reading the index…");
    try {
      const found = await readIndexTabs(id);
      const films = found.tabs
        .map((t) => ({ title: t.title, columns: indexColumns(t.header) }))
        .filter((t) => t.columns);
      if (!films.length) {
        setError("No tab in that spreadsheet has Market and Link columns, so it isn't the index.");
        return;
      }
      localStorage.setItem(INDEX_KEY, id);
      setIndexId(id);
      setIndex({ title: found.title, films });
      setTab(films[0].title);
      setContains(filmFromTab(films[0].title).film);
    } catch (err) {
      fail(err);
    } finally {
      setWorking("");
    }
  };

  const connect = async () => {
    setError("");
    setWorking("Waiting for Google…");
    try {
      await connectGoogle();
      setConnected(true);
      setWorking("");
      if (indexId) await openIndex(indexId);
    } catch (err) {
      setWorking("");
      fail(err);
    }
  };

  // Back after a reload, still signed in: list the films again without a click.
  useEffect(() => {
    if (googleConnected() && indexId) openIndex(indexId);
    // Once, on arrival. openIndex is recreated every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The page's Refresh can sign in again by itself. When it has, show the
  // films here too instead of a Connect button that no longer applies.
  useEffect(() => {
    if (!signedInTick || !googleConnected()) return;
    setConnected(true);
    if (!index && indexId) openIndex(indexId);
    // Runs when the page reports a sign-in, not when the index changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedInTick]);

  // The page holds off file drops while a film is loading.
  useEffect(() => { onBusy?.(!!progress); }, [progress, onBusy]);

  const load = async () => {
    const film = index.films.find((f) => f.title === tab);
    setError("");
    setProgress({ done: 0, total: 0 });
    const arrived = [];
    try {
      // The hour may have run out since the films were listed. Asked for here,
      // inside the click, so the browser lets Google's window open.
      if (!googleConnected()) await connectGoogle();
      const file = await loadFilm({
        indexId, tab, columns: film.columns, contains,
        onProgress: (done, total) => setProgress({ done, total }),
        onMarket: (market) => {
          arrived.push(market);
          onPartial?.({ name: tab, markets: [...arrived] });
        },
      });
      if (!file) setError("That tab has no markets listed.");
      else await onLoaded(file);
    } catch (err) {
      fail(err);
    } finally {
      setProgress(null);
      onPartial?.(null);
    }
  };

  const busy = !!working || !!progress;

  return (
    <div className="bg-white border border-[#dce4ec] rounded-2xl shadow-sm px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2.5 mr-auto min-w-0">
          <CloudDownload className="w-5 h-5 text-[#12a0e1] shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-bold text-[#122027]">Load a film from Google</p>
            <p className="text-xs text-[#768994] truncate">
              {!connected ? "Reads every market's order sheet with your own Google access. Read-only."
                : index ? `${index.title} · the film's sheet is found by name in each market's Drive folder`
                : "Paste the link to the index spreadsheet that lists every market's Drive folder."}
            </p>
          </div>
        </div>

        {!connected && (
          <button onClick={connect} disabled={busy} className={buttonClass}>
            {working ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
            {working || "Connect Google"}
          </button>
        )}

        {connected && !index && (
          <form
            className="flex items-center gap-2 flex-1 min-w-[280px] max-w-xl"
            onSubmit={(e) => {
              e.preventDefault();
              const id = driveIdFromLink(linkDraft);
              if (id) openIndex(id);
              else setError("That doesn't look like a Google Sheets link.");
            }}
          >
            <input
              value={linkDraft}
              onChange={(e) => { setLinkDraft(e.target.value); setError(""); }}
              placeholder="https://docs.google.com/spreadsheets/d/…"
              aria-label="Index spreadsheet link"
              className={`${inputClass} flex-1`}
            />
            <button type="submit" disabled={busy || !linkDraft.trim()} className={buttonClass}>
              {working ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {working || "Open index"}
            </button>
          </form>
        )}

        {connected && index && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="text-[11px] font-bold text-[#768994] w-64">
              <span className="block mb-1">Film</span>
              {/* Typing filters the list; anything that isn't a tab of the index
                  clears the choice rather than loading a film that doesn't exist. */}
              <SearchableSelect
                options={index.films.map((f) => f.title)}
                value={tab}
                onChange={(picked) => {
                  const known = index.films.some((f) => f.title === picked);
                  setTab(known ? picked : "");
                  if (known) setContains(filmFromTab(picked).film);
                }}
                placeholder="Pick a film"
                showAllOnOpen
                icon={Film}
                disabled={busy}
              />
            </div>
            <label className="text-[11px] font-bold text-[#768994]">
              Sheet name in the market's folder contains
              <input
                value={contains}
                onChange={(e) => setContains(e.target.value)}
                disabled={busy}
                className={`${inputClass} block mt-1 w-64 py-2.5 shadow-sm`}
              />
            </label>
            <button onClick={load} disabled={busy || !tab || !contains.trim()} className={`${buttonClass} py-2.5`}>
              {progress ? <Loader2 className="w-4 h-4 animate-spin" /> : <CloudDownload className="w-4 h-4" />}
              {progress ? `Reading ${progress.done} of ${progress.total || "…"}` : "Load markets"}
            </button>
            <button
              onClick={() => { localStorage.removeItem(INDEX_KEY); setIndexId(""); setIndex(null); setLinkDraft(""); }}
              disabled={busy}
              className="px-2 py-2 text-xs font-bold text-[#768994] hover:text-[#122027] disabled:opacity-50"
            >
              Change index
            </button>
            <button
              onClick={() => { disconnectGoogle(); setConnected(false); setIndex(null); setError(""); }}
              disabled={busy}
              className="px-2 py-2 text-xs font-bold text-[#768994] hover:text-[#122027] disabled:opacity-50"
            >
              Disconnect
            </button>
          </div>
        )}
      </div>

      {progress && progress.total > 0 && (
        <div className="mt-3 h-1.5 rounded-full bg-slate-100 overflow-hidden">
          <div className="h-full bg-[#12a0e1] transition-[width] duration-300" style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
        </div>
      )}
      {error && <p role="alert" className="mt-3 text-sm font-medium text-rose-600">{error}</p>}
    </div>
  );
}
