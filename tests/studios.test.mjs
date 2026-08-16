import { studioKeywordOf, studioNameOf, STUDIO_CLIENT, STUDIO_KEYWORDS_FLAT } from "../src/lib/studios.js";
import { getStudioName, getFilmName, buildChildToParents, hydrateMissingFolders } from "../src/lib/wrikeEnrich.js";

const F = (id, title, childIds = []) => ({ id, title, childIds });
const dict = (...fs) => Object.fromEntries(fs.map((f) => [f.id, f]));

// ── the underscore trap ─────────────────────────────────────────────────────
//
// Wrike joins words with underscores, and in a regex `_` is a WORD character.
// So /\buniversal\b/ does NOT match "Universal_UK_Archive" — a plain
// word-boundary test fails to recognise a dozen real studio folders in this
// account. Substring matching found them, but also matched "Portfolio Mgmt" as
// MGM and "MWB_INTL__Digital_1Sheets_UK" as Warner. Replacing separators first
// and THEN matching on boundaries is the only rule that gets both right.
{
  const real = [
    ["Universal_UK_Archive", "Universal"],
    ["Universal_INTL_Archive", "Universal"],
    ["_Universal_MASTER", "Universal"],
    ["_Paramount_MASTER_TEMPLATES", "Paramount"],
    ["Paramount_Production_View", "Paramount"],
    ["Sony_Archive", "Sony"],
    ["WarnerBros_Archive", "Warner"],
    ["Universal - New Media", "Universal"],
  ];
  for (const [title, want] of real) {
    check(`underscore-joined studio folder is recognised: ${title}`, studioNameOf(title), want);
  }
}

{
  // The false positives substring matching produced, both live in this account.
  check('"Portfolio Mgmt" is not MGM', studioNameOf("8. PMO Structure (Portfolio Mgmt)"), null);
  check('"MWB_INTL" is not Warner', studioNameOf("MWB_INTL__Digital_1Sheets_UK"), null);
  check('"NEWBUILD" is not Warner', studioNameOf("NEWBUILD"), null);
  check("a bare WB folder still is Warner", studioNameOf("WB Assets"), "Warner");
}

// ── one list, so the two sides cannot disagree ──────────────────────────────
{
  // Each side used to keep its own. The enricher knew marvel/pixar/lucasfilm/
  // columbia/tristar/mgm/wbros/wb and the scanner knew none; the scanner knew
  // Lionsgate and XYi and the enricher knew neither.
  for (const k of ["marvel", "pixar", "lucasfilm", "columbia", "tristar", "mgm", "wbros", "wb", "lionsgate", "xyi"]) {
    check(`shared list carries "${k}"`, STUDIO_KEYWORDS_FLAT.includes(k), true);
  }
  check("every keyword maps to a client",
    STUDIO_KEYWORDS_FLAT.every((k) => Boolean(STUDIO_CLIENT[k])), true);
  check("an alias resolves to its studio's client", STUDIO_CLIENT["marvel"], "Disney");
  check("and the keyword lookup agrees with the name lookup",
    studioNameOf("Marvel Studios"), "Disney");
}

// ── the climber uses it ─────────────────────────────────────────────────────
{
  const d = dict(F("wb", "WarnerBros_Archive", ["job"]), F("job", "XY0_x"));
  check("getStudioName reads an underscore-joined studio folder",
    getStudioName({ parentIds: ["job"] }, d, buildChildToParents(d)), "Warner");
}
{
  const d = dict(F("m", "8. PMO Structure (Portfolio Mgmt)", ["job"]), F("job", "XY0_x"));
  check("getStudioName no longer reads Mgmt as MGM",
    getStudioName({ parentIds: ["job"] }, d, buildChildToParents(d)), null);
}

// ── a studio is not a film ──────────────────────────────────────────────────
//
// The exclusion list named three studios while the keyword list named eight,
// so a task under "<Studio> / DIGITAL" returned the studio as its film.
{
  for (const studio of ["Warner Bros", "Disney", "Netflix", "Apple", "Amazon", "Lionsgate"]) {
    const d = dict(
      F("s", studio, ["dig"]),
      F("dig", "DIGITAL", ["job"]),
      F("job", "XY025042_Packshots"),
    );
    const got = getFilmName({ title: "SOMEFILM_Packshots", parentIds: ["job"] },
                            d, "", {}, buildChildToParents(d));
    check(`"${studio}" is not returned as a film name`, got === studio, false);
  }
}
{
  // ...and a real film directly above DIGITAL still is one.
  const d = dict(
    F("f", "Wicked", ["dig"]),
    F("dig", "DIGITAL", ["job"]),
    F("job", "XY025042_Packshots"),
  );
  check("a real film above DIGITAL is still found",
    getFilmName({ title: "WIC_x", parentIds: ["job"] }, d, "", {}, buildChildToParents(d)), "Wicked");
}

// ── recycled folders are excluded, and said to be excluded ─────────────────
{
  // Deleted folders must not enter the dictionary any climber walks — a
  // recycled film folder could otherwise name a live task's film. But being
  // skipped on purpose is not the same as going missing, and conflating them
  // would report an incomplete tree forever in any workspace with a populated
  // recycle bin.
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ data: [{ id: "rb_1", title: "Deleted Film", scope: "RbFolder", parentIds: [] }] }),
  });
  const fd = {};
  const r = await hydrateMissingFolders([{ parentIds: ["rb_1"] }], fd);
  check("a recycled folder never enters the dictionary", fd.rb_1, undefined);
  check("and is reported as recycled", r.recycled, ["rb_1"]);
  check("not as unresolved", r.unresolved, []);
  check("so the tree still counts as complete", r.complete, true);
}
{
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ data: [{ id: "ws_1", title: "Live Film", scope: "WsFolder", parentIds: [] }] }),
  });
  const fd = {};
  const r = await hydrateMissingFolders([{ parentIds: ["ws_1"] }], fd);
  check("a workspace folder still hydrates", fd.ws_1?.title, "Live Film");
  check("and nothing is reported recycled", r.recycled, []);
}
