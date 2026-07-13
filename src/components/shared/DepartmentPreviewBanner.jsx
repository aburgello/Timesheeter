import React from "react";
import { Eye, X } from "lucide-react";
import { setDepartmentPreview, useDepartmentPreviewState } from "../../hooks/useDepartment";

// Persistent, hard-to-miss pill while an admin is previewing another
// department's page set (see AdminModal's "Preview as" switcher). Without
// this, it'd be easy to forget mid-navigation that you're not looking at
// your own real view and misjudge what a department actually has access to.
// A floating pill (matching the existing Admin button's language) rather
// than a full-width strip, since this app has no reserved space at the top
// for a banner and a strip would sit on top of every page's own header.
export default function DepartmentPreviewBanner() {
  const preview = useDepartmentPreviewState();
  if (!preview) return null;

  return (
    <div className="fixed top-4 left-4 z-[9998] flex items-center gap-2 bg-gradient-to-r from-[#12a0e1] to-[#0d8fc9] text-white text-xs font-black pl-3 pr-1.5 py-1.5 rounded-full shadow-lg">
      <Eye className="w-3.5 h-3.5 shrink-0" />
      <span>
        Previewing <span className="uppercase tracking-wide">{preview}</span>
      </span>
      <button
        onClick={() => setDepartmentPreview(null)}
        title="Exit preview — back to your real view"
        className="flex items-center justify-center w-5 h-5 bg-white/20 hover:bg-white/30 rounded-full transition-colors shrink-0"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}
