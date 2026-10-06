# ACR — Autonomous Customer Recovery

### One-line product definition

> **ACR detects when a bank customer's transaction has gone wrong, identifies the root cause, takes authorized corrective action across the bank's systems, and tells the customer in their app, before they have to call.**

The key shift is:

**Traditional customer care:** Customer complains → bank investigates → bank responds.
**ACR:** System detects failure → agent investigates → policy authorizes → system fixes it → customer is informed.

ACR is **agentic customer-care infrastructure**, not another chatbot. It plugs into the bank's systems and lives inside the bank's mobile app.

---

# PRD — Autonomous Customer Recovery

## 1. Product Overview

**Product:** ACR
**Full name:** Autonomous Customer Recovery
**Category:** Agentic AI / Customer Experience Infrastructure for banks
**Primary users:** Retail banks and their customers. First deployment target: the bank's mobile app (built as a prototype for the Ecobank hackathon).

### Problem

Most bank customer care is **reactive**.

A customer:

1. Sends a transfer.
2. Their account is debited.
3. The money never arrives.
4. They wait, then call or visit a branch.
5. They explain what happened.
6. Support logs a complaint and investigates.
7. Support contacts another bank or the switch.
8. The customer waits again, often days.
9. Eventually the money is reversed.

The bank already has the signals needed to spot the problem **before the customer complains**: the debit, the interbank (NIP) response code, the other bank's status. They just sit in different systems.

For example:

```text
Customer sends ₦85,000 to another bank
        ↓
Account debited
        ↓
NIP returns 91: beneficiary bank not available
        ↓
Money is still with us, but the customer sees it as gone
        ↓
Customer is about to call support
```

A traditional system waits for:

> "I was debited but the money didn't get there!!!"

ACR acts before that happens.

---

# 2. Vision

Build an autonomous layer between a bank's operational systems and its customers that continuously asks:

> **"Is this customer's transaction going wrong, and what can I safely do about it?"**

The system should move from:

**Detect → Notify**

to:

**Detect → Diagnose → Decide → Act → Verify → Recover → Learn**

---

# 3. Goals

### Primary goals

ACR should:

* Detect failed or stuck transactions.
* Catch them before they become complaints.
* Identify the likely root cause.
* Determine the appropriate recovery action.
* Execute authorized actions automatically.
* Communicate with the customer in their app.
* Answer the customer's questions with full knowledge of what happened.
* Escalate when human judgment is required.
* Learn from successful and failed recoveries.

### Success metric

The primary metric isn't chatbot response time.

It's:

> **Customer problems resolved without the customer having to ask, and never at the cost of paying anyone twice.**

---

# 4. Non-Goals

ACR is **not**:

* A generic customer-service chatbot.
* A simple FAQ bot.
* A sentiment-analysis tool.
* A ticketing system.
* A CRM.
* A replacement for every human support agent.
* A core banking system or a payment switch.

The AI agent sits **on top of existing banking infrastructure** and orchestrates recovery.

---

# 5. Target Users

## Bank

Initial target:

### Retail banking: failed transfers and bill payments

Because "debited but not credited" is the complaint every bank customer knows, and the fix is well defined.

Example:

```text
Customer sends money to another bank
        ↓
Account debited
        ↓
Other bank is down, NIP returns a final failure
        ↓
ACR detects the stuck debit
        ↓
ACR queries NIP and the other bank's status
        ↓
Confirms the money never left
        ↓
Reverses the debit
        ↓
Verifies the balance is restored
        ↓
Tells the customer in the app
```

The customer never needs to contact support.

## Customer

The bank's mobile app users. They see ACR in two places:

* **Proactive messages:** "Your ₦85,000 is back", with a plain timeline of what happened.
* **In-app support:** an assistant that already knows their account and what ACR did, so they never have to explain.

---

# 6. Core Concept: Customer Journey

This is one of the most important technical/product concepts.

ACR shouldn't think of a customer as:

> customer_id = 48291

It should understand their **journey**.

For example:

