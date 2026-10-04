// Jobs setup: choose a studio and film, activate template slots,
// and push them to Wrike. Also used by the PMs' Job Book page.
//
// Part of Administration. Split out of components/Management.jsx, which is
// still the entry point and re-exports what other screens import.
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Plus, FolderPlus, Film, X, Check, Search, RefreshCw, AlertTriangle, ChevronRight, CheckCircle2, Folder, FolderOpen, Loader2, Globe, Undo2, Eye, ListChecks } from "lucide-react";
import { supabase, selectAll } from "../../lib/supabaseClient";
import { confirmAction } from "../../lib/confirm";
import { notify } from "../../lib/toast";
import { fetchAllFolders, slotSuffix, buildFilmView, discoverItemPriceField, fetchFolderItemPrice } from "../../lib/wrikeCampaign";
import { FILM_GROUP_ORDER, STUDIO_OPTIONS } from "./constants";
import { StrictSelect } from "./fields";
import { FilmSyncModal } from "./FilmSyncModal";
import { JobForm, JobModal, nextJobCode } from "./JobForm";
import { PushToWrikeModal } from "./PushToWrikeModal";

// ── Film Setup: Wrike master-template folder trees ────────────────────────────
// Mirrors each studio's "_STUDIO_MASTER_TEMPLATES" folder in Wrike. Every node
// tagged jobNumber:true gets its own auto-generated job number when a film is
// created — mirrors how the real template's "JOBNUMBER_..." folders are
// currently hand-replaced per new job.
const FOLDER_TEMPLATES = {
  Paramount: {
    label: "_Paramount_MASTER_TEMPLATES",
    children: [
      { label: "_House_Keeping" },
      { label: "Digital" },
      { label: "Launch", children: [
        { label: "Artwork_Launch" },
        { label: "Character_Poster_Launch" },
        { label: "PLF_Launch" },
        { label: "Reporting" },
      ]},
      { label: "Print", children: [
        { label: "DOM" },
        { label: "INT_Creative", children: [
          { label: "JOBNUMBER_Finishing", jobNumber: true },
          { label: "JOBNUMBER_Print_Quad_Creation_OV", jobNumber: true },
          { label: "INTL", children: [
            { label: "JOBNUMBER_CMYK_Conversions", jobNumber: true },
            { label: "JOBNUMBER_INTL_Asset_Chart", jobNumber: true },
            { label: "JOBNUMBER_INTL_Outdoor_Campaign_Bespoke", jobNumber: true },
            { label: "JOBNUMBER_INTL_Outdoor_Campaign_Masters", jobNumber: true },
            { label: "JOBNUMBER_INTL_PRINT_Outdoor_Campaign_Markets", jobNumber: true },
            { label: "JOBNUMBER_Print_OV_Mechs", jobNumber: true },
            { label: "JOBNUMBER_Standee", jobNumber: true },
            { label: "JOBNUMBER_TYPE_Title_Adjustment", jobNumber: true },
            { label: "JOBNUMBER_TYPE_Titles", jobNumber: true },
          ]},
        ]},
      ]},
    ],
  },
};
// Studios we can currently fetch live from Wrike (have a master-template folder).
// Paramount also ships a hardcoded fallback tree above; Universal is fetch-only.
const TESTABLE_STUDIOS = new Set(["Paramount", "Universal"]);
// When a slot is activated inside a studio's folder, the ordering client is that
// studio's international arm by default (req: "Client — if I'm in Paramount
// folder assume Paramount International"). Editable afterwards in the detail modal.
const STUDIO_CLIENT = {
  Paramount: "Paramount International",
  Universal: "Universal International",
};
const JOBS_SETUP_TABS = [
  { id: "campaign", label: "Bulk Campaign", desc: "Generate a whole campaign's job numbers at once from a studio's Wrike folder template.", icon: FolderPlus, color: "from-blue-500 to-[#12a0e1]" },
  { id: "custom",   label: "Custom Job",    desc: "Add a single one-off job manually, with its own job number and details.", icon: Plus, color: "from-emerald-500 to-teal-600" },
];
// Exported: also rendered inside the PMs' standalone Job Book page (JobBook.jsx).
// initialStudio/initialFilm + lockPickers let this same section be rendered
// against one already-chosen film (the Films tab's campaign modal), where the
// studio and film are resolved from Wrike instead of picked by hand — so that
// modal gets the real thing (activate, push, re-tag) rather than a read-only
// copy that would drift out of step with this one.
export function JobsSetupSection({ setActiveTab, initialStudio, initialFilm, lockPickers = false }) {
  const [innerTab, setInnerTab] = useState("campaign");
  const [studio, setStudio] = useState(initialStudio || "Paramount");
  const [filmTitle, setFilmTitle] = useState(initialFilm || "");
  const [fetchedTemplate, setFetchedTemplate] = useState(null); // real subtree pulled live from Wrike
  const [fetchingTemplate, setFetchingTemplate] = useState(false);
  const [fetchInfo, setFetchInfo] = useState(null); // { rootLabel, jobCount } | { error }
  // The selected film's OWN live subtree (source of truth for what actually
  // exists / is already numbered), independent of the studio template.
  // { filmProject, tree, hasSlots } | null. hasSlots:false ⇒ fall back to template.
  const [filmView, setFilmView] = useState(null);
  const [filmViewLoading, setFilmViewLoading] = useState(false);
  // A film shared into several studio folders ("territories") — which one we show.
  // null = the base studio findFilmLocation picks. Reset when the film changes.
  const [territoryId, setTerritoryId] = useState(null);
  // One shared, cached fetch of the whole (recycle-bin-filtered) folder tree, so
  // the film-view lookup doesn't re-hit Wrike on every film change.
  const foldersRef = useRef(null);
  const [films, setFilms] = useState([]);
  const [filmsLoading, setFilmsLoading] = useState(true);
  // title → { studio }. The picker groups on it; `films` stays a plain string
  // list for the job form / film-sync consumers, which expect titles.
  const [filmMeta, setFilmMeta] = useState(new Map());
  // Same titles, ordered by most recent job per film for the grouped picker —
  // within each studio group the film being worked on right now sits on top.
  const [filmOptions, setFilmOptions] = useState([]);
  const [clients, setClients] = useState([]);
  const [workCategories, setWorkCategories] = useState([]);
  const [descs, setDescs] = useState([]);
  const [customSaving, setCustomSaving] = useState(false);
  const [customCreated, setCustomCreated] = useState(null); // job_number of the row just created

  // Per-studio in-memory cache of the fetched template, so re-selecting a studio
  // you've already loaded is instant and doesn't re-hit Wrike. Cleared only on a
  // manual refresh (the small re-sync affordance below the studio picker).
  const templateCache = useRef({}); // { [studio]: { tree, info } }

  // Every Job Book row already activated against a template slot for the selected
  // film. A flat list rather than a slot→job map on purpose: the same slot can be
  // activated any number of times (numerous launches, several title treatments),
  // so one slot owns N jobs. Nothing is created until a slot is clicked and the
  // form below is submitted, so a film never ends up with a pile of job numbers
  // nobody asked for — you activate exactly what's needed, when the work comes in.
  const [filmJobs, setFilmJobs] = useState([]);
  const [loadingSlots, setLoadingSlots] = useState(false);

  // The staged activation. Clicking a template slot doesn't write anything: it
  // allocates the next code, previews the folder it would create in the film tree
  // below, and opens the job form pre-filled from the slot. Because a draft isn't
  // keyed by slot, an already-allocated slot stays clickable — that's what makes
  // repeat launches of the same job type possible.
  // { slotLabel, description, path: [containerLabels], code } | null
  const [draft, setDraft] = useState(null);
  const [allocatingDraft, setAllocatingDraft] = useState(false);
  const [activateError, setActivateError] = useState(null);
  const [creatingJob, setCreatingJob] = useState(false);
  const draftRef = useRef(null); // scroll target so the form comes into view on activate
  // Item Price custom field, discovered once per session. undefined = not
  // looked up yet; null = this member can't see it (or it doesn't exist).
  const itemPriceFieldRef = useRef(undefined);

  // Job numbers activated during THIS session (across films) — the reviewable
  // list at the bottom. Most-recent first. Each can be opened in a detail modal
  // to fill in costs/billing, or undone (which deletes the row again).
  const [sessionJobs, setSessionJobs] = useState([]);
  const [reviewJob, setReviewJob] = useState(null); // job row currently open in the detail modal
  const [reviewSaving, setReviewSaving] = useState(false);
  const [undoingId, setUndoingId] = useState(null); // job id currently being undone
  const [showFilmSync, setShowFilmSync] = useState(false); // req 6 dry-run modal
  const [pushMode, setPushMode] = useState(null);          // null | "push" (req 5+1) | "retag" (req 2+4)

  // Reloadable so the Film-sync modal can refresh the picker after adding films.
  // The picker groups films by studio; within each group the film whose most
  // recent job is newest (MAX(jobs.updated_at)) sits on top — i.e. what's being
  // worked on right now rises. Films with no jobs yet fall to the bottom of
  // their group. Studio is stored on the film (set at sync, editable on Films).
  const loadFilms = useCallback(() => {
    Promise.all([
      supabase.from("films").select("title, studio").order("title"),
      // selectAll: a plain read stops at 1000 rows without erroring, and the
      // book is at 949. Past that, "most recently worked-on film first" would
      // have been decided by an arbitrary subset of jobs — and silently, since
      // a truncated page looks exactly like a complete one.
      selectAll("jobs", "film_title, updated_at"),
    ]).then(([filmRes, jobRows]) => {
      const filmRows = filmRes.data || [];
      // Most recent activity per film — the film's newest job touch.
      const latestJob = new Map();
      (jobRows || []).forEach((j) => {
        if (!j.film_title) return;
        const ts = new Date(j.updated_at || 0).getTime();
        const prev = latestJob.get(j.film_title);
        if (prev === undefined || ts > prev) latestJob.set(j.film_title, ts);
      });
      const meta = new Map();
      filmRows.forEach(f => meta.set(f.title, { studio: f.studio || null }));
      setFilmMeta(meta);
      setFilms(filmRows.map(f => f.title));
      const byRecency = [...filmRows].sort((a, b) =>
        (latestJob.get(b.title) || 0) - (latestJob.get(a.title) || 0) || a.title.localeCompare(b.title)
      );
      setFilmOptions(byRecency.map(f => f.title));
      setFilmsLoading(false);
    });
  }, []);

  // Which bucket a film lands in for the picker: under its studio, with
  // no-studio films in Other. Within a group the most recently worked-on film
  // sits on top (filmOptions is already sorted that way).
  const filmGroup = (title) => filmMeta.get(title)?.studio || "Other";

  // Films are added in the Films tab first — this section only picks from that
  // list, it never creates new films, so the two stay in sync by construction.
  useEffect(() => {
    loadFilms();
    supabase.from("clients").select("name").order("name").then(({ data }) => setClients((data || []).map(c => c.name)));
    supabase.from("job_work_categories").select("name").order("name").then(({ data }) => setWorkCategories((data || []).map(c => c.name)));
    supabase.from("project_descriptions").select("description").order("description").then(({ data }) => setDescs((data || []).map(d => d.description)));
  }, []);

  const handleCreateCustomJob = async (form) => {
    setCustomSaving(true);
    const payload = {
      ...form,
      start_date: form.start_date || null,
      completed_date: form.completed_date || null,
      fixed_cost: form.fixed_cost === "" ? null : parseFloat(form.fixed_cost),
      third_party_cost: form.third_party_cost === "" ? null : parseFloat(form.third_party_cost),
      estimated_cost: form.estimated_cost === "" ? null : parseFloat(form.estimated_cost),
    };
    const { error } = await supabase.from("jobs").insert(payload);
    setCustomSaving(false);
    if (!error) setCustomCreated(form.job_number);
    else notify(
      error.code === "23505"
        ? `Job number "${form.job_number}" already exists in Job Book.`
        : "Failed to create job: " + error.message,
      "error"
    );
  };

  // Walk a tree (studio template OR a film's own subtree), collecting every
  // jobNumber:true leaf. Film-view nodes carry `allocated`/`code`/`description`
  // already (read from the live folder name); template nodes don't, so we derive
  // description from the label and default allocated:false.
  const collectJobLeaves = (node) => {
    let leaves = node.jobNumber
      ? [{
          label: node.label,
          description: node.description || node.label.replace(/^JOBNUMBER_?/i, "").replace(/_/g, " ").trim() || "General",
          allocated: !!node.allocated,
          code: node.code || null,
        }]
      : [];
    (node.children || []).forEach(c => { leaves = leaves.concat(collectJobLeaves(c)); });
    return leaves;
  };

  // Pull the real master-template folder subtree from Wrike via the OAuth
  // proxy. Builds the same { label, children, jobNumber } shape as the
  // hardcoded FOLDER_TEMPLATES, tagging every "JOBNUMBER_..." folder so it
  // gets a generated code.
  const fetchTemplateFromWrike = useCallback(async (targetStudio, { force = false } = {}) => {
    if (!TESTABLE_STUDIOS.has(targetStudio)) return;
    // Serve from the per-studio cache unless the caller explicitly forces a refresh.
    if (!force && templateCache.current[targetStudio]) {
      const cached = templateCache.current[targetStudio];
      setFetchedTemplate(cached.tree);
      setFetchInfo(cached.info);
      return;
    }
    if (!localStorage.getItem("wrike_user_id")) { setFetchInfo({ error: "Wrike not connected — connect it in Profile → Settings first." }); return; }
    setFetchingTemplate(true);
    setFetchInfo(null);
    setFetchedTemplate(null);
    const studio = targetStudio; // shadow so the existing body below reads the requested studio
    try {
      // The shared folder-tree download: skips the Recycle Bin (so a deleted
      // template dupe can't win), retries rate limits, and throws on failure.
      const fd = await fetchAllFolders();
      // Find candidate master-template roots by fuzzy title match. There can be
      // several ("_Paramount_MASTER_TEMPLATES", a "... copy", archived dupes), so
      // build each subtree and pick the one with the most JOBNUMBER folders,
      // penalising obvious duplicates — that's the real, populated template.
      const wanted = studio.toUpperCase();
      const candidates = Object.values(fd).filter(f => {
        const norm = (f.title || "").toUpperCase().replace(/[_\s]+/g, " ");
        return norm.includes(wanted) && norm.includes("MASTER TEMPLATE");
      });
      if (!candidates.length) throw new Error(`No "${studio}" master-template folder found in Wrike.`);

      const buildFrom = (rootId) => {
        const visited = new Set();
        const build = (id) => {
          if (visited.has(id)) return null;
          visited.add(id);
          const node = fd[id];
          if (!node) return null;
          const children = (node.childIds || []).map(build).filter(Boolean);
          // id is carried through so a staged slot can read its own Wrike
          // custom fields (Item Price) without re-walking the tree.
          const out = { label: node.title, id: node.id };
          if (children.length) out.children = children;
          if (/JOBNUMBER/i.test(node.title || "")) out.jobNumber = true;
          return out;
        };
        return build(rootId);
      };

      let best = null;
      for (const cand of candidates) {
        const tree = buildFrom(cand.id);
        const jobCount = collectJobLeaves(tree).length;
        const isDupe = /\b(COPY|ARCHIVE|ARCHIVED|OLD|BACKUP|BAK)\b/i.test(cand.title || "");
        const score = jobCount - (isDupe ? 1e6 : 0) - (cand.title || "").length * 0.001;
        if (!best || score > best.score) best = { tree, jobCount, title: cand.title, score };
      }
      const info = { rootLabel: best.title, jobCount: best.jobCount };
      templateCache.current[targetStudio] = { tree: best.tree, info };
      setFetchedTemplate(best.tree);
      setFetchInfo(info);
    } catch (e) {
      setFetchInfo({ error: e.message });
      setFetchedTemplate(null);
    } finally {
      setFetchingTemplate(false);
    }
  }, []);

  // Req 7 — auto-fetch the studio's master template the moment a studio is
  // selected (no manual "Fetch" button). Re-selecting a studio you've already
  // loaded is served instantly from templateCache. Req 4's reconcile: every
  // switch re-reads the live tree, so renamed folders in Wrike show up here.
  useEffect(() => { fetchTemplateFromWrike(studio); }, [studio, fetchTemplateFromWrike]);

  // Load (and cache) the whole folder tree once, so we can derive the selected
  // film's own subtree without re-fetching. `force` busts the cache after a
  // re-sync so renamed/pushed folders show up.
  const ensureFolders = useCallback(async ({ force = false } = {}) => {
    if (!force && foldersRef.current) return foldersRef.current;
    const byId = await fetchAllFolders();
    foldersRef.current = byId;
    return byId;
  }, []);

  // Read the selected film's OWN live subtree (see buildFilmView). This is what
  // makes an already-numbered campaign read as done instead of the template's
  // "activate everything" — the film's real XY##### folders are the truth. Films
  // with no slot folders yet leave filmView.hasSlots false, and the render falls
  // back to the studio template to show what could be created.
  // A new film has its own set of territories — drop any previous selection.
  useEffect(() => { setTerritoryId(null); }, [filmTitle]);

  useEffect(() => {
    let cancelled = false;
    if (!filmTitle.trim() || !localStorage.getItem("wrike_user_id")) { setFilmView(null); return; }
    setFilmViewLoading(true);
    ensureFolders()
      .then((byId) => { if (!cancelled) setFilmView(buildFilmView(byId, filmTitle, territoryId)); })
      .catch(() => { if (!cancelled) setFilmView(null); })
      .finally(() => { if (!cancelled) setFilmViewLoading(false); });
    return () => { cancelled = true; };
  }, [filmTitle, territoryId, ensureFolders]);

  // Load every job already activated against a template slot for this film, so
  // the film tree can show which slots are numbered and how many times over.
  const loadSlotJobs = useCallback(async (film) => {
    if (!film) { setFilmJobs([]); return; }
    setLoadingSlots(true);
    const { data } = await supabase.from("jobs").select("*").eq("film_title", film).not("template_slot", "is", null);
    setFilmJobs(data || []);
    setLoadingSlots(false);
  }, []);

  // slot → the jobs activated against it (usually one, several for a slot run
  // more than once). Drives the ALLOCATED badges and the ×N counts. Keyed by
  // slotSuffix, not the raw label, so a job stamped against the template's
  // "JOBNUMBER_French_Canada_Assets" still matches the film's own copy of that
  // folder once Wrike has renamed it to "XY026047_French_Canada_Assets".
  const jobsBySlot = useMemo(() => {
    const map = {};
    filmJobs.forEach(j => { (map[slotSuffix(j.template_slot)] ||= []).push(j); });
    return map;
  }, [filmJobs]);

  useEffect(() => { loadSlotJobs(filmTitle); }, [filmTitle, loadSlotJobs]);

  // Re-read just the film's own subtree from Wrike (busts the folder cache), so a
  // folder renamed/reverted in Wrike reflects here on demand. Lighter than resync
  // (doesn't re-pull the studio template) and available even when the pickers —
  // and their Re-sync button — are hidden (lockPickers, opened from the Films tab).
  const refreshFilmView = useCallback(() => {
    if (!filmTitle.trim() || !localStorage.getItem("wrike_user_id")) return;
    loadSlotJobs(filmTitle); // re-read Job Book too, so folder-tracking (wrike_folder_id) is current for reconciliation
    foldersRef.current = null;
    setFilmViewLoading(true);
    ensureFolders({ force: true })
      .then((byId) => setFilmView(buildFilmView(byId, filmTitle, territoryId)))
      .catch(() => setFilmView(null))
      .finally(() => setFilmViewLoading(false));
  }, [filmTitle, territoryId, ensureFolders, loadSlotJobs]);

  // Force-refresh both the studio template AND the film's own subtree from Wrike
  // (busts the folder cache), so a just-pushed / just-renamed film reflects here.
  const resync = useCallback(() => {
    foldersRef.current = null;
    fetchTemplateFromWrike(studio, { force: true });
    if (filmTitle.trim() && localStorage.getItem("wrike_user_id")) {
      setFilmViewLoading(true);
      ensureFolders({ force: true })
        .then((byId) => setFilmView(buildFilmView(byId, filmTitle, territoryId)))
        .catch(() => setFilmView(null))
        .finally(() => setFilmViewLoading(false));
    }
  }, [studio, filmTitle, territoryId, fetchTemplateFromWrike, ensureFolders]);

  // Stage one slot. Allocates the next sequential XY code fresh (so it reflects
  // anything created anywhere since we last looked) and opens the form below,
  // pre-filled from the slot — but writes nothing. Deliberately not blocked by
  // an existing activation: clicking a slot that's already been used stages
  // ANOTHER job of that type, which is the whole point of the flow.
  const activateSlot = async (leaf) => {
    if (allocatingDraft) return;
    setAllocatingDraft(true);
    setActivateError(null);
    try {
      // The slot's Item Price in Wrike becomes the job's Fixed Cost. Read
      // alongside the code rather than after it, and tolerated as absent: the
      // field is only visible to project managers, and plenty of slots carry
      // no price at all — either way the cost is just left empty.
      const [code, itemPrice] = await Promise.all([
        nextJobCode(),
        (async () => {
          if (!leaf.id) return null;
          const field = itemPriceFieldRef.current !== undefined
            ? itemPriceFieldRef.current
            : (itemPriceFieldRef.current = await discoverItemPriceField().catch(() => null));
          return field ? fetchFolderItemPrice(leaf.id, field.id) : null;
        })(),
      ]);
      setDraft({
        slotLabel: leaf.label,
        description: leaf.description,
        path: leaf.path || [],
        code,
        itemPrice,
      });
      // Bring the preview + form into view — the form is a long way below the
      // template tree that was just clicked.
      requestAnimationFrame(() => draftRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    } catch (e) {
      setActivateError(e.message);
    } finally {
      setAllocatingDraft(false);
    }
  };

  // Commit the staged draft: one Job Book row, tagged with the template slot it
  // came from. The code was allocated when the slot was clicked, but re-check it
  // here — a collision means someone else took it while the form was open, so
  // allocate again rather than failing the user's typing.
  const createDraftJob = async (form) => {
    if (!draft || creatingJob) return;
    setCreatingJob(true);
    setActivateError(null);
    try {
      const row = {
        ...form,
        template_slot: draft.slotLabel,
        start_date: form.start_date || null,
        completed_date: form.completed_date || null,
        fixed_cost: form.fixed_cost === "" ? null : parseFloat(form.fixed_cost),
        third_party_cost: form.third_party_cost === "" ? null : parseFloat(form.third_party_cost),
        estimated_cost: form.estimated_cost === "" ? null : parseFloat(form.estimated_cost),
      };
      let { data, error } = await supabase.from("jobs").insert(row).select().single();
      if (error?.code === "23505") {
        const fresh = await nextJobCode();
        row.job_number = (form.job_number || "").replace(/XY\d+/, fresh);
        ({ data, error } = await supabase.from("jobs").insert(row).select().single());
      }
      if (error) throw error;
      setFilmJobs(prev => [...prev.filter(j => j.id !== data.id), data]);
      // Prepend to the session review list (dedupe by id, just in case).
      setSessionJobs(prev => [data, ...prev.filter(j => j.id !== data.id)]);
      setDraft(null);
      // Creating a job and pushing it to Wrike are one action, not two. The
      // Job Book row is written first (it's what allocates the code), but the
      // push confirmation follows immediately so a job can't sit in the Book
      // having never reached Wrike because nobody pressed a second button.
      setPushMode("push");
    } catch (e) {
      setActivateError(e.message);
    } finally {
      setCreatingJob(false);
    }
  };

  // Req 3 — undo an activation: delete the jobs row again and drop it from both
  // the film's job list and the session review list. (Once live Wrike writes
  // land, this will also clear the pushed folder / custom field — that's wired
  // in the Wrike-write phase.)
  const undoActivation = async (job, { skipConfirm = false } = {}) => {
    if (!job?.id || undoingId) return;
    if (!skipConfirm) {
      const ok = await confirmAction({
        title: "Undo this job number?",
        message: `“${job.job_number}” will be removed from Job Book.`,
        confirmLabel: "Undo activation",
        danger: true,
      });
      if (!ok) return;
    }
    setUndoingId(job.id);
    const { error } = await supabase.from("jobs").delete().eq("id", job.id);
    setUndoingId(null);
    if (error) { notify("Couldn't undo: " + error.message, "error"); return; }
    setFilmJobs(prev => prev.filter(j => j.id !== job.id));
    setSessionJobs(prev => prev.filter(j => j.id !== job.id));
  };

  // Bulk undo — every job activated this session. Confirmed once.
  const undoAllSession = async () => {
    if (!sessionJobs.length) return;
    const ok = await confirmAction({
      title: `Undo all ${sessionJobs.length} job number${sessionJobs.length === 1 ? "" : "s"}?`,
      message: "Every job number activated in this session will be removed from Job Book.",
      confirmLabel: "Undo all",
      danger: true,
    });
    if (!ok) return;
    const ids = sessionJobs.map(j => j.id);
    setUndoingId("__bulk__");
    const { error } = await supabase.from("jobs").delete().in("id", ids);
    setUndoingId(null);
    if (error) { notify("Couldn't undo all: " + error.message, "error"); return; }
    const gone = new Set(ids);
    setFilmJobs(prev => prev.filter(j => !gone.has(j.id)));
    setSessionJobs([]);
  };

  // Save edits from the review detail modal back to the jobs row, then refresh
  // it in both the session list and the film's job list so the UI reflects it.
  const handleReviewSave = async (form) => {
    if (!reviewJob?.id) return;
    setReviewSaving(true);
    const payload = {
      ...form,
      start_date: form.start_date || null,
      completed_date: form.completed_date || null,
      fixed_cost: form.fixed_cost === "" ? null : parseFloat(form.fixed_cost),
      third_party_cost: form.third_party_cost === "" ? null : parseFloat(form.third_party_cost),
      estimated_cost: form.estimated_cost === "" ? null : parseFloat(form.estimated_cost),
    };
    const { data, error } = await supabase.from("jobs").update(payload).eq("id", reviewJob.id).select().single();
    setReviewSaving(false);
    if (error) { notify("Couldn't save: " + error.message, "error"); return; }
    setSessionJobs(prev => prev.map(j => j.id === data.id ? data : j));
    setFilmJobs(prev => prev.map(j => j.id === data.id ? data : j));
    setReviewJob(null);
  };

  // Collapsed folder paths, per tree (empty = all expanded). The template preview
  // and the film's own folders are two separate panels now, so they fold apart.
  const [collapsed, setCollapsed] = useState(() => ({ template: new Set(), film: new Set() }));
  const toggleCollapse = (mode, path) => setCollapsed((prev) => {
    const next = new Set(prev[mode]);
    next.has(path) ? next.delete(path) : next.add(path);
    return { ...prev, [mode]: next };
  });
  // Every container-folder path EXCEPT the root — collapsing these leaves the top
  // level (the folders right under the film) visible with their sections folded.
  const allContainerPaths = (node, path = "0", depth = 0, acc = []) => {
    if (node?.children?.length) {
      if (depth > 0) acc.push(path);
      node.children.forEach((c, i) => allContainerPaths(c, `${path}-${i}`, depth + 1, acc));
    }
    return acc;
  };

  // Recursive tree renderer, in two modes.
  //
  //   "template" — the studio's master template. Every JOBNUMBER_ leaf is a
  //     permanently clickable action: clicking it stages a job of that type.
  //     Nothing here is ever "used up", so a slot can be run as many times as
  //     the campaign needs.
  //   "film" — the picked film's own live folders. Read-only: slots already
  //     carrying an XY code are badged, and the staged draft appears inline as
  //     a green NEW JOB preview of the folder that's about to exist.
  //
  // Uses a path-based key since live Wrike data can have repeated folder names
  // across branches. Container folders collapse.
  const renderTree = (node, mode, depth = 0, path = "0", ancestors = []) => {
    const isTpl = mode === "template";
    const isSlot = !!node.jobNumber;
    const leafDesc = isSlot ? (node.description || node.label.replace(/^(JOBNUMBER|XY\d+)_?/i, "").replace(/_/g, " ").trim() || "General") : null;
    const slotJobsHere = isSlot ? jobsBySlot[slotSuffix(node.label)] : null;
    const done = isSlot && !isTpl && (node.allocated || slotJobsHere?.length);
    const clickable = isTpl && isSlot && !allocatingDraft;
    const isDraftNode = !!node.__draft;

    const hasChildren = node.children?.length > 0;
    // A search override keeps folders on a match path open regardless of collapse.
    const isCollapsed = collapsed[mode].has(path) && !(isTpl && searchExpand.has(path));
    const isMatch = isTpl && nodeMatches(node);

    return (
      <div key={path}>
        <div
          onClick={clickable
            ? () => activateSlot({ label: node.label, id: node.id, description: leafDesc, path: ancestors })
            : hasChildren ? () => toggleCollapse(mode, path) : undefined}
          className={`flex items-center gap-1.5 py-1 ${(clickable || hasChildren) ? "cursor-pointer hover:bg-[#12a0e1]/5 rounded-lg -mx-1 px-1" : ""}`}
          style={{ paddingLeft: depth * 18 }}>
          {hasChildren
            ? <ChevronRight className={`w-3 h-3 text-[#768994] shrink-0 transition-transform ${isCollapsed ? "" : "rotate-90"}`} />
            : <span className="w-3 shrink-0" />}
          {hasChildren
            ? (isCollapsed
                ? <Folder className="w-3.5 h-3.5 text-[#f4b740] shrink-0" />
                : <FolderOpen className="w-3.5 h-3.5 text-[#f4b740] shrink-0" />)
            : <Folder className={`w-3.5 h-3.5 shrink-0 ${isDraftNode ? "text-[#10b981]" : isSlot && !done ? "text-[#12a0e1]" : "text-[#b0bec5]"}`} />}
          <span className={`text-[12px] ${isMatch ? "bg-[#f4b740]/40 rounded px-1" : ""} ${
            isDraftNode ? "font-mono font-bold text-[#10b981]"
            : done ? "font-mono font-bold text-[#12a0e1]"
            : isSlot ? "text-[#122027] font-bold"
            : "text-[#122027]"}`}>
            {node.label}
          </span>
          {hasChildren && <span className="text-[10px] text-[#768994] font-bold shrink-0">{node.children.length}</span>}
          {clickable && (
            <span className="text-[9px] font-black uppercase tracking-wider text-[#12a0e1] bg-[#12a0e1]/10 px-1.5 py-0.5 rounded ml-1">Click to activate</span>
          )}
          {isDraftNode && (
            <span className="text-[9px] font-black uppercase tracking-wider text-[#10b981] bg-[#10b981]/10 px-1.5 py-0.5 rounded ml-1">New job</span>
          )}
          {done && (
            <span className="text-[9px] font-black uppercase tracking-wider text-[#1cc1a5] bg-[#1cc1a5]/10 px-1.5 py-0.5 rounded ml-1">
              Allocated{slotJobsHere?.length > 1 ? ` ×${slotJobsHere.length}` : ""}
            </span>
          )}
        </div>
        {hasChildren && !isCollapsed && node.children.map((c, i) =>
          renderTree(c, mode, depth + 1, `${path}-${i}`, [...ancestors, node.label]))}
      </div>
    );
  };

  const hasTemplate = !!(fetchedTemplate || FOLDER_TEMPLATES[studio]);
  // The studio template is now shown in its own right, always — it's the menu of
  // actions, not a stand-in for a film with no folders yet.
  const templateTree = fetchedTemplate || (hasTemplate ? FOLDER_TEMPLATES[studio] : null);
  // The film's own live folders. Only present once a film with real slot folders
  // is picked; until then there's nothing truthful to show below the template.
  const filmDriven = !!(filmView && filmView.hasSlots);
  const filmTree = filmDriven ? filmView.tree : null;
  const templateLeaves = templateTree ? collectJobLeaves(templateTree) : [];
  const filmLeaves = filmTree ? collectJobLeaves(filmTree) : [];
  // "Allocated" = already numbered in Wrike, or carrying a Job Book row we made.
  const activatedCount = filmLeaves.filter(l => l.allocated || jobsBySlot[slotSuffix(l.label)]?.length).length;

  // Search over the template tree — highlights matching nodes and auto-expands
  // the folders on the path to any match. A 30-slot template is a lot to scroll.
  const [slotQuery, setSlotQuery] = useState("");
  const nodeMatches = (n) => {
    const q = slotQuery.trim().toLowerCase();
    if (!q) return false;
    const desc = n.description || (n.label || "").replace(/^JOBNUMBER_?/i, "").replace(/_/g, " ");
    return (n.label || "").toLowerCase().includes(q) || desc.toLowerCase().includes(q);
  };
  const searchExpand = useMemo(() => {
    const set = new Set();
    const q = slotQuery.trim().toLowerCase();
    if (!q || !templateTree) return set;
    const matches = (n) => {
      const desc = n.description || (n.label || "").replace(/^JOBNUMBER_?/i, "").replace(/_/g, " ");
      return (n.label || "").toLowerCase().includes(q) || desc.toLowerCase().includes(q);
    };
    const walk = (n, path) => {
      let has = matches(n);
      (n.children || []).forEach((c, i) => { if (walk(c, `${path}-${i}`)) has = true; });
      if (has && n.children?.length) set.add(path);
      return has;
    };
    walk(templateTree, "0");
    return set;
  }, [templateTree, slotQuery]);

  // The film's tree with the staged draft grafted in as a preview of the folder
  // the job will occupy. The film project is a duplicate of the studio template,
  // so the draft's template path maps onto it folder-for-folder — walk that path
  // (ignoring the differing roots, and any XY prefix Wrike has already applied)
  // and drop the node in beside its siblings. If the film's copy has diverged and
  // the path doesn't resolve, the preview lands at the root rather than vanishing.
  const filmTreeWithDraft = useMemo(() => {
    if (!filmTree) return null;
    if (!draft) return filmTree;
    const preview = {
      label: `${draft.code}_${draft.description.replace(/\s+/g, "_")}`,
      jobNumber: true,
      __draft: true,
    };
    const norm = (s) => slotSuffix(s || "").replace(/[_\s]+/g, " ").trim().toLowerCase();
    const graft = (node, rest) => {
      if (!rest.length) return { ...node, children: [...(node.children || []), preview] };
      const [head, ...tail] = rest;
      const idx = (node.children || []).findIndex(c => norm(c.label) === norm(head));
      if (idx === -1) return { ...node, children: [...(node.children || []), preview] };
      const children = [...node.children];
      children[idx] = graft(children[idx], tail);
      return { ...node, children };
    };
    // draft.path[0] is the template root, which the film tree replaces with the
    // film project itself — so skip it and match from the level below.
    return graft(filmTree, draft.path.slice(1));
  }, [filmTree, draft]);

  // A film's live tree is a wall of folders — dozens of leaves across several
  // branches — so the green NEW JOB preview grafted into it is easy to lose.
  // Staging a slot folds the tree down to just the branch the new job lands in;
  // discarding the draft opens it back up. Manual toggling still works from
  // there, this only sets the starting state each time the draft changes.
  useEffect(() => {
    if (!filmTreeWithDraft) return;
    if (!draft) { setCollapsed(c => ({ ...c, film: new Set() })); return; }
    // Paths of every container on the way down to the draft node — the only
    // ones that stay open.
    const onDraftPath = new Set();
    const walk = (node, path = "0") => {
      if (node.__draft) return true;
      let found = false;
      (node.children || []).forEach((c, i) => { if (walk(c, `${path}-${i}`)) found = true; });
      if (found) onDraftPath.add(path);
      return found;
    };
    walk(filmTreeWithDraft);
    setCollapsed(c => ({
      ...c,
      film: new Set(allContainerPaths(filmTreeWithDraft).filter(p => !onDraftPath.has(p))),
    }));
  }, [draft, filmTreeWithDraft]);

  // ── Job Book ↔ Wrike reconciliation ──────────────────────────────────────
  // Every folder in the film's live subtree, by id, so we can look up the exact
  // folder a job was pushed to and see whether it still carries that job's code.
  const liveByFolderId = useMemo(() => {
    const out = {};
    const walk = (n) => { if (n?.id) out[n.id] = n; (n?.children || []).forEach(walk); };
    if (filmView?.tree) walk(filmView.tree);
    return out;
  }, [filmView]);

  // Activated jobs whose Wrike folder no longer matches them. We ONLY consider
  // jobs that were actually pushed (wrike_folder_id set) — a job without one was
  // never pushed and is just pending, not a mismatch. A pushed job is stale if
  // its folder was renamed off its code (e.g. reverted to JOBNUMBER_…) or the
  // folder is gone. This is the source-of-truth check: Wrike is the truth, and
  // when Job Book disagrees we offer to un-allocate.
  const jobMismatches = useMemo(() => {
    if (!filmView?.filmProject) return [];
    const out = [];
    filmJobs.forEach((job) => {
      if (!job.wrike_folder_id) return; // never pushed → pending, not stale
      const code = (job.job_number?.match(/XY\d+/) || [])[0];
      if (!code) return;
      const live = liveByFolderId[job.wrike_folder_id];
      if (!live) out.push({ job, code, reason: "deleted" });
      else if (!new RegExp(`^${code}_`, "i").test(live.label || ""))
        out.push({ job, code, reason: "renamed", liveLabel: live.label });
    });
    return out;
  }, [filmJobs, liveByFolderId, filmView]);

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-4">
        {JOBS_SETUP_TABS.map(t => {
          const Icon = t.icon;
          const active = innerTab === t.id;
          return (
            <button key={t.id} onClick={() => setInnerTab(t.id)}
              className={`flex items-center gap-3 text-left rounded-2xl p-3.5 border-2 transition-[background-color,border-color,box-shadow] ease-[cubic-bezier(0.16,1,0.3,1)] ${
                active
                  ? "border-[#12a0e1] bg-[#12a0e1]/5 shadow-md"
                  : "border-[#dce4ec] bg-white hover:border-slate-300 hover:shadow-sm"
              }`}>
              <div className={`w-9 h-9 rounded-xl bg-gradient-to-br ${t.color} flex items-center justify-center shadow-sm shrink-0`}>
                <Icon className="w-4 h-4 text-white" />
              </div>
              <p className="text-sm font-black text-[#122027] flex-1 min-w-0">{t.label}</p>
              {active && (
                <div className="w-5 h-5 rounded-full bg-[#12a0e1] flex items-center justify-center shrink-0">
                  <Check className="w-3 h-3 text-white" />
                </div>
              )}
            </button>
          );
        })}
      </div>

      {innerTab === "campaign" && (
    <div className="flex flex-col gap-5">
      {!lockPickers && (
      <div className="bg-[#f8fafc] border border-[#dce4ec] rounded-2xl p-4">
        <p className="text-xs text-[#768994] leading-relaxed">
          Pick a studio and its template loads automatically. In the folder preview,
          <span className="font-bold text-[#122027]"> click a slot to activate it</span> — that stages a job
          number and opens the form below, pre-filled. Nothing reaches Job Book until you press Create Job.
          A slot never gets used up, so run the same one as many times as the campaign needs. Everything you
          create this session collects in <span className="font-bold text-[#122027]">Review</span> at the bottom.
        </p>
      </div>
      )}

      {!lockPickers && (
      <div>
        <label className="block text-[10px] font-black uppercase tracking-widest text-[#768994] mb-1.5">Template</label>
        <div className="flex items-center gap-2 flex-wrap">
          {STUDIO_OPTIONS.map(s => {
            const available = TESTABLE_STUDIOS.has(s);
            return (
              <button key={s} disabled={!available}
                onClick={() => setStudio(s)}
                className={`px-3 py-2 rounded-xl text-xs font-bold border transition-[background-color,border-color,color] ease-[cubic-bezier(0.16,1,0.3,1)] ${
                  studio === s
                    ? "bg-[#122027] text-white border-[#122027]"
                    : available
                      ? "bg-white text-[#122027] border-[#dce4ec] hover:border-[#12a0e1]"
                      : "bg-slate-50 text-slate-300 border-slate-100 cursor-not-allowed"
                }`}>
                {s}{!available && " (soon)"}
              </button>
            );
          })}
          {/* Auto-fetch status + a small manual re-sync (force-refresh past the cache). */}
          {fetchingTemplate ? (
            <span className="flex items-center gap-1.5 text-xs font-bold text-[#768994] ml-1">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading {studio} template…
            </span>
          ) : fetchInfo?.error ? (
            <span className="flex items-center gap-2 ml-1">
              <span className="text-xs font-bold text-red-500">{fetchInfo.error}</span>
              <button onClick={resync}
                className="text-[#12a0e1] hover:underline text-xs font-bold">Retry</button>
            </span>
          ) : fetchInfo ? (
            <span className="flex items-center gap-2 ml-1">
              <button onClick={resync}
                title={`Loaded “${fetchInfo.rootLabel}” — re-sync from Wrike`}
                className="flex items-center gap-1 text-[#768994] hover:text-[#12a0e1] text-xs font-bold transition-colors">
                <RefreshCw className="w-3 h-3" /> Re-sync
              </button>
            </span>
          ) : null}
        </div>
      </div>
      )}

      {/* Folder preview — the studio's master template, straight from Wrike. Every
          JOBNUMBER_ folder in here is an action, and stays one however many times
          it's been used: activating a slot never consumes it. */}
      {templateTree && (
        <div className={`border border-[#dce4ec] rounded-2xl flex flex-col ${lockPickers ? "max-h-[38vh] min-h-[220px]" : "max-h-[52vh] min-h-[300px]"}`}>
          <div className="flex items-center gap-2 px-4 pt-4 pb-2 border-b border-[#f0f4f8] shrink-0">
            <p className="text-[10px] font-black uppercase tracking-widest text-[#768994] shrink-0">
              Folder Preview{fetchedTemplate ? " \u00b7 live from Wrike" : ""}
            </p>
            <div className="relative flex-1 max-w-[220px] ml-auto">
              <Search className="w-3.5 h-3.5 text-[#b0bec5] absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input value={slotQuery} onChange={(e) => setSlotQuery(e.target.value)}
                placeholder="Search slots…"
                className="w-full pl-8 pr-2 py-1.5 text-[11px] bg-white border border-[#dce4ec] rounded-lg outline-none focus:border-[#12a0e1] transition-colors" />
            </div>
            <button type="button"
              onClick={() => setCollapsed(c => ({ ...c, template: c.template.size ? new Set() : new Set(allContainerPaths(templateTree)) }))}
              className="text-[10px] font-bold text-[#768994] hover:text-[#12a0e1] transition-colors shrink-0">
              {collapsed.template.size ? "Expand all" : "Collapse all"}
            </button>
          </div>
          <div className="px-4 py-2 overflow-y-auto">
            {renderTree(templateTree, "template")}
          </div>
          <p className="px-4 pb-3 pt-1 text-[10px] text-[#768994] shrink-0">
            {templateLeaves.length} job slot{templateLeaves.length === 1 ? "" : "s"} · click one to activate another job of that type.
          </p>
        </div>
      )}

      {!lockPickers && (
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="block text-[10px] font-black uppercase tracking-widest text-[#768994]">Film</label>
          <button onClick={() => {
              window.location.hash = "management/films";
            }}
            title="Open the Films page (in Administration) to add or sync films"
            className="flex items-center gap-1.5 text-[11px] font-bold text-[#12a0e1] hover:text-[#0d8bc4] transition-colors">
            <Film className="w-3 h-3" /> Manage films
          </button>
        </div>
        <StrictSelect value={filmTitle} onChange={v => setFilmTitle(v)}
          options={filmOptions} placeholder="Select a film…" loading={filmsLoading}
          groupBy={filmGroup} groupOrder={FILM_GROUP_ORDER} />
        {!filmsLoading && films.length === 0 && (
          <p className="text-xs text-[#768994] mt-1.5">
            No films yet — <button onClick={() => setShowFilmSync(true)} className="text-[#1cc1a5] font-bold hover:underline">sync them from Wrike</button>{" "}
            or add one on the{" "}
            <button onClick={() => { window.location.hash = "management/films"; }}
              className="text-[#12a0e1] font-bold hover:underline">Films</button> page.
          </p>
        )}
      </div>
      )}

      {activateError && (
        <p className="text-xs font-bold text-red-500">{activateError}</p>
      )}

      {filmTitle.trim() && (
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-xs font-bold text-[#768994]">
            {filmDriven
              ? `${activatedCount} / ${filmLeaves.length} job number${filmLeaves.length === 1 ? "" : "s"} already allocated for “${filmTitle}”`
              : `No job folders in Wrike yet for “${filmTitle}” — activating a slot still allocates its number and files the job.`}
          </span>
          {(loadingSlots || filmViewLoading) && <Loader2 className="w-3.5 h-3.5 animate-spin text-[#768994]" />}
          {/* Territory swap — this film is shared into more than one studio folder. */}
          {filmView?.territories?.length > 1 && (
            <label className="flex items-center gap-1.5 text-[11px] font-bold text-[#768994]">
              <Globe className="w-3 h-3 text-[#12a0e1]" />
              <select
                value={filmView.studioFolder?.id || ""}
                onChange={(e) => {
                  const t = filmView.territories.find((x) => x.studioFolder.id === e.target.value);
                  if (!t) return;
                  setTerritoryId(t.studioFolder.id);
                  setStudio(t.studio);
                }}
                className="text-[11px] font-bold text-[#33454f] bg-white border border-[#dce4ec] rounded-lg px-2 py-1 outline-none focus:border-[#12a0e1] cursor-pointer">
                {filmView.territories.map((t) => (
                  <option key={t.studioFolder.id} value={t.studioFolder.id}>{t.studio}</option>
                ))}
              </select>
            </label>
          )}
          {!filmViewLoading && (
            <button onClick={refreshFilmView}
              title="Re-read this film's folders from Wrike (reflects renames done in Wrike)"
              className="flex items-center gap-1 text-[11px] font-bold text-[#768994] hover:text-[#12a0e1] transition-colors">
              <RefreshCw className="w-3 h-3" /> Refresh from Wrike
            </button>
          )}
        </div>
      )}

      {/* Source-of-truth reconciliation: Job Book numbers whose Wrike folder
          no longer carries them (renamed off their code, or deleted). Wrike is
          the truth — offer to clear the stale Job Book entry. */}
      {jobMismatches.length > 0 && (
        <div className="border border-[#f4b740]/40 bg-[#f4b740]/10 rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-[#f4b740]/30">
            <p className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-[#8a6d1a]">
              <AlertTriangle className="w-4 h-4" />
              {jobMismatches.length} job number{jobMismatches.length === 1 ? "" : "s"} out of step with Wrike
            </p>
          </div>
          <div className="divide-y divide-[#f4b740]/20">
            {jobMismatches.map(({ job, code, reason, liveLabel }) => (
              <div key={job.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="font-mono font-bold text-[#8a6d1a] text-xs shrink-0">{code}</span>
                <span className="text-[11px] text-[#122027] flex-1 min-w-0 truncate">
                  {job.project_description}
                  <span className="text-[#8a6d1a] italic ml-1.5">
                    — {reason === "deleted"
                      ? "its Wrike folder was deleted"
                      : `its Wrike folder was renamed to “${liveLabel}”`}
                  </span>
                </span>
                <button onClick={() => undoActivation(job)} disabled={undoingId === job.id}
                  className="flex items-center gap-1.5 text-[11px] font-bold text-rose-600 hover:text-rose-700 disabled:opacity-40 shrink-0 transition-colors">
                  {undoingId === job.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Undo2 className="w-3 h-3" />}
                  Un-allocate
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* The film's own folders, live from Wrike — what actually exists today,
          with the staged job shown in place as the folder it's about to become. */}
      {filmTreeWithDraft && (
        <div className={`border border-[#dce4ec] rounded-2xl flex flex-col ${lockPickers ? "max-h-[38vh] min-h-[200px]" : "max-h-[52vh] min-h-[260px]"}`}>
          <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-2 border-b border-[#f0f4f8] shrink-0">
            <p className="text-[10px] font-black uppercase tracking-widest text-[#768994]">
              Film Folders · live from Wrike
            </p>
            <button type="button"
              onClick={() => setCollapsed(c => ({ ...c, film: c.film.size ? new Set() : new Set(allContainerPaths(filmTreeWithDraft)) }))}
              className="text-[10px] font-bold text-[#768994] hover:text-[#12a0e1] transition-colors shrink-0">
              {collapsed.film.size ? "Expand all" : "Collapse all"}
            </button>
          </div>
          <div className="px-4 py-2 overflow-y-auto">
            {renderTree(filmTreeWithDraft, "film")}
          </div>
        </div>
      )}

      {/* The staged job. Everything below is pre-filled from the slot that was
          clicked plus the studio it sits under; nothing is written until Create
          Job. Remounting on a new draft (or a film change) reloads the defaults. */}
      <div ref={draftRef}>
        {draft ? (
          <div className="border-2 border-[#10b981]/40 rounded-2xl overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-4 py-3 bg-[#10b981]/5 border-b border-[#10b981]/20">
              <p className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-[#0d9488] min-w-0">
                <FolderPlus className="w-4 h-4 shrink-0" />
                <span className="truncate">New job · {draft.description}</span>
              </p>
              <button onClick={() => setDraft(null)}
                className="flex items-center gap-1 text-[11px] font-bold text-[#768994] hover:text-rose-500 shrink-0 transition-colors">
                <X className="w-3 h-3" /> Discard
              </button>
            </div>
            <div className="px-5 py-5">
              <JobForm
                key={`${draft.slotLabel}|${draft.code}|${filmTitle}`}
                job={{
                  film_title: filmTitle.trim(),
                  client: STUDIO_CLIENT[studio] || "",
                  project_description: draft.description,
                  // Prefilled from the slot folder's Item Price when it has
                  // one; left blank when it doesn't.
                  fixed_cost: draft.itemPrice ?? "",
                }}
                presetCode={draft.code}
                clients={clients} films={films} workCategories={workCategories} descs={descs}
                onSave={createDraftJob} saving={creatingJob}
                submitLabel="Create Job" layout="inline" />
            </div>
          </div>
        ) : templateTree ? (
          <p className="text-xs text-[#768994] italic">
            Click a slot in the folder preview above to start a job.
          </p>
        ) : null}
      </div>

      {/* Nothing sits here any more. "Push to Wrike" went when Create Job took
          over opening the push confirmation, and "View in Job Book" went with
          it: by the time a job reaches the Book it has already been through
          the push, so there was never a moment where jumping to the Book told
          you something the flow above hadn't. */}

      {/* Req 8 — Review: everything activated this session, each openable to fill
          in costs/billing (autofilled where we can) or undo. Shows across films. */}
      {sessionJobs.length > 0 && (
        <div className="border border-[#dce4ec] rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-4 py-3 bg-[#f8fafc] border-b border-[#dce4ec]">
            <p className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-[#122027]">
              <ListChecks className="w-4 h-4 text-[#12a0e1]" />
              Review · {sessionJobs.length} activated this session
            </p>
            <button onClick={undoAllSession} disabled={undoingId === "__bulk__"}
              className="flex items-center gap-1.5 text-[11px] font-bold text-rose-500 hover:text-rose-600 disabled:opacity-40 transition-colors">
              {undoingId === "__bulk__" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Undo2 className="w-3 h-3" />}
              Undo all
            </button>
          </div>
          <div className="divide-y divide-[#f0f4f8] max-h-[300px] overflow-y-auto">
            {sessionJobs.map(j => {
              const code = j.job_number?.match(/XY\d+/)?.[0];
              const hasBilling = j.fixed_cost != null || j.estimated_cost != null || j.third_party_cost != null || j.billed_to;
              return (
                <div key={j.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50/60 transition-colors">
                  <span className="font-mono font-bold text-[#12a0e1] text-xs shrink-0">{code}</span>
                  <span className="text-xs text-[#122027] truncate flex-1 min-w-0">
                    <span className="italic text-[#768994]">{j.film_title}</span>
                    {j.project_description ? ` · ${j.project_description}` : ""}
                  </span>
                  {hasBilling ? (
                    <span className="text-[9px] font-black uppercase tracking-wider text-[#1cc1a5] bg-[#1cc1a5]/10 px-2 py-0.5 rounded-full shrink-0">Details added</span>
                  ) : (
                    <span className="text-[9px] font-black uppercase tracking-wider text-[#f4b740] bg-[#f4b740]/10 px-2 py-0.5 rounded-full shrink-0">Needs details</span>
                  )}
                  <button onClick={() => setReviewJob(j)}
                    className="flex items-center gap-1 text-[11px] font-bold text-[#12a0e1] hover:text-[#0d8bc4] shrink-0 transition-colors">
                    <Eye className="w-3.5 h-3.5" /> Details
                  </button>
                  <button onClick={() => undoActivation(j)} disabled={undoingId === j.id}
                    title="Undo this activation"
                    className="p-1 rounded-lg text-slate-300 hover:text-rose-500 hover:bg-rose-50 shrink-0 transition-colors disabled:opacity-40">
                    {undoingId === j.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Undo2 className="w-3.5 h-3.5" />}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
      )}

      {reviewJob && (
        <JobModal
          job={reviewJob}
          clients={clients} films={films} workCategories={workCategories} descs={descs}
          onSave={handleReviewSave} onClose={() => setReviewJob(null)} saving={reviewSaving}
        />
      )}

      {showFilmSync && (
        <FilmSyncModal studio={studio} existingFilms={films}
          onClose={() => setShowFilmSync(false)} onApplied={loadFilms} />
      )}

      {/* Only what this session activated for the film on screen. Passing the
          film's whole job list dragged in codes from earlier attempts, which
          then showed up as stale rows in the push preview. Still film-scoped
          as well as session-scoped — the session list spans films, and a push
          targets one film's Wrike project. */}
      {pushMode && (
        <PushToWrikeModal
          studio={studio} filmTitle={filmTitle.trim()}
          jobs={sessionJobs.filter(j => (j.film_title || "").trim() === filmTitle.trim())}
          mode={pushMode}
          onClose={() => setPushMode(null)} />
      )}

      {innerTab === "custom" && (
        <div>
          {customCreated == null ? (
            <JobForm job={filmTitle.trim() ? { film_title: filmTitle.trim() } : undefined}
              clients={clients} films={films} workCategories={workCategories} descs={descs}
              onSave={handleCreateCustomJob} saving={customSaving} submitLabel="Create Job" layout="inline" />
          ) : (
            <div className="flex items-center gap-3 py-4">
              <span className="flex items-center gap-2 px-4 py-2.5 bg-[#1cc1a5]/10 text-[#1cc1a5] text-sm font-bold rounded-2xl">
                <CheckCircle2 className="w-3.5 h-3.5" /> Created {customCreated} in Job Book
              </span>
              <button onClick={() => setActiveTab?.("jobs")}
                className="px-4 py-2.5 bg-[#122027] hover:bg-[#1a2e38] text-white text-sm font-bold rounded-xl transition-[background-color] ease-[cubic-bezier(0.16,1,0.3,1)]">
                View in Job Book
              </button>
              <button onClick={() => setCustomCreated(null)}
                className="px-4 py-2.5 bg-white border border-[#dce4ec] hover:border-[#12a0e1] text-[#122027] text-sm font-bold rounded-xl transition-[border-color] ease-[cubic-bezier(0.16,1,0.3,1)]">
                Add Another Job
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
