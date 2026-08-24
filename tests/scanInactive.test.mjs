// What the Job Book scan treats as not-live, and therefore hides behind
// "Active only". Mirrors isArchiveNode / isOldContainer in wrikeCampaign.js.
//
// Pinned here because the _Old rule is a whole-string match on a name that is
// also a real film: "Old" (2021) is a campaign folder that must stay live,
// while "_Old" is the studio's container for finished ones.
const isOldContainer = (title) => /^_old$/i.test((title || "").trim());
const isArchiveNode = (title) =>
  /(^|[\s_])_?archive\b/i.test(title || "") ||
  /master.?template/i.test(title || "") ||
  isOldContainer(title);

// The container the review was drowning in.
check("_Old is not live", isArchiveNode("_Old"), true);
check("case doesn't matter", isArchiveNode("_OLD"), true);
check("nor does padding", isArchiveNode("  _old  "), true);

// The film. This is the whole reason the test is anchored rather than a
// substring search.
check("the film Old stays live", isArchiveNode("Old"), false);
check("The Old Oak stays live", isArchiveNode("The Old Oak"), false);
check("The Old Guard stays live", isArchiveNode("The Old Guard"), false);
check("_Old_Media is not the container", isArchiveNode("_Old_Media"), false);
check("Old_Spice is not the container", isArchiveNode("Old_Spice"), false);

// Everything the rule already caught, unchanged.
check("_Archive", isArchiveNode("_Archive"), true);
check("Archive", isArchiveNode("Archive"), true);
check("_zArchive is still missed here", isArchiveNode("_zArchive"), false); // caught by isOrgFolder instead
check("Master Template", isArchiveNode("Master Template"), true);
check("a normal film folder", isArchiveNode("Street Fighter"), false);
check("a job folder", isArchiveNode("XY026179_ITM_Print_Custom_Lobby_Display"), false);
