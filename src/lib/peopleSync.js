// "Sync from Wrike" for People: adds new people, fills a blank department from
// a Wrike group named exactly after it, and marks people whose Wrike account
// was deleted as having left. Nothing set in TimeHub is overwritten: names,
// departments and "left" all stick.
//
// Run by hand from Administration › People, and once a day for an
// administrator (autoSyncPeople). Writing other people's profiles needs an
// administrator, so nobody else runs it.
import { departmentForGroup, hasLeft } from "./people";

export const PEOPLE_SYNC_EVERY_MS = 24 * 60 * 60 * 1000;

// What changes for each Wrike contact, given the profile we hold (or none).
// Returns { leave } for a deleted contact to mark as left, a payload to
// upsert, or null when nothing would change.
export function planContact(contact, row, department) {
  if (contact.deleted) return row && !hasLeft(row) ? { leave: true } : null;
  const payload = {};
  const email = contact.profiles?.[0]?.email || null;
  const avatar = contact.avatarUrl || null;
  if (!row || (email && row.email !== email)) payload.email = email;
  if (!row || (avatar && row.avatar_url !== avatar)) payload.avatar_url = avatar;
  if (!row || !(row.first_name || row.last_name)) {
    if (contact.firstName || contact.lastName || !row) {
      payload.first_name = contact.firstName || null;
      payload.last_name = contact.lastName || null;
    }
  }
  if (department && !row?.department) payload.department = department;
  if (!Object.keys(payload).length) return null;
  return { payload: { wrike_user_id: contact.id, ...payload }, isNew: !row, fillsDepartment: "department" in payload };
}

// Department per Wrike contact id. Someone in groups for two different
// departments is left for a person to decide.
export function departmentsFromGroups(groups, departments) {
  const byMember = {};
  const conflicted = new Set();
  const unmatched = [];
  for (const group of groups || []) {
    const dept = departmentForGroup(group.title, departments);
    if (!dept) { if (group.title) unmatched.push(group.title); continue; }
    for (const id of group.memberIds || []) {
      if (byMember[id] && byMember[id] !== dept) conflicted.add(id);
      byMember[id] = dept;
    }
  }
  conflicted.forEach((id) => delete byMember[id]);
  return { byMember, conflicted, unmatched };
}

export async function syncPeopleFromWrike(supabase, { fetchImpl = fetch } = {}) {
  const [contactsRes, groupsRes, deptRes, profilesRes] = await Promise.all([
    fetchImpl("/api/wrike/contacts"),
    fetchImpl("/api/wrike/groups"),
    supabase.from("job_departments").select("name"),
    supabase.from("profiles").select("*"),
  ]);
  if (!contactsRes.ok) throw new Error(`Wrike contacts error ${contactsRes.status}`);
  if (profilesRes.error) throw new Error(`profiles: ${profilesRes.error.message}`);
  const contacts = ((await contactsRes.json()).data || []).filter((c) => c.type === "Person");
  const departments = (deptRes.data || []).map((d) => d.name).filter(Boolean);
  const groups = groupsRes.ok ? (await groupsRes.json()).data : [];
  const { byMember, conflicted, unmatched } = departmentsFromGroups(groups, departments);
  const existing = new Map((profilesRes.data || []).map((r) => [r.wrike_user_id, r]));

  const result = { people: 0, added: 0, departmentsFilled: 0, markedLeft: 0, failed: 0, conflicted: conflicted.size, unmatchedGroups: unmatched };
  for (const c of contacts) {
    if (!c.deleted) result.people++;
    const plan = planContact(c, existing.get(c.id), byMember[c.id]);
    if (!plan) continue;
    const { error } = plan.leave
      ? await supabase.from("profiles").update({ left_at: new Date().toISOString() }).eq("wrike_user_id", c.id)
      : await supabase.from("profiles").upsert(plan.payload, { onConflict: "wrike_user_id" });
    if (error) { result.failed++; continue; }
    if (plan.leave) result.markedLeft++;
    if (plan.isNew) result.added++;
    if (plan.fillsDepartment) result.departmentsFilled++;
  }
  return result;
}

// The daily run. The people_synced_at stamp is claimed first, so two
// administrators opening TimeHub together don't both run it. Does nothing
// before that column exists.
export async function autoSyncPeople(supabase, { now = Date.now(), fetchImpl = fetch } = {}) {
  const due = new Date(now - PEOPLE_SYNC_EVERY_MS).toISOString();
  const { data, error } = await supabase
    .from("wrike_sync_meta")
    .update({ people_synced_at: new Date(now).toISOString() })
    .eq("wrike_user_id", "shared")
    .or(`people_synced_at.is.null,people_synced_at.lt.${due}`)
    .select("wrike_user_id");
  if (error || !data?.length) return null;
  try {
    const result = await syncPeopleFromWrike(supabase, { fetchImpl });
    console.log("[People] daily sync from Wrike:", result);
    return result;
  } catch (err) {
    // Hand the day's run back, so the next load tries again.
    await supabase.from("wrike_sync_meta").update({ people_synced_at: null }).eq("wrike_user_id", "shared");
    throw err;
  }
}
