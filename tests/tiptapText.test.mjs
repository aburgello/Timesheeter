import { docToPlainText, docHasText } from "../src/utils/tiptapText.js";

const doc = (...content) => JSON.stringify({ type: "doc", content });
const para = (text) => ({ type: "paragraph", content: text ? [{ type: "text", text }] : [] });

check("a paragraph", docToPlainText(doc(para("Turnaround was quick"))), "Turnaround was quick");

// Bold/italic marks carry no meaning in a pasted agenda, so they are dropped
// rather than rendered as asterisks.
check(
  "marks are ignored, text is kept",
  docToPlainText(doc({ type: "paragraph", content: [{ type: "text", text: "Really", marks: [{ type: "bold" }] }, { type: "text", text: " good" }] })),
  "Really good"
);

check(
  "a heading is upper-cased",
  docToPlainText(doc({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Assets" }] })),
  "ASSETS"
);

const bullets = doc({
  type: "bulletList",
  content: [
    { type: "listItem", content: [para("Specs were clear")] },
    { type: "listItem", content: [para("Markets landed on time")] },
  ],
});
check("bullets keep their shape", docToPlainText(bullets), "- Specs were clear\n- Markets landed on time");

const ordered = doc({
  type: "orderedList",
  content: [
    { type: "listItem", content: [para("Lock the market list")] },
    { type: "listItem", content: [para("Then brief")] },
  ],
});
check("numbered lists are numbered", docToPlainText(ordered), "1. Lock the market list\n2. Then brief");

const tasks = doc({
  type: "taskList",
  content: [
    { type: "taskItem", attrs: { checked: true }, content: [para("Chase specs")] },
    { type: "taskItem", attrs: { checked: false }, content: [para("Book the debrief")] },
  ],
});
check("checklists show their state", docToPlainText(tasks), "[x] Chase specs\n[ ] Book the debrief");

// A nested list is indented under its parent item rather than flattened, which
// would silently change what the note said.
const nested = doc({
  type: "bulletList",
  content: [
    {
      type: "listItem",
      content: [
        para("Late drops"),
        { type: "bulletList", content: [{ type: "listItem", content: [para("Propose a cutoff")] }] },
      ],
    },
  ],
});
check("nested lists indent", docToPlainText(nested), "- Late drops\n  - Propose a cutoff");

// The case this exists to avoid: a bullet holding only a screenshot must not
// vanish, or the list looks like it lost an item.
const imageOnly = doc({
  type: "bulletList",
  content: [{ type: "listItem", content: [{ type: "image", attrs: { src: "x" } }] }],
});
check("an image-only bullet is named, not dropped", docToPlainText(imageOnly), "- [image]");

check(
  "blank paragraphs collapse and trailing ones go",
  docToPlainText(doc(para("First"), para(""), para(""), para("Second"), para(""))),
  "First\n\nSecond"
);

// An unknown node type must surrender its text rather than be skipped.
check(
  "unknown blocks keep their text",
  docToPlainText(doc({ type: "someFutureBlock", content: [{ type: "text", text: "still mine" }] })),
  "still mine"
);

// Empty states — these drive whether a section counts as written in.
check("null", docToPlainText(null), "");
check("empty string", docToPlainText(""), "");
check("an empty document", docToPlainText(doc()), "");
check("a document of blank paragraphs", docToPlainText(doc(para(""), para(""))), "");
check("malformed JSON falls back to its own text", docToPlainText("just typed this"), "just typed this");

check("docHasText on a real note", docHasText(doc(para("Something"))), true);
check("docHasText on blank paragraphs", docHasText(doc(para(""))), false);
check("docHasText on null", docHasText(null), false);
// The exact trap the old hasNoteContent hit: TipTap serialises two blank
// paragraphs as a long, non-empty string, so a truthy check counted it as a
// write-up.
check(
  "docHasText is not fooled by a non-empty empty document",
  docHasText('{"type":"doc","content":[{"type":"paragraph"},{"type":"paragraph"}]}'),
  false
);

// ── HTML export ─────────────────────────────────────────────────────────────
import { docToHtml, escapeHtml } from "../src/utils/tiptapText.js";

check("a paragraph becomes a p", docToHtml(doc(para("Turnaround was quick"))), "<p>Turnaround was quick</p>");

// Marks are KEPT here, unlike the plain-text path — in HTML they survive the
// paste, so dropping them would lose emphasis the writer meant.
check(
  "bold survives",
  docToHtml(doc({ type: "paragraph", content: [{ type: "text", text: "Really", marks: [{ type: "bold" }] }, { type: "text", text: " good" }] })),
  "<p><strong>Really</strong> good</p>"
);

check("bullets become a real list", docToHtml(bullets), "<ul><li>Specs were clear</li><li>Markets landed on time</li></ul>");
check("numbered lists become ol", docToHtml(ordered), "<ol><li>Lock the market list</li><li>Then brief</li></ol>");
check("checklists carry a box glyph", docToHtml(tasks), "<ul><li>☑ Chase specs</li><li>☐ Book the debrief</li></ul>");
check("nested lists nest", docToHtml(nested), "<ul><li>Late drops<ul><li>Propose a cutoff</li></ul></li></ul>");

// The whole reason this escapes: a note is user text and may contain markup
// characters, which would otherwise break the document it is pasted into.
check("angle brackets are escaped", docToHtml(doc(para("a < b & c > d"))), "<p>a &lt; b &amp; c &gt; d</p>");
check("escapeHtml quotes too", escapeHtml('a "b" <c>'), "a &quot;b&quot; &lt;c&gt;");

// A javascript: URL must not be carried into whatever document this lands in.
const evilLink = doc({
  type: "paragraph",
  content: [{ type: "text", text: "click", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }],
});
check("a javascript: link is stripped to plain text", docToHtml(evilLink), "<p>click</p>");

const goodLink = doc({
  type: "paragraph",
  content: [{ type: "text", text: "brief", marks: [{ type: "link", attrs: { href: "https://wrike.com/x" } }] }],
});
check("an http link is kept", docToHtml(goodLink), '<p><a href="https://wrike.com/x">brief</a></p>');

check("empty document", docToHtml(doc()), "");
check("null", docToHtml(null), "");
check("blank paragraphs produce nothing", docToHtml(doc(para(""), para(""))), "");
