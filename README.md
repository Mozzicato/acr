# ACR: Autonomous Customer Recovery for banks

ACR plugs into a bank's systems and its mobile app. When a customer's transaction goes wrong, ACR spots it, finds the cause, fixes what policy allows it to fix, and tells the customer in the app, before they have to call or open a ticket. When the customer does ask, the in-app support assistant already knows what happened.

This repo is a working demo built on a fictional bank, **NovaBank**. Every bank, biller and customer in it is made up.

## Run it

```bash
npm install
cp .env.example .env    # then add your GROQ_API_KEY (optional)
npm run dev             # http://localhost:5173
npm test                # engine tests
```

Without a `GROQ_API_KEY`, everything still runs. The planner falls back to rules (the **Rules** toggle) and the support chat answers from what ACR recorded.

## Demo script

Click **Play full demo**, or walk through it by hand:

1. **Transfer debited but not credited.** Adaeze sends ₦85,000 to Lagoon Bank. Her account is debited, but the money never lands. Ten minutes later the rule `DR-TRANSFER-01` fires.
2. ACR investigates: the transaction, the account, an **NIP status query** (code 91, a final failure) and Lagoon Bank's status (down).
3. The LLM (Groq `openai/gpt-oss-120b`) diagnoses the problem and picks a recovery. The **policy engine** re-checks the facts itself and has the final say. It blocks retrying the transfer (that needs the customer's say-so) and the goodwill credit (that moves the bank's money).
4. ACR **reverses the ₦85,000**. It then verifies that the transfer is marked reversed and the balance is restored, and pushes "Your ₦85,000 is back" to her app.
5. In the phone mock, ask the support chat something like *"Did Tunde get the money?"*. It answers from what ACR knows. It can't move money, and it never asks for a PIN.
6. **Electricity token not delivered.** Bola pays ₦20,000 for a Lumen Power token, which never arrives. The biller confirms a token was vended, so ACR delivers it in-app and no money moves. Policy blocks a reversal here, because she already got what she paid for.

Try the other paths:
- **Constrained scenario**: the NIP status is still "in progress" (code 09), and the biller doesn't answer. Reversing could pay twice, so policy blocks it and both incidents go to a human agent with the full investigation.
- **L1 Recommend**: ACR proposes the fix and an operator approves or rejects it. **L0 Observe**: ACR only detects and recommends.
- Reversals above **₦1,000,000** always need an operator, even at L2.

## How it's built

```
src/engine/            pure TypeScript, no UI, fully tested
  systems.ts           mocked core banking, NIP switch (status query), biller gateway, CRM, notifications
  seed.ts              NovaBank customers, accounts, history and demo journeys
  detection.ts         deterministic rules: DR-TRANSFER-01, DR-BILL-01 (no ML claims)
  playbooks/           one per failure: simulate, investigate, propose, execute, verify
                       (transfer.ts: debited not credited · billToken.ts: token not delivered)
  agent.ts             the shared loop: detect → investigate → plan → decide → act → verify → notify → learn
  policy.ts            recovery policy engine: final authority, autonomy levels, ₦1m auto-reversal limit
  tools.ts             tool layer + permission layer; every call is audited
  advisor.ts           LLM contracts: recovery planner, and the in-app support assistant
  metrics.ts           ARR, HER, MTTR, customer effort (PRD §20)
server/agentProxy.ts   Vite middleware that calls Groq server-side; the key never reaches the browser
src/components/        operations console + CustomerApp.tsx (the customer's banking app with support chat)
```

**Safety model:** LLM → tool layer → permission layer → bank systems. The LLM can only pick from options the agent proposed, and policy decides. Write tools (`post_reversal`, `deliver_token`, `send_notification`) need a policy decision for that exact incident and transaction. Below Level 2, or above the reversal limit, they also need an operator. Reversals can't happen twice. The support chat is read-only and refuses to handle PINs or OTPs.
