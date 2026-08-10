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
