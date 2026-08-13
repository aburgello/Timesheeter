// A stored note is a TipTap document (JSON), which is the right shape for an
// editor and the wrong shape for a debrief agenda. This turns one back into
// plain text you can paste into Slack, a doc, or an email.
//
// Deliberately NOT a general-purpose serialiser. It handles the block types the
// End of Campaign editor can actually produce (see SLASH_COMMANDS in
// RichNoteEditor) and degrades to the text content for anything else, because
// the alternative — dropping a node type it doesn't recognise — would silently
// lose somebody's note. Images and videos have no text to give, so they are
// named rather than dropped, otherwise a bullet holding only a screenshot
// vanishes and the list looks like it lost an item.

const BULLET = "- ";

// Marks are ignored on purpose: bold and italic have no plain-text equivalent
// that survives a paste, and "**like this**" is noise in a meeting agenda.
function inlineText(node) {
  if (!node) return "";
  if (node.type === "text") return node.text || "";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "image") return "[image]";
  if (node.type === "video") return "[video]";
  return (node.content || []).map(inlineText).join("");
}

// `depth` indents nested lists; `ordered` carries the number for ol items.
function blockText(node, depth = 0) {
  if (!node) return [];
  const pad = "  ".repeat(depth);

  switch (node.type) {
    case "doc":
      return (node.content || []).flatMap((n) => blockText(n, depth));

    case "paragraph": {
      const t = inlineText(node).trim();
      // An empty paragraph is a deliberate blank line in the editor, so it is
      // kept — but only as a separator, never as leading or trailing space
      // (trimmed by the caller).
      return [t ? pad + t : ""];
    }

    case "heading": {
      const t = inlineText(node).trim();
      return t ? [pad + t.toUpperCase()] : [];
    }

    case "bulletList":
      return (node.content || []).flatMap((li) => listItemText(li, depth, BULLET));

    case "orderedList": {
      let n = node.attrs?.start || 1;
      return (node.content || []).flatMap((li) => listItemText(li, depth, `${n++}. `));
    }

    case "taskList":
      return (node.content || []).flatMap((li) =>
        listItemText(li, depth, li.attrs?.checked ? "[x] " : "[ ] ")
      );

    case "blockquote":
      return (node.content || []).flatMap((n) => blockText(n, depth)).map((l) => (l ? `> ${l}` : l));

    case "codeBlock":
      return inlineText(node).split("\n").map((l) => pad + l);

    case "horizontalRule":
      return [pad + "---"];

    case "image":
      return [pad + "[image]"];

    case "video":
      return [pad + "[video]"];

    default: {
      // Unknown block: take whatever text is inside rather than dropping it.
      const t = inlineText(node).trim();
      return t ? [pad + t] : [];
    }
  }
}

// A list item's first block sits on the bullet line; anything after it (a
// second paragraph, a nested list) is indented under it.
function listItemText(item, depth, marker) {
  const blocks = (item.content || []).flatMap((n) => blockText(n, depth + 1));
  const lines = blocks.filter((l) => l !== "");
  if (!lines.length) return [];
  const pad = "  ".repeat(depth);
  const [first, ...rest] = lines;
  return [pad + marker + first.trim(), ...rest];
}

/**
 * A stored note (JSON string, parsed document, or null) as plain text.
 * Returns "" for anything empty — which is what the export tests to decide
 * whether a person wrote in a section at all.
 */