```text
Customer
   │
   ├── Account
   │     ├── Transfer ──── NIP session ── Beneficiary bank
   │     ├── Bill payment ── Biller vend ── Token
   │     ├── Reversals
   │     └── Notifications
   │
   └── Previous complaints
```

Each journey has:

* customer
* transaction
* what the customer expected
* current state
* deadline (detection window)
* dependencies (switch, other bank, biller)
* failures
* previous interactions
* recovery actions

---

# 7. Core Architecture

```text
                  BANK SYSTEMS
 ┌─────────────────────────────────────────┐
 │ Core banking │ NIP switch │ Biller gateway│
 │ CRM          │ Notifications              │
 └────────────────────┬────────────────────┘
                      │
                      ▼
             ┌─────────────────┐
             │ JOURNEY ENGINE   │
             │ Current state    │
             │ Expected state   │
             └────────┬────────┘
                      │
                      ▼
             ┌─────────────────┐
             │ WATCHDOG         │  deterministic detection rules
             └────────┬────────┘
                      │
                      ▼
             ┌─────────────────┐
             │ PLAYBOOK         │  investigate through read-only tools
             └────────┬────────┘
                      │
                      ▼
             ┌─────────────────┐
             │ LLM PLANNER      │  ranks options it's given
             └────────┬────────┘
                      │
                      ▼
             ┌─────────────────┐
             │ POLICY ENGINE    │  final authority
             └────────┬────────┘
                      │
             ┌────────┴─────────┐
             ▼                  ▼
      Bank systems         Mobile app
             │                  │
             ▼                  ▼
        TAKE ACTION       INFORM CUSTOMER
             │
             ▼
        VERIFY OUTCOME
             │
             ▼
          LEARN
```

---

# 8. The Agentic Loop

This is the heart of the product.

### Step 1 — Detect

A watchdog sweeps for debits that haven't produced what the customer paid for.

```json
{
  "customer": "C201",
  "transaction": "NIP2610040001",
  "type": "nip_transfer",
  "amount": 85000,
  "beneficiary_bank": "Lagoon Bank",
  "nip_response": "91",
  "debited_at": "2026-10-04T13:00:00+01:00"
}
```

---

### Step 2 — Assess risk

The system asks:

> Is this a blip, or a customer about to complain?

For example:

```text
Debit posted, not confirmed after: 10 min
NIP response: 91
Amount: ≥ ₦50,000
Customer tier: premier
Earlier failed transfers: 2

Risk = CRITICAL (99%)
```

Detection is **rule-based** (`DR-TRANSFER-01`, `DR-BILL-01`), not a trained model.

---

### Step 3 — Diagnose

The playbook investigates through read-only tools:

```text
get_transaction
↓
get_account
↓
nip_status_query
↓
get_bank_status
↓
get_customer + search_support_history
```

And determines:

> Lagoon Bank was down, so NIP rejected the transfer (code 91) after the debit posted. The money is still with us, but the customer's balance shows it as gone.

---

### Step 4 — Plan

The agent proposes options:

```text
Option A: Reverse ₦85,000 to the customer.
Option B: Resend when Lagoon Bank recovers.
Option C: Add a ₦1,000 goodwill credit.
Option D: Escalate to a human agent.
```

The LLM ranks them using the evidence. It can only choose among these options.

---

### Step 5 — Decide

The **policy engine** checks the facts itself, from the systems of record, and decides:

```text
Reverse          → PERMITTED  (NIP failure is final, not reversed yet)
Resend           → BLOCKED    (resending money needs the customer's say-so)
Goodwill credit  → BLOCKED    (moves the bank's money, Level 3)
Escalate         → PERMITTED  (always)
```

If the LLM picks a blocked option, policy overrides it, and the trace says so.

---

### Step 6 — Act

```text
post_reversal(NIP2610040001)
```

---

### Step 7 — Verify

This is critical. ACR doesn't assume the action worked.

```text
Transfer marked reversed?
       ↓
YES
       ↓
Balance back to ₦497,300?
       ↓
YES
       ↓
Notify the customer
```

---

### Step 8 — Recover

The customer's app shows:

