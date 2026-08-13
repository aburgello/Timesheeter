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
