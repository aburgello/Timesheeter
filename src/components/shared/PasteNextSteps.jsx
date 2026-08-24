import React, { useEffect, useRef } from "react";
import { Star, ClipboardPaste, MousePointerClick, Check } from "lucide-react";

// "You've copied it — here's where it goes."
//
// The copy button used to say "Copy JSON", which told people what the data was
// and nothing about what to do with it. JSON is not a thing most of the studio
// has heard of, and the one instruction that actually matters — this goes into
// the bookmark you added to your favourites, nowhere else — was a single line
// of small print in a modal most people never open.
//
// So the button says "Copy Me!" and the explaining happens HERE, at the moment
// it lands: the person is holding something invisible on their clipboard and
// wondering what just happened. That is the only moment they will read three
// steps.
//
// The bookmarks-bar chip below is the point of the whole component. Describing
// a bookmarklet in words ("click the bookmarklet") fails for exactly the people
// this is for — they don't know that word, and their eye slides off it. A
// picture of the strip along the top of their own browser, with a star on it,
// is recognised instantly and needs no vocabulary at all.
//
// We never name the bookmark: it's called whatever they typed when they saved
// it. The window it opens IS fixed, so step 3 names that instead — it's how
// they know they clicked the right star.
const STEPS = [
  {
    icon: MousePointerClick,
    title: "Open your timesheet website",
    body: "Go to the day you're filling in. The bookmark fills whichever Day tab is showing.",
  },
  {
    icon: Star,
    title: "Click your bookmark up in the favourites bar",
    body: "The one you saved when you set this up.",
    chip: true,
  },
  {
    icon: ClipboardPaste,
    title: "Paste into the box, then hit Populate Rows",
    body: 'A window called "Automate Timesheet" opens with an empty box. Paste what you just copied there!',
  },
];

// `popover` draws the card's own floating chrome, hung upward off whatever
// `relative` wrapper the caller put it in. It lives here rather than at the call
// site so the dismissal rules travel with it: Escape and an outside click both
// close it, which is what every other popover in the app does and what people
// will try before they find the button.
export default function PasteNextSteps({
  copied = false,
  onDismiss,
  popover = false,
}) {
  const ref = useRef(null);

  useEffect(() => {
    if (!onDismiss) return;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onDismiss();
    };
    const onKey = (e) => {
      if (e.key === "Escape") onDismiss();
    };
    // mousedown fires before the click that opened it has finished elsewhere,
    // so this is deferred a tick — otherwise the very click on "Copy Me!" that
    // opens the card is also read as the outside click that closes it.
    const t = setTimeout(() => {
      document.addEventListener("mousedown", onDown);
      document.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onDismiss]);

  return (
    <div
      ref={ref}
      className={
        popover
          ? "absolute bottom-full right-0 mb-2 w-[320px] max-w-[calc(100vw-2rem)] text-left bg-white border border-[#dce4ec] rounded-2xl shadow-2xl p-4 z-40 animate-in fade-in slide-in-from-bottom-1 duration-200"
          : "text-left"
      }
    >
      {copied && (
        <div className="flex items-center gap-2 mb-3">
          <span className="flex items-center justify-center w-5 h-5 rounded-full bg-[#1cc1a5] text-white shrink-0">
            <Check className="w-3 h-3" strokeWidth={3} />
          </span>
          <p className="text-sm font-black text-[#122027] tracking-tight">
            Copied! Now put it in your timesheet
          </p>
        </div>
      )}

      <ol className="space-y-3">
        {STEPS.map((step, i) => {
          const Icon = step.icon;
          return (
            <li key={step.title} className="flex gap-3">
              <span className="flex items-center justify-center w-6 h-6 rounded-lg bg-[#12a0e1]/10 text-[#12a0e1] shrink-0 mt-0.5">
                <Icon className="w-3.5 h-3.5" />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-bold text-[#122027] leading-snug">
                  <span className="text-[#768994] tabular-nums">{i + 1}. </span>
                  {step.title}
                </p>
                <p className="text-[11px] text-[#768994] leading-relaxed mt-0.5">
                  {step.body}
                </p>

                {/* A miniature of the browser's own bookmarks bar. This is the
                    step people get stuck on, and it's the one that can't be
                    explained in words to someone who doesn't have the word. */}
                {step.chip && (
                  <div className="mt-2 rounded-lg border border-[#dce4ec] bg-slate-50 px-2 py-1.5">
                    <div className="flex items-center gap-1.5">
                      <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-white border border-[#dce4ec] text-[10px] font-bold text-[#323b43]">
                        <Star className="w-2.5 h-2.5 fill-[#f5b301] text-[#f5b301]" />
                        your bookmark
                      </span>
                      <span className="h-2.5 w-10 rounded bg-[#dce4ec]" />
                      <span className="h-2.5 w-7 rounded bg-[#dce4ec]" />
                      <span className="h-2.5 w-12 rounded bg-[#dce4ec]" />
                    </div>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {/* Nothing expires on the clipboard, so there's no countdown and no
          auto-dismiss: it closes when the person says they've read it. */}
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="mt-4 w-full py-2 rounded-xl bg-[#122027] hover:bg-[#25373c] text-white text-xs font-bold transition-colors"
        >
          Got it
        </button>
      )}
    </div>
  );
}