> "Your ₦85,000 is back. Your transfer to Tunde Adeyemi (Lagoon Bank) didn't go through because Lagoon Bank was unavailable. We've returned the full amount. You can send it again once Lagoon Bank is back. You don't need to contact us."

No complaint.

No phone call.

No waiting.

---

### Step 9 — Learn

ACR records:

```text
Failure:            Transfer debited, not credited
Action:             reverse_transfer
Outcome:            Successful
Cost to bank:       ₦0
Complaint avoided:  YES
```

---

# 9. MVP

For a hackathon, **do NOT build the entire platform**.

Build a vertical slice convincing enough that people can use it themselves.

## MVP boundary

The MVP is a **working prototype of ACR inside a bank's mobile app**, with simulated bank systems behind real APIs.

In the MVP:

* Core banking, the NIP switch and the biller are simulators. The agent, policy engine, safety checks and audit trail are real.
* Detection is deterministic, using explicit time-window rules.
* Recovery policy and authorization are deterministic and auditable.
* The LLM may summarize evidence and choose among policy-permitted options. It cannot invent actions, bypass policy, or call bank systems directly.
* Learning is represented by recording recovery outcomes. Model training is out of scope.
* Reversing a debit whose failure is **confirmed final** is in scope. It returns the customer's own money and costs the bank nothing. Credits, compensation and anything over ₦1,000,000 still need a human.

Out of scope for the MVP:

* Real integrations with core banking, NIBSS or billers.
* Multi-bank onboarding.
* Goodwill credits, compensation, account changes.
* ML-based failure prediction claims.

## MVP use cases

1. **Transfer debited but not credited.** Final NIP failure → automatic reversal. "In progress" → never refund, since the money may still land; escalate to a human.
2. **Electricity token paid for but not delivered.** Biller confirms the token was vended → deliver it in-app, and no money moves. Biller doesn't answer → escalate.

## Proof that it works

* **Live:** anyone scans a QR code, opens the bank app on their own phone, and sends money. The presenter sets banks to Up, Down or Unstable, and ACR handles whatever happens in real time.
* **At scale:** a seeded stress test runs thousands of random journeys with injected faults and checks ten safety invariants on every run, including in CI.

---

# 10. Demo Scenario

This is where the idea becomes powerful.

### Normal

```text
A judge scans the QR code and opens a demo account (₦500,000).
They send ₦20,000 to Crest Bank.
It arrives. ACR stays out of the way.
```

Then the presenter sets **Harbor Bank → Down**.

```text
13:07:21  Judge sends ₦75,000 to Harbor Bank.
13:07:21  Account debited.
13:07:21  "This didn't go through."
```

Normally:

> The customer starts calling.

ACR detects:

```text
Debit posted
+
NIP 91, not confirmed after 20 s
+
Customer can see the debit
=
HIGH RISK
```

The agent investigates:

```text
NIP status query → 91, final
Harbor Bank      → down
Reversal         → permitted by TRANSFER-REVERSAL-01
```

ACR executes:

```text
Reverse ₦75,000 → verify balance → notify
```

About 20 seconds after the failure, the judge's phone shows:

> "Your ₦75,000 is back."

Then the presenter sets the bank to **Unstable** ("in progress"). This time ACR **refuses** to refund, because the money might still land, and hands the case to a human. That shows judgment, not just automation.

The judge opens Help and asks: "Did Tunde get my money?" The assistant answers from their actual account.

Detection windows are 20 s (transfers) and 15 s (bills) on stage. Production would use 10 and 5 minutes, which is what the stress test uses.

## MVP acceptance criteria

The MVP is complete when:

1. A customer can open an account, transfer to another bank and buy a token from their own phone. ✅
2. A failed debit moves the journey from healthy to at risk, with the rule and evidence shown. ✅
3. The investigation trace shows the transaction, account, NIP status, bank status and customer history. ✅
4. Policy authorizes a reversal only when the NIP failure is final, and never twice. ✅
5. ACR executes, verifies the restored balance, notifies the customer in-app, and records the outcome, with no complaint ticket. ✅
6. The support assistant answers from the customer's real account and cannot move money. ✅
7. The stress test passes all safety invariants across thousands of random journeys. ✅

