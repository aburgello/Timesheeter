// The client list, with each client's rate card behind a Rates button.
//
// Part of Administration.
import { useState, useEffect, useCallback } from "react";
import { supabase } from "../../lib/supabaseClient";
import { SimpleListSection } from "./SimpleListSection";
import { ClientRatesModal } from "./ClientRatesModal";

export function ClientsSection({ quickFilters }) {
  const [open, setOpen] = useState(null);
  const [withRates, setWithRates] = useState(new Set());

  const loadWithRates = useCallback(async () => {
    const { data } = await supabase.from("client_rates").select("client_id");
    setWithRates(new Set((data || []).map((r) => r.client_id)));
  }, []);
  useEffect(() => { loadWithRates(); }, [loadWithRates]);

  return (
    <>
      <SimpleListSection
        table="clients"
        labelField="name"
        label="Clients"
        quickFilters={quickFilters}
        quickFilterLabel="Filter by studio"
        renderRowExtra={(item, patchItem) => (
          <button
            type="button"
            onClick={() => setOpen({ client: item, patch: (p) => patchItem(item.id, p) })}
            className={`shrink-0 px-2.5 py-1.5 rounded-lg border text-[11px] font-bold transition-colors ${
              withRates.has(item.id)
                ? "bg-[#12a0e1]/10 border-[#12a0e1]/40 text-[#12a0e1] hover:bg-[#12a0e1]/15"
                : "bg-white border-[#dce4ec] text-[#768994] hover:border-slate-300 hover:text-[#122027]"
            }`}
          >
            Rates
          </button>
        )}
      />
      {open && (
        <ClientRatesModal
          client={open.client}
          onClose={() => setOpen(null)}
          onChanged={(patch) => {
            if (patch) open.patch(patch);
            loadWithRates();
          }}
        />
      )}
    </>
  );
}
