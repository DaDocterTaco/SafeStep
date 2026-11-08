import type { ReviewData, Observation } from '@safestep/contracts';
let remembered: { at: string; count: number; observations: Observation[] } | null = null;
export function rememberCleanup(d: ReviewData | null, count: number) {
  if (d) {
    const items = [...(remembered?.observations ?? []), ...d.observations];
    remembered = {
      at: remembered?.at ?? d.at,
      count,
      observations: items
        .filter((x, i) => items.findIndex((y) => y.code === x.code && y.detail === x.detail) === i)
        .slice(0, 16),
    };
  } else if (remembered) remembered.count = count;
}
export function cleanupMemory() {
  return remembered;
}
export function resetCleanupMemory() {
  remembered = null;
}
