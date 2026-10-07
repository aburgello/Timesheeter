// Is this order already a task in Wrike? Read-only: it compares the name the
// sheet builds for an order with the titles of the Wrike tasks TimeHub has
// already loaded. Nothing is sent anywhere and nothing in Wrike changes.
//
// It can only say yes. The shared cache keeps Motion's DOOH/DINTH tasks and
// whatever is assigned to a team with a board (see filterToTeams), so a task
// that exists but isn't in the cache, such as an unassigned Print order, finds
// no match. The screens show "In Wrike" for a match and stay silent otherwise.

// A PM tidies the name when making the task: the sheet leaves a doubled
// underscore where a market gave no site name, and spaces become underscores.
// Compared case-blind with those differences ironed out.
export function taskKey(title) {
  return String(title ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// Short or unstructured names would match by accident ("ov", "banner").
const specific = (key) => key.length >= 12 && key.split("_").length >= 4;

const newer = (a, b) => String(b.updatedDate || "") > String(a.updatedDate || "");

// title key → the task, for every task with a title worth matching on. When two
// tasks share a name, the most recently updated one is kept.
export function indexTasks(tasks) {
  const byKey = new Map();
  for (const task of tasks || []) {
    const key = taskKey(task?.title);
    if (!specific(key)) continue;
    const seen = byKey.get(key);
    if (!seen || newer(seen, task)) byKey.set(key, task);
  }
  return byKey;
}

// The Wrike task for an order, or null. The XYi block's title is what becomes
// the task name; the delivery name is the same text and covers sheets where
// the XYi block couldn't be read.
export function findTask(index, order) {
  if (!index?.size) return null;
  for (const name of [order.xyi?.title, order.deliveryName]) {
    const key = taskKey(name);
    if (specific(key) && index.has(key)) return index.get(key);
  }
  return null;
}

export const countInWrike = (index, orders) =>
  index?.size ? orders.filter((o) => findTask(index, o)).length : 0;
