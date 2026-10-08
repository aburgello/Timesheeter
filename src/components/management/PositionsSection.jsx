// The job titles a person can hold, and the rate card position each one bills
// as. Rates themselves are per client; see ClientRatesModal.
//
// Part of Administration.
import { useState, useEffect, useMemo } from "react";
import { supabase } from "../../lib/supabaseClient";
import { FeedSelect } from "./fields";
import { SimpleListSection } from "./SimpleListSection";

export function PositionsSection() {
  const [roles, setRoles] = useState([]);
  useEffect(() => {
    supabase.from("rate_roles").select("*").order("sort_order").order("name")
      .then(({ data }) => setRoles(data || []));
  }, []);
  const roleOptions = useMemo(() => roles.map((r) => ({ value: String(r.id), label: r.name })), [roles]);

  return (
    <SimpleListSection
      table="positions"
      labelField="title"
      label="Positions"
      placeholder="e.g. Creative Director…"
      renderRowExtra={(item, patchItem) => (
        <FeedSelect
          value={item.rate_role_id ? String(item.rate_role_id) : ""}
          onChange={async (v) => {
            const rate_role_id = v ? Number(v) : null;
            patchItem(item.id, { rate_role_id });
            await supabase.from("positions").update({ rate_role_id }).eq("id", item.id);
          }}
          allLabel="Bills as nothing"
          className="w-[150px] shrink-0"
          options={roleOptions}
        />
      )}
    />
  );
}
