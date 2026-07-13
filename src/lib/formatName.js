// Wrike lets people put whatever they want in their first/last name — some
// people append an emoji (synced as-is into profiles.first_name/last_name).
// Strip it for display without touching the stored data, so raw Wrike sync
// stays a faithful mirror but names read clean everywhere in this app.
const EMOJI_RE = /\p{Extended_Pictographic}/gu;

export function cleanNamePart(part) {
  if (!part) return "";
  return part.replace(EMOJI_RE, "").replace(/\s+/g, " ").trim();
}

// Joins first + last, both cleaned of emoji, falling back to `fallback`
// (e.g. the wrike_user_id) if nothing legible is left.
export function fullName(first, last, fallback = "") {
  const cleaned = [cleanNamePart(first), cleanNamePart(last)].filter(Boolean).join(" ");
  return cleaned || fallback;
}
