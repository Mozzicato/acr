# ACR Pitch Deck

## Slide 1 - ACR: Autonomous Customer Recovery

**When a banking transaction fails, ACR detects it, fixes what policy permits, and tells the customer before they call.**

**Subtitle:** From reactive complaints to proactive recovery

**Visual:** A simple before/after journey: *failed transfer -> customer calls* versus *failed transfer -> ACR recovers -> customer notified*.

**Speaker note:** Customer care should begin when the bank's systems show a problem, not when the customer is frustrated enough to complain.

---

## Slide 2 - The Problem: Customers Discover Failure First

- A customer sends money and is debited.
- The beneficiary does not receive it.
- The customer calls, visits a branch, repeats the story, and waits days.
- The bank already has the evidence: debit event, switch response, and destination-bank status.

**The gap:** those signals live in separate systems and no one acts until a complaint arrives.

**Visual:** A customer journey timeline ending in a support ticket and a long wait.

**Speaker note:** This is not a rare edge case. "Debited but not credited" is one of the most familiar and stressful banking failures.

---

## Slide 3 - The Opportunity: Recover Before the Complaint

| Today | With ACR |
| --- | --- |
| Customer complains | System detects the failed journey |
| Support investigates | ACR diagnoses across bank systems |
| Customer waits | Policy authorizes a safe action |
| Manual reversal | ACR acts, verifies, and notifies |

**Outcome:** fewer complaints, faster resolution, and confidence after a bad transaction.

**Speaker note:** The ambition is not a faster chatbot. It is removing the need for the support interaction in the first place.

---

## Slide 4 - The Product: ACR

**ACR is agentic customer-recovery infrastructure inside the bank's operations and mobile app.**

1. Detect a failed or stuck transaction.
2. Diagnose the likely cause using connected systems.
3. Decide what is safe under bank policy.
4. Act, verify the result, and inform the customer.
5. Escalate with the investigation prepared when a human is needed.

**Visual:** Screenshot of the operations console alongside the customer mobile experience.

**Speaker note:** The customer sees a clear outcome. The bank sees the complete trace, decision, and audit record behind it.

---

## Slide 5 - How It Works: Safe by Design

```text
Bank systems -> Journey engine -> Watchdog -> Investigation -> Planner -> Policy -> Action -> Verification -> Customer
```

- Deterministic rules identify high-risk, incomplete journeys.
- Read-only tools gather evidence from core banking, NIP, and biller systems.
- The planner can rank recovery options; it cannot invent or execute one.
- A rules-based policy engine is the final authority for every write action.

**Speaker note:** AI supports judgment, but policy controls money movement. This boundary is the core of the product.

---

## Slide 6 - A Live Example: Failed Transfer, Recovered

**Scenario: ₦85,000 transfer to a down bank**

1. Customer is debited; NIP returns code 91, a final failure.
2. ACR detects a debited-but-unconfirmed transaction.
3. It confirms the money never left the originating bank.
4. Policy approves a reversal.
5. ACR reverses the debit, verifies the balance, and sends: **"Your ₦85,000 is back."**

**Result:** no call, no ticket, no repeated explanation.

**Visual:** Use the live demo's agent trace and customer notification.

---

## Slide 7 - The Crucial Feature: Knowing When Not to Act

**Scenario: Transfer remains "in progress" at an unstable bank**

- The transfer could still complete.
- An immediate refund could create a double payment.
- ACR blocks the reversal and escalates with all evidence attached.

**Hard safety rules**

- Never reverse a transaction twice.
- Never refund an in-progress transfer automatically.
- Reversals above ₦1,000,000 require human approval.
- Every tool call and policy decision is audited.

**Speaker note:** Safe restraint is the difference between banking-grade automation and a naive bot.

---

## Slide 8 - Proof It Works Beyond the Demo

**2,000 simulated customer journeys. Same recovery engine, same policy.**

| Result | Evidence |
| --- | --- |
| Customer-visible failures detected | 308 of 308 |
| Resolved automatically | 200 |
| Double payments prevented | 49 |
| Duplicate reversals | 0 |
| Reconciliation drift | 0 |

**Ten safety invariants run with the stress test and in CI.**

**Speaker note:** The test deliberately includes transfers that appear stuck and later land. ACR refuses to pay twice in all 49 of those cases.

---

## Slide 9 - Built to Integrate, Not Replace

**ACR sits above existing bank infrastructure.**

- Core banking: balances, debits, and reversals
- NIP or payment switch: transaction status queries
- Biller gateways: payment confirmation and token delivery
- CRM and notifications: customer context and proactive updates
- Mobile app: transparent, in-context communication

**Prototype today:** external systems are simulators behind real APIs.

**Production path:** swap each simulator adapter for the bank's approved integration without rebuilding the recovery engine, policy, or audit layer.

---

## Slide 10 - The Ask

**Pilot ACR on failed interbank transfers.**

1. Connect read-only transaction and switch-status feeds.
2. Start with monitored detection and human-approved recoveries.
3. Enable policy-bounded autonomous reversals for final failures.
4. Expand to bills, cards, and other customer journeys.

**Closing line:** The best customer-support interaction is the one the customer never has to start.

**Visual:** Return to the customer notification: *"Your money is back."*

---

## Appendix - Anticipated Questions

| Question | Answer |
| --- | --- |
| Is this a chatbot? | No. The chat explains; ACR investigates, recovers, verifies, and audits. |
| What stops the AI from moving money incorrectly? | The AI only ranks predefined options. The policy engine validates facts and authorizes each write action. |
| What if money arrives after a refund? | ACR will not autonomously reverse an in-progress transfer; it escalates instead. |
| How does it connect to a real bank? | Through a tool layer. Replace the simulator adapters with approved core-banking, NIP, and biller integrations. |
| Is it already real? | The agent loop, policy, audit trail, and safety tests are real. The external bank systems in this hackathon prototype are simulated. |