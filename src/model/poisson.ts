// Poisson machinery for the fair-price engine. Deterministic, no I/O.

const LOG_FACT: number[] = [0];
function logFactorial(k: number): number {
  for (let i = LOG_FACT.length; i <= k; i++) LOG_FACT.push(LOG_FACT[i - 1]! + Math.log(i));
  return LOG_FACT[k]!;
}

export function poissonPmf(lambda: number, k: number): number {
  if (k < 0 || !Number.isInteger(k)) return 0;
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return Math.exp(-lambda + k * Math.log(lambda) - logFactorial(k));
}

/** P(X > k) for X ~ Poisson(lambda). */
export function poissonSf(lambda: number, k: number): number {
  if (k < 0) return 1;
  let cdf = 0;
  for (let i = 0; i <= k; i++) cdf += poissonPmf(lambda, i);
  return Math.min(1, Math.max(0, 1 - cdf));
}

export function truncationK(lambda: number): number {
  return Math.min(80, Math.ceil(lambda + 10 * Math.sqrt(Math.max(lambda, 0.01)) + 15));
}

/**
 * Distribution of D = X1 - X2 for independent Poissons (goal-difference of the
 * REMAINING goals). Map d -> P(D = d), truncated where mass is negligible.
 */
export function marginDistribution(lambda1: number, lambda2: number): Map<number, number> {
  const K = Math.max(truncationK(lambda1), truncationK(lambda2));
  const p1: number[] = [];
  const p2: number[] = [];
  for (let i = 0; i <= K; i++) {
    p1.push(poissonPmf(lambda1, i));
    p2.push(poissonPmf(lambda2, i));
  }
  const dist = new Map<number, number>();
  for (let a = 0; a <= K; a++) {
    const pa = p1[a]!;
    if (pa < 1e-15) continue;
    for (let b = 0; b <= K; b++) {
      const p = pa * p2[b]!;
      if (p < 1e-15) continue;
      const d = a - b;
      dist.set(d, (dist.get(d) ?? 0) + p);
    }
  }
  return dist;
}
