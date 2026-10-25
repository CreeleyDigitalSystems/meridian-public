export interface VisualCapabilities {
  devicePixelRatio: number;
  hardwareConcurrency: number;
  webgl: boolean;
  reducedMotion: boolean;
}

export interface QualityPolicy {
  mode: "canvas" | "fallback";
  dpr: 1 | 1.5 | 2;
  shadows: boolean;
  particles: "off" | "low" | "medium";
}

export function selectQualityPolicy(
  samples: readonly number[],
  capabilities: VisualCapabilities,
): QualityPolicy {
  if (!capabilities.webgl || capabilities.reducedMotion) {
    return { mode: "fallback", dpr: 1, shadows: false, particles: "off" };
  }

  const recent = samples.slice(-120);
  const averageFrameTime = recent.length === 0
    ? 16
    : recent.reduce((total, frameTime) => total + frameTime, 0) / recent.length;
  const sustainedSlowFrames = recent.length >= 60 && averageFrameTime >= 28;
  const constrained = capabilities.hardwareConcurrency <= 4 || sustainedSlowFrames;

  if (constrained) {
    return { mode: "canvas", dpr: 1, shadows: false, particles: "low" };
  }

  const dpr = capabilities.devicePixelRatio >= 2 ? 2 : capabilities.devicePixelRatio >= 1.5 ? 1.5 : 1;
  return {
    mode: "canvas",
    dpr,
    shadows: true,
    particles: "medium",
  };
}

export interface ResidentDetailBudget { near: number; mid: number }
/** Fixed pool capacities; quality changes detail only, never the population. */
export function residentDetailBudget(efficient: boolean): ResidentDetailBudget {
  return efficient ? {near: 4, mid: 12} : {near: 12, mid: 28};
}
