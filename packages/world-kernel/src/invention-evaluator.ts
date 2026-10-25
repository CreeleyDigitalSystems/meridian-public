import { AssemblyEnvelopeSchema, InventionDesignInputSchema, type InventionDesignInput, type AssemblyEnvelope } from '@meridian/world-schema';
export type AssemblyResult<T> = {
  ok: true;
  value: T;
} | {
  ok: false;
  reason: string;
};
const fail = (reason: string): AssemblyResult<never> => ({
  ok: false,
  reason
});
export function deriveAssemblyDesign(raw: unknown): AssemblyResult<{
  bom: {
    timber: number;
    stone: number;
  };
  buildMinutes: number;
}> {
  const parsed = InventionDesignInputSchema.safeParse(raw);
  if (!parsed.success) return fail('invalid grammar');
  const {
      parts
    } = parsed.data,
    masses = parts.map(p => p.k === 'base' || p.k === 'support' ? 4 : 1),
    carried = parts.map(() => 0),
    cells = new Set<string>();
  let stone = 0,
    timber = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.n !== i || cells.has(`${p.x}:${p.y}`)) return fail('duplicate cell or noncontiguous part');
    cells.add(`${p.x}:${p.y}`);
    if (i === 0 ? p.k !== 'base' || p.parent !== null : p.k === 'base' || p.parent === null || p.parent >= i) return fail('unsupported graph');
    if (i > 0) {
      const parent = parts[p.parent!]!;
      if (Math.abs(parent.x - p.x) + Math.abs(parent.y - p.y) !== 1) return fail('nonadjacent parent');
    }
    if (p.k === 'base' || p.k === 'support') stone++;else timber++;
  }
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]!,
      capacity = p.k === 'base' ? 8 : p.k === 'support' ? 6 : 2;
    if (carried[i]! > capacity) return fail('overloaded subtree');
    if (p.parent !== null) carried[p.parent]! += masses[i]! + carried[i]!;
  }
  const buildMinutes = 2 + 2 * parts.length + parts.reduce((n, p) => n + (p.k === 'support' ? carried[p.n]! : 0), 0);
  return buildMinutes > 32 ? fail('build bound') : {
    ok: true,
    value: {
      bom: {
        stone,
        timber
      },
      buildMinutes
    }
  };
}
export function evaluateAssembly(design: unknown | null, rawEnvelope: unknown, skill: number, condition: number): AssemblyResult<{
  quality: number;
  duration: number;
  passed: boolean;
}> {
  const parsed = AssemblyEnvelopeSchema.safeParse(rawEnvelope);
  if (!parsed.success || !Number.isSafeInteger(skill) || skill < 0 || skill > 100 || !Number.isSafeInteger(condition) || condition < 0 || condition > 100) return fail('invalid evaluator inputs');
  if (design !== null && !deriveAssemblyDesign(design).ok) return fail('invalid design');
  const envelope: AssemblyEnvelope = parsed.data,
    parts = design === null ? [] : (design as InventionDesignInput).parts;
  const effective = (kind: string, max: number, axis = false) => Math.floor(Math.min(max, parts.filter(p => p.k === kind && (!axis || p.r === envelope.axis)).length) * (design === null ? 100 : condition) / 100);
  const g = effective('guide', 2, true),
    h = effective('clamp', 2, true),
    t = effective('tray', 1),
    s = effective('support', 2),
    extra = Math.max(0, parts.length - 4);
  const quality = Math.max(0, Math.min(100, 60 + Math.floor(skill / 5) + 5 * g + 7 * h + 2 * s - 5 * envelope.load - 2 * extra));
  const duration = Math.max(2, Math.min(16, envelope.nominalMinutes + Math.ceil(envelope.pieces / 2) + Math.max(0, envelope.load - s) - g - h - t + extra));
  return {
    ok: true,
    value: {
      quality,
      duration,
      passed: quality >= envelope.precision
    }
  };
}
