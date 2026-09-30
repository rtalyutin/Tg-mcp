import { Temporal } from "@js-temporal/polyfill";
import type { z } from "zod";
import { scheduleSchema } from "./contracts.js";
export type Schedule = z.infer<typeof scheduleSchema>;
export function nextSlot(
  schedule: Schedule,
  timezone: string,
  after: Date,
): { at: Date; skipped_dst: boolean } {
  const ms = after.getTime();
  if (schedule.type === "interval") {
    const anchor = Date.parse(schedule.anchor_at_utc),
      step = schedule.minutes * 60000;
    return {
      at: new Date(
        anchor + Math.max(0, Math.floor((ms - anchor) / step) + 1) * step,
      ),
      skipped_dst: false,
    };
  }
  const base = Temporal.Instant.fromEpochMilliseconds(ms)
    .toZonedDateTimeISO(timezone)
    .toPlainDate();
  const [hour, minute] = schedule.time.split(":").map(Number);
  for (let i = 0; i < 15; i++) {
    const date = base.add({ days: i });
    if (schedule.type === "weekly" && !schedule.days.includes(date.dayOfWeek))
      continue;
    const local = date.toPlainDateTime({ hour: hour!, minute: minute! });
    const early = local.toZonedDateTime(timezone, {
      disambiguation: "earlier",
    });
    const gap = !early.toPlainDateTime().equals(local);
    const actual = gap
      ? local.toZonedDateTime(timezone, { disambiguation: "later" })
      : early;
    if (actual.epochMilliseconds > ms)
      return { at: new Date(actual.epochMilliseconds), skipped_dst: gap };
  }
  throw new Error("invalid_schedule");
}
