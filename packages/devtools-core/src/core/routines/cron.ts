/** Minimal 5-field cron parser (numbers, `*`, ranges, lists and steps; no names). */

export type ParsedCron = {
  ok: true;
  minute: number[];
  hour: number[];
  dom: number[];
  month: number[];
  /** 0 = Sunday (7 is folded into 0). */
  dow: number[];
  /** Which fields were written as a bare `*`. */
  star: { minute: boolean; hour: boolean; dom: boolean; month: boolean; dow: boolean };
};

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 }
] as const;

function parseField(text: string, min: number, max: number): number[] | string {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(\*|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/.exec(part);
    if (!m) return `"${part}" is not valid`;
    const step = m[4] === undefined ? 1 : Number(m[4]);
    if (step < 1 || step > max) return `step "${part}" is out of range`;
    let lo: number;
    let hi: number;
    if (m[1] === "*") {
      lo = min;
      hi = max;
    } else {
      lo = Number(m[2]);
      hi = m[3] === undefined ? (m[4] === undefined ? lo : max) : Number(m[3]);
    }
    if (lo < min || hi > max || lo > hi) return `"${part}" is out of range ${min}-${max}`;
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return [...values].sort((a, b) => a - b);
}

export function parseCron(expr: string): ParsedCron | { ok: false; error: string } {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return { ok: false, error: "must have exactly 5 fields (minute hour day-of-month month day-of-week)" };
  const parsed: number[][] = [];
  for (let i = 0; i < 5; i += 1) {
    const f = FIELDS[i]!;
    const r = parseField(parts[i]!, f.min, f.max);
    if (typeof r === "string") return { ok: false, error: `${f.name} field: ${r}` };
    parsed.push(r);
  }
  const dow = [...new Set(parsed[4]!.map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b);
  return {
    ok: true,
    minute: parsed[0]!,
    hour: parsed[1]!,
    dom: parsed[2]!,
    month: parsed[3]!,
    dow,
    star: {
      minute: parts[0] === "*",
      hour: parts[1] === "*",
      dom: parts[2] === "*",
      month: parts[3] === "*",
      dow: parts[4] === "*"
    }
  };
}

/** Smallest gap in minutes between two firings (Infinity when it fires at most once per day). */
export function minimumMinuteGap(cron: ParsedCron): number {
  if (cron.minute.length > 1) return minGap(cron.minute, 60);
  return cron.star.hour ? 60 : Number.POSITIVE_INFINITY;
}

function minGap(values: number[], period: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < values.length; i += 1) {
    const next = values[(i + 1) % values.length]!;
    const gap = (next - values[i]! + period) % period || period;
    best = Math.min(best, gap);
  }
  return best;
}
