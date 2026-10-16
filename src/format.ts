/** Formats a Unix timestamp (in seconds) as `DD/MM/YYYY, HH:mm` in `Asia/Shanghai`. */
export function formatTime(seconds: number): string {
  if (!seconds) return "";
  return new Date(seconds * 1000).toLocaleString("en-GB", {
    timeZone: "Asia/Shanghai",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Formats a Unix timestamp (in seconds) as a compact relative offset (`in 5h`, `in 3d`, `2h ago`). */
export function relativeTime(seconds: number): string {
  const hours = Math.round((seconds * 1000 - Date.now()) / 3_600_000);
  if (hours < 0) return `${-hours}h ago`;
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

export function failure(error: unknown): { content: [{ type: "text"; text: string }]; isError: true } {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}