export function docToPlainText(raw) {
  let doc = raw;
  if (typeof raw === "string") {
    if (!raw.trim()) return "";
    try {
      doc = JSON.parse(raw);
    } catch {
      // Not JSON: an older plain-text note, or something hand-written into the
      // column. Its own text is the best answer available.
      return raw.trim();
    }
  }
  if (!doc || typeof doc !== "object") return "";

  const lines = blockText(doc);
  // Collapse runs of blank lines to one, and trim the ends: an editor left
  // open collects trailing empty paragraphs that would otherwise become
  // trailing whitespace in the agenda.
  const out = [];
  for (const line of lines) {
    if (line === "" && (out.length === 0 || out[out.length - 1] === "")) continue;
    out.push(line);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n").trim();
}

/** Whether a stored note holds anything a reader would see. */
export function docHasText(raw) {
  return docToPlainText(raw).length > 0;
}

// ── HTML ─────────────────────────────────────────────────────────────────────
//
// The same documents again, as HTML, for the rich half of the clipboard. This
// is where bullets stay bullets and bold stays bold when the agenda is pasted
// into Slack, Docs or an email — the plain-text version above flattens all of
// that into hyphens and indentation.

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Marks ARE kept here, unlike the plain-text path: in HTML they survive the
// paste, so dropping them would lose emphasis the writer put in deliberately.
function inlineHtml(node) {
  if (!node) return "";
  if (node.type === "hardBreak") return "<br>";
  if (node.type === "image") return "[image]";
  if (node.type === "video") return "[video]";
  if (node.type !== "text") return (node.content || []).map(inlineHtml).join("");

  let html = escapeHtml(node.text || "");
  for (const mark of node.marks || []) {
    switch (mark.type) {
      case "bold": html = `<strong>${html}</strong>`; break;
      case "italic": html = `<em>${html}</em>`; break;
      case "underline": html = `<u>${html}</u>`; break;
      case "strike": html = `<s>${html}</s>`; break;
      case "code": html = `<code>${html}</code>`; break;
      case "link": {
        const href = escapeHtml(mark.attrs?.href || "");
        // Only http(s) and mailto survive. A pasted javascript: or data: URL
        // would otherwise be carried into whatever document this lands in.
        html = /^(https?:|mailto:)/i.test(href) ? `<a href="${href}">${html}</a>` : html;
        break;
      }
      default: break;
    }
  }
  return html;
}

function blockHtml(node) {
  if (!node) return "";
  switch (node.type) {
    case "doc":
      return (node.content || []).map(blockHtml).join("");
    case "paragraph": {
      const inner = inlineHtml(node);
      return inner.trim() ? `<p>${inner}</p>` : "";
    }
    case "heading": {
      const inner = inlineHtml(node);
      if (!inner.trim()) return "";
      const level = Math.min(Math.max(node.attrs?.level || 2, 1), 6);
      return `<h${level}>${inner}</h${level}>`;
    }
    // Arrow-wrapped, not a bare `.map(listItemHtml)`: map passes the index as
    // the second argument, which would land in listItemHtml's `prefix` and
    // print "0"/"1" in front of every item.
    case "bulletList":
      return `<ul>${(node.content || []).map((li) => listItemHtml(li)).join("")}</ul>`;
    case "orderedList": {
      const start = node.attrs?.start || 1;
      const attr = start !== 1 ? ` start="${start}"` : "";
      return `<ol${attr}>${(node.content || []).map((li) => listItemHtml(li)).join("")}</ol>`;
    }
    case "taskList":
      // Rendered as a plain list with a box glyph rather than real checkboxes:
      // an <input> pastes as an interactive control in some editors and is
      // stripped entirely by others, whereas a character always survives.
      return `<ul>${(node.content || [])
        .map((li) => listItemHtml(li, li.attrs?.checked ? "☑ " : "☐ "))
        .join("")}</ul>`;
    case "blockquote":
      return `<blockquote>${(node.content || []).map(blockHtml).join("")}</blockquote>`;
    case "codeBlock":
      return `<pre><code>${escapeHtml(inlineText(node))}</code></pre>`;
    case "horizontalRule":
      return "<hr>";
    case "image":
      return "<p>[image]</p>";
    case "video":
      return "<p>[video]</p>";
    default: {
      const inner = inlineHtml(node);
      return inner.trim() ? `<p>${inner}</p>` : "";
    }
  }
}

function listItemHtml(item, prefix = "") {
  const inner = (item.content || []).map(blockHtml).join("");
  if (!inner) return "";
  // A list item wrapping its text in <p> gains a paragraph's margins in most
  // targets, which spaces a tight list out into something twice as long.
  const tightened = inner.replace(/^<p>([\s\S]*?)<\/p>/, "$1");
  return `<li>${prefix}${tightened}</li>`;
}

/** A stored note as an HTML fragment. "" when the note is empty. */
export function docToHtml(raw) {
  let doc = raw;
  if (typeof raw === "string") {
    if (!raw.trim()) return "";
    try {
      doc = JSON.parse(raw);
    } catch {
      return `<p>${escapeHtml(raw.trim())}</p>`;
    }
  }
  if (!doc || typeof doc !== "object") return "";
  return blockHtml(doc);
}
