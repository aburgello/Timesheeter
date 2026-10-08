// Rows fade up one after another when an Administration list appears. Only the
// first few are staggered; the rest arrive with the last of them, so a long
// list isn't kept waiting.
export const ROW_ENTER =
  "animate-in fade-in slide-in-from-bottom-1 duration-300 fill-mode-backwards motion-reduce:animate-none";
export const rowEnterDelay = (index) => ({ animationDelay: `${Math.min(index, 14) * 20}ms` });
