// Which of a day's Google Calendar events count as meetings, for "Where did my
// day go?". Pure, so it can be tested; lib/googleCalendar.js does the reading.

const minuteOf = (iso) => {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
};

// Why an event isn't a meeting to account for, or "" when it is.
function leftOutBecause(event) {
  if (event.status === "cancelled") return "Cancelled";
  if (!event.start?.dateTime || !event.end?.dateTime) return "All day";
  if (event.eventType && event.eventType !== "default") return "Not a meeting";
  const attendees = event.attendees || [];
  if (attendees.some((a) => a.self && a.responseStatus === "declined")) return "You declined";
  // No one else on it: a reminder or a block you set for yourself.
  if (!attendees.some((a) => !a.self && !a.resource)) return "Only you";
  return "";
}

/**
 * events: items from the Calendar API's events.list for one local day.
 * day: that day, as a Date.
 * Returns { meetings, leftOut }, both in start order. Each is
 * { id, title, from, to, reason? }, from/to in minutes since local midnight
 * and cut to the day, so one that runs past midnight stops at 24:00.
 */
export function pickMeetings(events, day) {
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;
  const meetings = [];
  const leftOut = [];
  for (const event of events || []) {
    const title = event.summary || "(No title)";
    const reason = leftOutBecause(event);
    if (reason === "All day" || reason === "Cancelled") {
      if (reason === "All day") leftOut.push({ id: event.id, title, reason });
      continue;
    }
    const startsAt = new Date(event.start.dateTime).getTime();
    const endsAt = new Date(event.end.dateTime).getTime();
    if (endsAt <= dayStart || startsAt >= dayEnd) continue;
    const item = {
      id: event.id,
      title,
      from: startsAt < dayStart ? 0 : minuteOf(event.start.dateTime),
      to: endsAt >= dayEnd ? 24 * 60 : minuteOf(event.end.dateTime),
    };
    if (reason) leftOut.push({ ...item, reason });
    else meetings.push(item);
  }
  const byStart = (a, b) => (a.from ?? -1) - (b.from ?? -1);
  return { meetings: meetings.sort(byStart), leftOut: leftOut.sort(byStart) };
}
