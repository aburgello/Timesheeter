import { scanStudioJobNumbers } from "../src/lib/wrikeCampaign.js";

// scanStudioJobNumbers only touches the outside world through fetch, so a
// synthetic folder tree is enough to drive the whole thing.
//
// The tree puts ONE code on two folders — a live one under SONY › Focker
// In-Law, and an archived copy under _Archive — and returns the ARCHIVED one
// first. That ordering is the whole point: byId is keyed by folder id, those
// ids are non-numeric strings, so JS iterates them in insertion order, which is
// just the order Wrike's API happened to return. The old dedup took the first
// folder per code and skipped the rest, so this ordering made the job come back
// archived, film-less, and hidden from the scan's default Active-only view.
function stubWrike(folders) {
  globalThis.fetch = async (url) => {
    // The createdDate top-up: /folders/<id>,<id>. Nothing to add.
    if (/\/folders\/[^?]/.test(url)) {
      return { ok: true, json: async () => ({ data: [] }) };
    }
    // The flat tree: /folders?fields=[childIds]
    return { ok: true, json: async () => ({ data: folders, nextPageToken: null }) };
  };
}

const F = (id, title, childIds = []) => ({ id, title, childIds, scope: "WsFolder" });

// ── archived copy listed FIRST, live copy second ────────────────────────────
{
  stubWrike([
    F("arch_root", "_Archive", ["arch_job"]),
    F("arch_job", "XY025716_Germany_Launch_Assets"),      // ← enumerated first
    F("sony", "SONY", ["film"]),
    F("film", "Focker_In-Law", ["live_job"]),
    F("live_job", "XY025716_Germany_Launch_Assets"),      // ← the real one
  ]);
  const out = await scanStudioJobNumbers();
  const row = out.find((r) => r.code === "XY025716");

  check("one row per code, still", out.filter((r) => r.code === "XY025716").length, 1);
  check("the LIVE folder wins, not the first-listed archive", row?.archived, false);
  check("and it carries the real film", row?.filmTitle, "Focker In-Law");
  check("and the real client", row?.client, "Sony Pictures International");
  check("the clash is reported, not hidden", out.contestedCodes?.length, 1);
  check("reporting names the code", out.contestedCodes?.[0]?.code, "XY025716");
}

// ── same tree, opposite order — the answer must not change ──────────────────
{
  stubWrike([
    F("sony", "SONY", ["film"]),
    F("film", "Focker_In-Law", ["live_job"]),
    F("live_job", "XY025716_Germany_Launch_Assets"),      // ← live first this time
    F("arch_root", "_Archive", ["arch_job"]),
    F("arch_job", "XY025716_Germany_Launch_Assets"),
  ]);
  const out = await scanStudioJobNumbers();
  const row = out.find((r) => r.code === "XY025716");
  check("order-independent: still live", row?.archived, false);
  check("order-independent: still the real film", row?.filmTitle, "Focker In-Law");
}

// ── a genuinely archived-only job is still reported archived ────────────────
{
  stubWrike([
    F("arch_root", "_Archive", ["arch_job"]),
    F("arch_job", "XY025999_Old_Campaign"),
  ]);
  const out = await scanStudioJobNumbers();
  check("no live copy → still archived", out.find((r) => r.code === "XY025999")?.archived, true);
  check("and nothing is reported as contested", out.contestedCodes?.length, 0);
}

// ── two live folders under different studios: unresolvable, so surfaced ─────
{
  stubWrike([
    F("sony", "SONY", ["sfilm"]),
    F("sfilm", "Film_A", ["job_a"]),
    F("job_a", "XY026000_Assets"),
    F("para", "PARAMOUNT", ["pfilm"]),
    F("pfilm", "Film_B", ["job_b"]),
    F("job_b", "XY026000_Assets"),
  ]);
  const out = await scanStudioJobNumbers();
  check("still one row", out.filter((r) => r.code === "XY026000").length, 1);
  check("the genuine clash is surfaced", out.contestedCodes?.length, 1);
  check("with the rejected path listed", out.contestedCodes?.[0]?.over?.length, 1);
}