---

# 11. Human-in-the-Loop

ACR should **not** be allowed to do everything on its own.

### Level 0 — Observe

ACR detects and investigates, then recommends. It takes no action.

### Level 1 — Recommend

ACR proposes the action. An operator approves or rejects it.

### Level 2 — Low-risk autonomous

ACR executes predefined actions on its own:

* reverse a transfer whose NIP failure is final (up to ₦1,000,000)
* deliver a token the biller confirms it vended
* send the customer a notification

### Level 3 — High-risk (always human)

* reversals over ₦1,000,000
* goodwill credits and compensation
* anything where the status is unclear ("in progress", biller not answering)
* account changes

---

# 12. Agent Tools

The agent's tools:

```text
Read
  get_customer()
  get_account()
  get_transaction()
  nip_status_query()
  get_bank_status()
  biller_requery()
  search_support_history()

Write (need a policy decision)
  post_reversal()
  deliver_token()
  send_notification()
```

The LLM isn't connected to any of them directly:

```text
LLM
 ↓
Playbook
 ↓
Tool layer
 ↓
Permission layer
 ↓
Bank systems
```

Every tool call produces an audit record: incident ID, input, output, timestamp and actor. A write tool runs only with a policy decision for **that exact incident and transaction**.

---

# 13. Recovery Policy Engine

Don't let the LLM make banking decisions.

Use deterministic policies around the agent:

```yaml
TRANSFER-REVERSAL-01:
  allow reverse_transfer when:
    debit_posted
    and nip_status is final (not "09 in progress")
    and not already reversed
  needs operator when amount > ₦1,000,000

TRANSFER-RETRY-01:
  never resend money without the customer's say-so

BILL-REDELIVER-01:
  allow redeliver_token when biller confirms a vended token not yet delivered

BILL-REVERSAL-01:
  allow reverse_bill_payment only when biller confirms the vend failed

FINANCIAL-HOLD-01:
  goodwill credits need Level 3 human approval

ESCALATE-01:
  human_review is always permitted
```

The AI handles:

**reasoning + investigation + explanation**

The policy engine handles:

**authorization + limits + safety**

The policy engine is the final authority. An action runs only if it matches a named policy, its evidence holds in the systems of record, and the autonomy level permits it.

---

# 14. Data Model

### Customer

```text
Customer
├── id
├── tier
├── account_number
├── preferences (channel)
└── history (failed transactions, complaints)
```

### Account

```text
Account
├── number
├── customer_id
├── balance
└── status
```

### Transaction

```text
Transaction
├── id
├── type (nip_transfer, bill_payment, card, inflow, reversal)
├── amount, direction
├── status (pending, successful, failed, reversed)
├── beneficiary | bill
└── reverses (for a reversal)
```

### Journey

```text
Journey
├── id
├── customer_id
├── transaction_id
├── objective
├── current_state
├── expected_state
├── deadline
└── health_score
```

### Event

```text
Event
├── id
├── journey_id
├── timestamp
├── type
└── payload
```

### Incident

```text
Incident
├── id
├── journey_id
├── kind
├── severity, risk
├── rule + signals
├── cause, confidence
├── agent assessment
├── status
└── resolution
```

### Recovery

```text
Recovery
├── incident_id
├── proposed_action
├── actual_action
├── cost
├── outcome
└── customer_impact
```

---

# 15. Operations Console

The bank's console shows:

* **Be the customer:** a QR code to the mobile app.
* **Network conditions:** each other bank Up / Down / Unstable; the biller Up / Token stuck / No answer.
* **KPIs:** journeys, healthy, at risk, critical, with an agent, autonomous recovery rate, escalation rate, time to recovery, customer effort.
* **The affected customer's app, live**, embedded next to the incident.
* **Incident, recovery plan and policy decision, outcome, journey timeline.**
* **Agent trace** and **audit trail.**
* **Stress test** tab.

---

# 16. Agent Trace

For the demo, this is extremely important:

