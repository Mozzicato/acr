import { describe, expect, it } from 'vitest';
import { MAX_CHAT_CHARS, MAX_CHAT_MESSAGES, buildSupportMessages, fallbackSupportReply, parseAdvice, type AgentBriefing, type SupportContext } from './advisor.js';

const briefing = {
  options: [{ action: 'reverse_transfer' }, { action: 'human_review' }],
} as unknown as AgentBriefing;

describe('parseAdvice', () => {
  it('accepts well-formed advice and clamps confidence', () => {
    const advice = parseAdvice(JSON.stringify({ diagnosis: 'd', selectedAction: 'reverse_transfer', rationale: 'r', confidence: 3 }), briefing);
    expect(advice).toMatchObject({ selectedAction: 'reverse_transfer', confidence: 1 });
  });

  it('rejects actions that were never proposed, and malformed output', () => {
    expect(parseAdvice({ diagnosis: 'd', selectedAction: 'send_money_abroad', rationale: 'r', confidence: 0.5 }, briefing)).toBeNull();
    expect(parseAdvice('not json', briefing)).toBeNull();
    expect(parseAdvice({ selectedAction: 'human_review' }, briefing)).toBeNull();
  });
});

describe('support assistant', () => {
  const context: SupportContext = {
    bank: 'NovaBank',
    customerName: 'Adaeze Okafor',
    balance: '₦497,300',
    recentTransactions: [],
    issue: { what: 'your transfer to Tunde', status: 'resolved', whatAcrDid: 'We reversed your ₦85,000.', messageSent: null },
  };

  it('grounds the prompt in the account context and caps the history', () => {
    const history = Array.from({ length: 30 }, (_, i) => ({ role: 'customer' as const, text: `q${i}`.padEnd(900, '.') }));
    const messages = buildSupportMessages(context, history);
    expect(messages[0].content).toContain('NovaBank');
    expect(messages[0].content).toContain('Never ask for a PIN');
    expect(messages[0].content).toContain('We reversed your ₦85,000.');
    expect(messages).toHaveLength(MAX_CHAT_MESSAGES + 1);
    expect(messages[1].content.length).toBe(MAX_CHAT_CHARS);
  });

  it('falls back to what ACR recorded when the LLM is unavailable', () => {
    expect(fallbackSupportReply(context)).toContain('We reversed your ₦85,000.');
    expect(fallbackSupportReply({ ...context, issue: null })).toContain('₦497,300');
  });
});
