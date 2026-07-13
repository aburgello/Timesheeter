import React from "react";
import { Toaster } from "sonner";

// Global toast renderer — Sonner's Toaster, top-right. Rendering itself is
// unstyled here: every toast arrives via notify() (lib/toast.js) as a
// toast.custom ToastPill, so the brand pill owns the look and Sonner owns
// the behaviour (stacking, swipe-to-dismiss, pause-on-hover, exit animation).
export default function ToastHost() {
  return <Toaster position="top-right" offset={20} gap={10} visibleToasts={5} />;
}
