// Global toast API — notify() can be called from anywhere (hooks, utilities,
// components). Backed by Sonner for real: stacking, swipe-to-dismiss,
// pause-on-hover, and exit animations, with our own ToastPill markup so the
// brand pill look is unchanged. <ToastHost/> renders Sonner's <Toaster/>.
import React from "react";
import { toast } from "sonner";
import ToastPill from "../components/shared/ToastPill";

export function notify(message, type = "error") {
  return toast.custom(
    (t) =>
      React.createElement(ToastPill, {
        message,
        type,
        onDismiss: () => toast.dismiss(t),
      }),
    { duration: 4000 }
  );
}
