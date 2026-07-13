export const formatTimerDisplay = (totalSeconds) => {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (num) => num.toString().padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
};

export const formatDurationText = (totalSeconds) => {
  if (totalSeconds === 0) return "0s";
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  let parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(" ");
};

export const getTimesheetValue = (totalSeconds) => {
  if (!totalSeconds || totalSeconds === 0) return "none";
  let rounded = Math.round((totalSeconds / 3600) * 2) / 2;
  if (rounded === 0 && totalSeconds > 0) rounded = 0.5;
  return rounded === 0 ? "none" : rounded.toFixed(1);
};

// Rounds to the nearest 30 min (0.5h), with a 30 min floor for any logged time.
// Used only at JSON-export time — the old timesheet website only accepts
// half-hour values. Supabase itself stores unrounded time.
export const roundToHalfHourSeconds = (s) =>
  s > 0 ? Math.max(1800, Math.round(s / 1800) * 1800) : 0;
