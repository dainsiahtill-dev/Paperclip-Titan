import { v3t } from "@/i18n";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

export function timeAgo(date: Date | string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const seconds = Math.round((now - then) / 1000);

  if (seconds < MINUTE) return v3t("relativeTime.now");
  if (seconds < HOUR) {
    const m = Math.floor(seconds / MINUTE);
    return v3t("relativeTime.minutes", { count: m });
  }
  if (seconds < DAY) {
    const h = Math.floor(seconds / HOUR);
    return v3t("relativeTime.hours", { count: h });
  }
  if (seconds < WEEK) {
    const d = Math.floor(seconds / DAY);
    return v3t("relativeTime.days", { count: d });
  }
  if (seconds < MONTH) {
    const w = Math.floor(seconds / WEEK);
    return v3t("relativeTime.weeks", { count: w });
  }
  const mo = Math.floor(seconds / MONTH);
  return v3t("relativeTime.months", { count: mo });
}
