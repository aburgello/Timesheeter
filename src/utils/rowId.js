// A new id for a tasks row. tasks.id is the primary key and the browser picks
// it, so one insert carrying the same id twice is rejected whole.
//
// Still a millisecond timestamp with a random offset, which is what keeps two
// people adding rows in the same instant apart. Never the same or lower than
// the last one handed out, so ids made in one loop can't collide.
let last = 0;
export function newRowId() {
  last = Math.max(Date.now() + Math.floor(Math.random() * 1000), last + 1);
  return last;
}