```text
DETECT · INC-0001
Watchdog: NIP2610060001 not confirmed after 20 s
Rule DR-TRANSFER-01 fired: HIGH risk (85%)

INVESTIGATE
✓ Debit posted
✗ NIP status query: 91 Beneficiary bank not available (final)
! Harbor Bank is down
Root cause identified (96% confidence)

PLAN
Evaluating 4 recovery options
Agent reasoning (gpt-oss-120b · 1.4s)

DECIDE
! TRANSFER-RETRY-01 blocked retry_transfer
! FINANCIAL-HOLD-01 blocked goodwill_credit
✓ ACTION APPROVED (TRANSFER-REVERSAL-01)

ACT
✓ ₦75,000 reversed

VERIFY
✓ Transfer marked reversed
✓ Balance restored

NOTIFY
✓ Customer notified in-app

RECOVERY COMPLETE
```

This makes the **agentic** part visible to judges.

---

# 17. Tech Stack

What the prototype uses:

### Frontend

```text
React + TypeScript (Vite)
Operations console  →  /
Customer mobile app →  /app/
```

### Backend

```text
One API router on Web Request/Response
Vercel function in production, Vite middleware in development
```

### State

```text
Upstash Redis on Vercel (shared across serverless instances, with a lock)
In-memory locally
```

### Agent

```text
Groq · openai/gpt-oss-120b
structured outputs (strict JSON schema)
the LLM ranks options; it never calls tools
```

### Bank systems (simulated)

```text
Core banking
NIP switch with transaction status query
Biller gateway with requery
CRM
Notifications
```

### Testing

```text
Vitest engine tests
Seeded stress test with ten safety invariants (runs in CI and in the console)
```

---

# 18. The Most Important Technical Principle

**Don't build an AI that talks about problems.**

Build an AI that **does things about problems, safely.**

Bad:

> "We're sorry for the inconvenience. Your complaint has been logged. Reversals take 24 to 72 hours."

Better:

> "Your transfer didn't go through because the other bank was down. We've already returned your ₦85,000. Your balance is ₦497,300."

And just as important: knowing **when not to act**. If the switch says "in progress", the money may still land. Refunding would pay twice. ACR waits and hands it to a human.

That's the difference between a chatbot and an **agent**.

---

# 19. Business Model

ACR can be sold to banks as infrastructure.

### SaaS

```text
Platform fee
+
usage per 1,000 monitored transactions
```

The stronger proposition:

> **Pay us based on complaints avoided and recoveries completed.**

Each avoided complaint saves call-centre time, branch visits and dispute handling, and keeps a customer who might otherwise leave. That aligns incentives.

---

# 20. Core Metrics

The strongest KPI is:

### Autonomous Recovery Rate

$$
ARR =
\frac{Failures\ recovered\ without\ customer\ complaint}
{Total\ failed\ transactions}
$$

Other metrics:

### Complaint Prevention Rate

$$
CPR =
\frac{Failures\ resolved\ before\ complaint}
{Total\ detected\ failures}
$$

### Human Escalation Rate

$$
HER =
\frac{Incidents\ requiring\ human}
{Total\ incidents}
$$

### Mean Time to Recovery

$$
MTTR = RecoveryTime - FailureDetectionTime
$$

### Double Payment Rate

Must always be zero. Checked on every stress-test run.

$$
DPR = 0
$$

### Customer Effort

Number of customer actions required to resolve an incident.

The ultimate target:

$$
Customer\ Effort \rightarrow 0
$$

---

# 21. The Killer Pitch

> **Today, bank customer care starts when the customer complains.**
>
> **We're building ACR, the autonomous customer recovery layer that starts when the bank's own systems show something has gone wrong.**
>
> ACR watches every transaction, catches failed and stuck debits before customers notice, investigates the cause, and takes action that policy authorizes. And it knows when *not* to act.
>
> Instead of:
>
> **Debit → Complaint → Ticket → Investigation → Reversal days later**
>
> we create:
>
> **Debit → Detection → Safe recovery → "Your money is back" in seconds.**
>
> We're not building another chatbot.
>
> **We're building customer care that doesn't wait for the customer.**

### And the strongest closing line:

> **The best customer support interaction is the one the customer never has to start.**
