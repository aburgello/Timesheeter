// Reads the signed-in person's own Google Calendar for one day.
//
// Read-only by scope (calendar.events.readonly), and asked for separately from
// Client Orders' Drive access, so using one never asks for the other. The
// token goes to googleapis.com and nowhere else: the Worker and Supabase never
// see it or any event. It's kept in sessionStorage for its hour, like the
// Drive one (see lib/orderForms/googleApi.js).
import { CLIENT_ID, loadGsi, GoogleError } from "./orderForms/googleApi";

const SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
const EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const TOKEN_KEY = "xyi_google_calendar_token";
// Set once access has been granted here, so the next request can be quiet. Not
// a credential.
const GRANTED_KEY = "xyi_google_calendar_granted";

let token = null;
let expiresAt = 0;

try {
  const saved = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || "null");
  if (saved?.token && saved.expiresAt > Date.now()) ({ token, expiresAt } = saved);
  else sessionStorage.removeItem(TOKEN_KEY);
} catch {
  // Unreadable or no storage: start signed out.
}

function forget() {
  token = null;
  expiresAt = 0;
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* nothing stored */ }
}

export const calendarConnected = () => !!token && Date.now() < expiresAt;

// Opens Google's sign-in window. Must be called from a click, or the browser
// blocks the popup.
export async function connectCalendar() {
  if (!CLIENT_ID) throw new GoogleError("not-configured");
  await loadGsi();
  let quiet = false;
  try { quiet = localStorage.getItem(GRANTED_KEY) === "1"; } catch { /* ask in full */ }
  const failed = (reason) => {
    if (quiet) try { localStorage.removeItem(GRANTED_KEY); } catch { /* nothing stored */ }
    return new GoogleError(reason);
  };
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: (res) => {
        if (res.error || !res.access_token) return reject(failed("denied"));
        // Google lets a person untick a permission on the consent screen.
        if (!window.google.accounts.oauth2.hasGrantedAllScopes(res, SCOPE)) return reject(failed("denied"));
        token = res.access_token;
        expiresAt = Date.now() + (Number(res.expires_in) - 60) * 1000;
        try {
          sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token, expiresAt }));
          localStorage.setItem(GRANTED_KEY, "1");
        } catch {
          // Storage off: the sign-in still works for this page view.
        }
        resolve();
      },
      error_callback: (err) => reject(failed(err?.type === "popup_closed" ? "cancelled" : "popup")),
    });
    client.requestAccessToken(quiet ? { prompt: "" } : {});
  });
}

// Every event touching the local day `date`, recurring ones as their own
// entries. Only the fields pickMeetings reads are asked for.
export async function fetchEventsForDay(date) {
  if (!calendarConnected()) throw new GoogleError("signed-out");
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const params = new URLSearchParams({
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "250",
    fields: "items(id,summary,status,eventType,start,end,attendees(self,resource,responseStatus))",
  });
  const res = await fetch(`${EVENTS}?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) { forget(); throw new GoogleError("signed-out", 401); }
  if (!res.ok) throw new GoogleError(res.status === 403 ? "no-access" : "failed", res.status);
  return (await res.json()).items || [];
}
