import { taskKey, indexTasks, indexParents, findTask, countInWrike, taskSummary } from "../src/lib/orderForms/wrikeMatch.js";

// The sheet leaves a doubled underscore where the site name is empty; the task
// a PM makes from it has one.
check("doubled underscore", taskKey("SF_INTL_Trio_DOOH__1632x832px_30s_KZ"), taskKey("SF_INTL_Trio_DOOH_1632x832px_30s_KZ"));
check("spaces are underscores", taskKey("EBZR_INTL_CandleSmoke_INTH_Multi Panel_960x576px_CMYK_HR"), taskKey("EBZR_INTL_CandleSmoke_INTH_Multi_Panel_960x576px_CMYK_HR"));
check("case and padding", taskKey("  sf_intl_trio_dooh_1632x832px_30s_kz "), "sf_intl_trio_dooh_1632x832px_30s_kz");
check("a different size is a different task", taskKey("SF_INTL_Trio_DOOH_1632x832px_30s_KZ") === taskKey("SF_INTL_Trio_DOOH_1760x448px_30s_KZ"), false);
check("empty", taskKey(null), "");

const tasks = [
  { id: "A", title: "SF_INTL_Trio_DOOH_1632x832px_30s_KZ", updatedDate: "2026-10-01T10:00:00Z" },
  { id: "B", title: "SF_INTL_Trio_DOOH_1760x448px_20s_KZ", updatedDate: "2026-10-01T10:00:00Z" },
  { id: "C", title: "SF_INTL_Trio_DOOH_1760x448px_20s_KZ", updatedDate: "2026-10-05T10:00:00Z" },
  { id: "D", title: "Banner" },
  { id: "E", title: "OV_Masters" },
  { id: "F" },
];
const index = indexTasks(tasks);

check("indexed by tidied name", index.get("sf_intl_trio_dooh_1632x832px_30s_kz")?.id, "A");
check("same name twice: the most recently updated", index.get("sf_intl_trio_dooh_1760x448px_20s_kz")?.id, "C");
check("short and unstructured titles are left out", [index.has("banner"), index.has("ov_masters")], [false, false]);

const order = (title, deliveryName = "") => ({ xyi: { title }, deliveryName });
check("matched by the XYi title", findTask(index, order("SF_INTL_Trio_DOOH__1632x832px_30s_KZ"))?.id, "A");
check("matched by the delivery name when the XYi title is missing", findTask(index, order("", "SF_INTL_Trio_DOOH__1632x832px_30s_KZ"))?.id, "A");
check("no task with that name", findTask(index, order("SF_INTL_Trio_DOOH__512x1536px_8s_KZ")), null);
check("an order with no name matches nothing", findTask(index, order("")), null);
check("a vague name matches nothing even if a task has it", findTask(indexTasks([{ id: "D", title: "Banner" }]), order("Banner")), null);
check("no tasks loaded", findTask(indexTasks([]), order("SF_INTL_Trio_DOOH__1632x832px_30s_KZ")), null);
check("no index at all", findTask(null, order("SF_INTL_Trio_DOOH__1632x832px_30s_KZ")), null);

check("count per market", countInWrike(index, [
  order("SF_INTL_Trio_DOOH__1632x832px_30s_KZ"),
  order("SF_INTL_Trio_DOOH__1760x448px_20s_KZ"),
  order("SF_INTL_Trio_DOOH__512x1536px_8s_KZ"),
]), 2);
check("count with nothing loaded", countInWrike(indexTasks([]), [order("SF_INTL_Trio_DOOH__1632x832px_30s_KZ")]), 0);

// People and dates usually sit on the parent task, not the per-size subtask.
const hub = { id: "P", title: "SF Motion Outdoor Bespoke KZ", subTaskIds: ["S"], assignees: "James C., AM T.", dates: { due: "2026-10-08T17:00:00" } };
const sub = { id: "S", title: "SF_INTL_Trio_DOOH_512x1536px_8s_KZ", assignees: "", dates: { due: "2026-10-07T17:00:00" } };
const parents = indexParents([hub, sub]);
check("a subtask's parent is found", parents.get("S")?.id, "P");
check("a top-level task has no parent", parents.get("P"), undefined);
check("bare subtask: the parent's people, and both due dates", taskSummary(sub, hub), {
  assignees: "James C., AM T.", assigneesFromParent: true, due: "2026-10-07", dueFromParent: false, parentDue: "2026-10-08",
});
check("the subtask's own people win", taskSummary({ ...sub, assignees: "Michael S." }, hub).assignees, "Michael S.");
check("same due date on both is said once", taskSummary({ ...sub, dates: hub.dates }, hub).parentDue, "");
check("undated subtask takes the parent's date", taskSummary({ ...sub, dates: {} }, hub), {
  assignees: "James C., AM T.", assigneesFromParent: true, due: "2026-10-08", dueFromParent: true, parentDue: "",
});
check("no parent loaded", taskSummary(sub, undefined), {
  assignees: "", assigneesFromParent: false, due: "2026-10-07", dueFromParent: false, parentDue: "",
});
