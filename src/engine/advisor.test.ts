import { describe, expect, it } from 'vitest';
import { parseAdvice, type AgentBriefing } from './advisor';

const briefing = {
  options: [{ action: 'reassign_courier' }, { action: 'human_review' }],
} as unknown as AgentBriefing;

describe('parseAdvice', () => {
  it('accepts well-formed advice and clamps confidence', () => {
    const advice = parseAdvice(JSON.stringify({ diagnosis: 'd', selectedAction: 'reassign_courier', rationale: 'r', confidence: 3 }), briefing);
    expect(advice).toMatchObject({ selectedAction: 'reassign_courier', confidence: 1 });
  });

  it('rejects actions that were never proposed, and malformed output', () => {
    expect(parseAdvice({ diagnosis: 'd', selectedAction: 'issue_credit', rationale: 'r', confidence: 0.5 }, briefing)).toBeNull();
    expect(parseAdvice('not json', briefing)).toBeNull();
    expect(parseAdvice({ selectedAction: 'human_review' }, briefing)).toBeNull();
  });
});