// ── an organisational folder must not become a film ─────────────────────────
//
// The real shape under Universal - New Media, from the live tree:
//
//   Universal - New Media
//     └── _Old              ← a container for retired work, not a campaign
//          ├── 2024
//          │    ├── Wicked
//          │    ├── The Brutalist
//          │    ├── Nosferatu
//          │    └── Wolf Man
//          └── 2025
//
// describeChain takes the child-of-studio as the film and knew only how to skip
// YEAR folders, so it stopped at "_Old" — which deUnderscore renders as "Old".
// 47 Job Book rows, spread across all of these films, collapsed onto one film
// called "Old". The studio marks containers with a leading underscore (665 such
// folders in the tree, not one of them a film title), so the film loop skips
// them the same way it skips years.
{
  stubWrike([
    F("nm", "Universal - New Media", ["old"]),
    F("old", "_Old", ["y2024"]),
    F("y2024", "2024", ["wicked", "brutalist"]),
    F("wicked", "Wicked", ["job_a"]),
    F("job_a", "XY025042_NM_Packshots_FinalWindow"),
    F("brutalist", "The_Brutalist", ["job_b"]),
    F("job_b", "XY025119_Packshots_FinalWindow"),
  ]);
  const out = await scanStudioJobNumbers();
  const a = out.find((r) => r.code === "XY025042");
  const b = out.find((r) => r.code === "XY025119");

  check("the real film wins, not the _Old container", a?.filmTitle, "Wicked");
  check("two jobs under one container get their OWN films", b?.filmTitle, "The Brutalist");
  check("neither is called Old", [a?.filmTitle, b?.filmTitle].includes("Old"), false);
  // Lowercase "media" is the real region label, in REGION_ALIASES and in the
  // Job Book's own rows — asserted as-is rather than tidied, so this test keeps
  // agreeing with production.
  check("the studio still resolves through the container", a?.client, "Universal Pictures New media");
}

// ── a job with nothing but a container above it keeps that name ─────────────
//
// The house jobs have no film folder to find, so the child-of-studio fallback
// has to survive the new skip — otherwise they'd come back film-less.
{
  stubWrike([
    F("uni", "Universal", ["hk"]),
    F("hk", "_Universal_House_Keeping", ["job_c"]),
    F("job_c", "XY024840_UK_QA_Holding_Slides"),
  ]);
  const out = await scanStudioJobNumbers();
  check("a house job still names itself rather than coming back empty",
    out.find((r) => r.code === "XY024840")?.filmTitle, "Universal House Keeping");
}

// ── the medium is not a film either ─────────────────────────────────────────
//
// Found by measuring the org-folder skip against the real tree, not by reading
// the code: "UNIVERSAL › _Universal House Job › Digital › <job>" skipped the
// container and landed on "Digital", so seven job folders came back with the
// film "Digital" or "Print" — strictly worse than the "Universal House Job"
// they had before. Skipping the medium as well sends them to the
// child-of-studio fallback, which is where they started.
{
  stubWrike([
    F("uni", "UNIVERSAL", ["hj"]),
    F("hj", "_Universal House Job", ["dig"]),
    F("dig", "Digital", ["job_d"]),
    F("job_d", "XY024900_Holding_Slides"),
  ]);
  const out = await scanStudioJobNumbers();
  check("a house job does not acquire the film 'Digital'",
    out.find((r) => r.code === "XY024900")?.filmTitle, "Universal House Job");
}

// ...but a medium sitting between a REAL film and the job must not hide it.
{
  stubWrike([
    F("uni", "UNIVERSAL", ["y"]),
    F("y", "2026", ["film"]),
    F("film", "Wicked_For_Good", ["dig"]),
    F("dig", "PRINT", ["job_e"]),
    F("job_e", "XY024901_1Sheet"),
  ]);
  const out = await scanStudioJobNumbers();
  check("a real film below a year and above a medium still wins",
    out.find((r) => r.code === "XY024901")?.filmTitle, "Wicked For Good");
}
