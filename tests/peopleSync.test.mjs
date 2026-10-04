import { planContact, departmentsFromGroups } from "../src/lib/peopleSync.js";

const contact = { id: "W1", firstName: "Ana", lastName: "Lee", avatarUrl: "a.png", profiles: [{ email: "ana@x" }] };

check("people sync: a new person is added with everything",
  planContact(contact, undefined, "Motion"),
  { payload: { wrike_user_id: "W1", email: "ana@x", avatar_url: "a.png", first_name: "Ana", last_name: "Lee", department: "Motion" }, isNew: true, fillsDepartment: true });
check("people sync: an unchanged person isn't written",
  planContact(contact, { wrike_user_id: "W1", email: "ana@x", avatar_url: "a.png", first_name: "Ana", department: "Print" }, "Motion"), null);
check("people sync: a name or department set here is kept",
  planContact({ ...contact, avatarUrl: "b.png" }, { wrike_user_id: "W1", email: "ana@x", avatar_url: "a.png", first_name: "Annie", department: "Print" }, "Motion")?.payload,
  { wrike_user_id: "W1", avatar_url: "b.png" });
check("people sync: a blank department is filled",
  planContact(contact, { wrike_user_id: "W1", email: "ana@x", avatar_url: "a.png", first_name: "Ana" }, "Motion")?.payload,
  { wrike_user_id: "W1", department: "Motion" });
check("people sync: deleted in Wrike marks as left", planContact({ id: "W1", deleted: true }, { wrike_user_id: "W1" }), { leave: true });
check("people sync: already left stays as is", planContact({ id: "W1", deleted: true }, { wrike_user_id: "W1", left_at: "2026-01-01" }), null);
check("people sync: deleted and unknown is never added", planContact({ id: "W9", deleted: true }, undefined), null);

const g = departmentsFromGroups(
  [{ title: "Motion Team", memberIds: ["A", "B"] }, { title: "Print", memberIds: ["B", "C"] }, { title: "Freelancers", memberIds: ["D"] }],
  ["Motion", "Print"]);
check("people sync: groups give departments, two-department people are left out", g.byMember, { A: "Motion", C: "Print" });
check("people sync: unmatched groups are listed", g.unmatched, ["Freelancers"]);
