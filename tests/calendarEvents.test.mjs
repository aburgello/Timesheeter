import { pickMeetings } from "../src/lib/calendarEvents.js";

const day = new Date(2026, 9, 8);
const at = (h, m = 0, d = 8) => ({ dateTime: new Date(2026, 9, d, h, m).toISOString() });
const me = (responseStatus = "accepted") => ({ self: true, responseStatus });
const them = { email: "x@example.com", responseStatus: "accepted" };
const event = (id, start, end, extra = {}) => ({ id, summary: id, status: "confirmed", start, end, attendees: [me(), them], ...extra });

const { meetings, leftOut } = pickMeetings(
  [
    event("standup", at(9, 30), at(9, 45)),
    event("review", at(14), at(15)),
    event("declined", at(11), at(12), { attendees: [me("declined"), them] }),
    event("focus block", at(10), at(11), { attendees: undefined }),
    event("just me invited", at(16), at(17), { attendees: [me()] }),
    event("with a room only", at(16), at(17), { attendees: [me(), { resource: true }] }),
    event("holiday", { date: "2026-10-08" }, { date: "2026-10-09" }),
    event("called off", at(13), at(14), { status: "cancelled" }),
    event("out of office", at(12), at(13), { eventType: "outOfOffice" }),
    event("tentative", at(15, 30), at(16), { attendees: [me("tentative"), them] }),
    { id: "untitled", status: "confirmed", start: at(17), end: at(17, 30), attendees: [me(), them] },
  ],
  day
);
check("meetings with other people, in start order", meetings.map((m) => m.id), ["standup", "review", "tentative", "untitled"]);
check("times are minutes into the day", meetings[0], { id: "standup", title: "standup", from: 570, to: 585 });
check("no title", meetings[3].title, "(No title)");
check("left out, with why", leftOut.map((m) => [m.id, m.reason]), [
  ["holiday", "All day"],
  ["focus block", "Only you"],
  ["declined", "You declined"],
  ["out of office", "Not a meeting"],
  ["just me invited", "Only you"],
  ["with a room only", "Only you"],
]);
check("cancelled events aren't mentioned", leftOut.some((m) => m.id === "called off"), false);

const overnight = pickMeetings([event("late call", at(23, 30), at(0, 30, 9)), event("from yesterday", at(23, 0, 7), at(0, 45))], day).meetings;
check("one running past midnight stops at 24:00", overnight.find((m) => m.id === "late call"), { id: "late call", title: "late call", from: 1410, to: 1440 });
check("one from the night before starts at 00:00", overnight.find((m) => m.id === "from yesterday"), { id: "from yesterday", title: "from yesterday", from: 0, to: 45 });
check("nothing on the calendar", pickMeetings([], day), { meetings: [], leftOut: [] });
check("no list at all", pickMeetings(undefined, day), { meetings: [], leftOut: [] });
