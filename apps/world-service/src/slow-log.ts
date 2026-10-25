/**
 * Diagnostic timing for the live service. Writes one JSON line to stdout when an operation takes longer
 * than SLOW_MILLISECONDS, with the time spent in each named phase. Never logs request bodies, world
 * state or environment values — only labels, phase names and milliseconds.
 */
export const SLOW_MILLISECONDS = 250;

export interface SlowTimer {
  /** Records the time since the previous lap (or the start) under `phase`. */
  lap(phase: string): void;
  /** Ends the timer; logs when the total exceeds the threshold. */
  done(details?: Readonly<Record<string, string | number>>): void;
}

export function slowTimer(label: string, write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): SlowTimer {
  const start = performance.now();
  let last = start;
  const phases: Record<string, number> = {};
  return {
    lap(phase) {
      const now = performance.now();
      phases[phase] = (phases[phase] ?? 0) + Math.round(now - last);
      last = now;
    },
    done(details = {}) {
      const total = Math.round(performance.now() - start);
      if (total <= SLOW_MILLISECONDS) return;
      write(JSON.stringify({ slow: label, ms: total, phases, ...details, at: new Date().toISOString() }));
    },
  };
}
