import React, { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle, HelpCircle } from "lucide-react";
import { subscribeConfirm } from "../../lib/confirm";

// Renders the app-styled confirm dialog for confirmAction() (lib/confirm.js).
// Mounted once in App, next to ToastHost. Escape and backdrop-click cancel;
// focus starts on Cancel for danger actions (an accidental Enter shouldn't
// delete anything) and on Confirm otherwise.
export default function ConfirmHost() {
  const [req, setReq] = useState(null);
  const confirmRef = useRef(null);
  const cancelRef = useRef(null);

  useEffect(() => subscribeConfirm(setReq), []);

  const settle = useCallback(
    (ok) => {
      if (!req) return;
      req.resolve(ok);
      setReq(null);
    },
    [req]
  );

  useEffect(() => {
    if (!req) return;
    (req.danger ? cancelRef : confirmRef).current?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") settle(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [req, settle]);

  return (
    <AnimatePresence>
      {req && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[10050] flex items-center justify-center p-4 bg-[#122027]/60 backdrop-blur-sm"
          onMouseDown={() => settle(false)}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 4 }}
            transition={{ duration: 0.18, ease: [0.25, 0.1, 0.25, 1] }}
            role="alertdialog"
            aria-modal="true"
            aria-label={req.title}
            className="bg-white rounded-3xl shadow-2xl w-full max-w-sm border border-[#dce4ec] overflow-hidden"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="p-6">
              <div
                className={`w-11 h-11 rounded-2xl flex items-center justify-center mb-4 ${
                  req.danger ? "bg-rose-50 text-rose-500" : "bg-[#12a0e1]/10 text-[#12a0e1]"
                }`}
              >
                {req.danger ? <AlertTriangle className="w-5 h-5" /> : <HelpCircle className="w-5 h-5" />}
              </div>
              <h2 className="text-lg font-black text-[#122027] tracking-tight">{req.title}</h2>
              {req.message && (
                <p className="text-sm text-[#768994] mt-1.5 leading-relaxed">{req.message}</p>
              )}
            </div>
            <div className="px-6 pb-6 flex justify-end gap-2">
              <button
                ref={cancelRef}
                onClick={() => settle(false)}
                className="px-4 py-2.5 text-sm font-bold text-[#768994] hover:text-[#122027] bg-white border border-[#dce4ec] rounded-2xl transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[#12a0e1]/40"
              >
                {req.cancelLabel}
              </button>
              <button
                ref={confirmRef}
                onClick={() => settle(true)}
                className={`px-5 py-2.5 text-sm font-bold text-white rounded-2xl transition-all shadow-sm focus:outline-none focus-visible:ring-2 ${
                  req.danger
                    ? "bg-rose-500 hover:bg-rose-600 focus-visible:ring-rose-300"
                    : "bg-[#12a0e1] hover:bg-[#0d8bc4] focus-visible:ring-[#12a0e1]/40"
                }`}
              >
                {req.confirmLabel}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
