import { describe, expect, it } from 'vitest';
import { runStressSync } from './stress.js';

describe('stress test', () => {
  it('holds every safety invariant across 1,500 random journeys', { timeout: 180_000 }, () => {
    const report = runStressSync({ journeys: 1_500, failureRate: 0.2, seed: 2026 });
    for (const inv of report.invariants) expect(inv, `${inv.name}: ${inv.detail}`).toMatchObject({ passed: true });
    const c = report.counts;
    expect(c.faultsInjected).toBeGreaterThan(200);
    expect(c.detected).toBe(c.customerVisible);
    expect(c.autoRecovered + c.escalated + c.heldForApproval).toBe(c.detected);
    expect(c.doublePaysAvoided).toBeGreaterThan(0);
  });

  it('is reproducible from its seed', { timeout: 60_000 }, () => {
    const a = runStressSync({ journeys: 300, failureRate: 0.2, seed: 7 });
    const b = runStressSync({ journeys: 300, failureRate: 0.2, seed: 7 });
    expect(a.counts).toEqual(b.counts);
  });
});
