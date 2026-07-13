import React from "react";
import { AlertCircle, CheckCircle, Info, AlertTriangle, X } from "lucide-react";

const STYLES = {
  success: { bg: "bg-[#1cc1a5]", Icon: CheckCircle },
  error:   { bg: "bg-rose-500",  Icon: AlertCircle },
  info:    { bg: "bg-[#12a0e1]", Icon: Info },
  warning: { bg: "bg-amber-500", Icon: AlertTriangle },
};

// The brand toast pill — same look as the old hand-rolled ToastHost, now
// rendered inside Sonner (which supplies stacking, swipe-to-dismiss,
// pause-on-hover, and real exit animations the old host never had).
export default function ToastPill({ message, type, onDismiss }) {
  const { bg, Icon } = STYLES[type] || STYLES.error;
  return (
    <div className={`flex items-center gap-3 pl-5 pr-3 py-3.5 rounded-2xl shadow-2xl text-sm font-bold text-white w-fit max-w-md ${bg}`}>
      <Icon className="w-5 h-5 shrink-0" />
      <span className="flex-1">{message}</span>
      <button
        onClick={onDismiss}
        className="shrink-0 p-1 rounded-lg hover:bg-white/20 transition-colors"
        aria-label="Dismiss"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
