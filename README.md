# ACR: Autonomous Customer Recovery

ACR spots when a customer journey is about to fail, finds the cause, takes an authorized corrective action and tells the customer, before they have to complain.

This repo is the MVP vertical slice from [prd.md](prd.md): **simulated e-commerce delivery recovery**.

## Run it

```bash
npm install
cp .env.example .env    # then add your GROQ_API_KEY (optional)
npm run dev             # http://localhost:5173
npm test                # engine tests
```

Without a `GROQ_API_KEY`, the app still runs end to end with the deterministic planner (use the **Rules** toggle).

## Demo script

1. Order **ORD-1292** (laptop, Lekki) is healthy. Its courier was assigned at 10:00.
2. Click **Simulate courier_rejected_route**. Rule `DR-DELIVERY-01` fires and the journey goes to **At risk (91%)**.
3. The agent trace shows the investigation: order, payment, inventory, customer history and courier availability.
4. The LLM (Groq `openai/gpt-oss-120b`) diagnoses the problem and picks a recovery. The **policy engine** checks the facts again on its own and has the final say.
5. ACR reassigns the order to Lagoon Express. It then **verifies** that the courier accepted and that the ETA is still within the promise, notifies the customer by SMS, and records the outcome. No support ticket is created.

**Second failure type:** select **ORD-1297** (headphones) and click **Simulate order_webhook_dropped**. The customer is charged, but the order webhook fails. Ten minutes later the watchdog rule `DR-ORDER-01` fires. ACR traces the cause to the failed `order.create` webhook and checks the amounts and stock. It then replays order creation from the paid checkout (the replay can't create a duplicate), verifies the result and emails the customer.

**Play full demo** resets the dashboard and runs both recoveries back to back, with no clicking needed.

Try the other paths:
- **L1 Recommend**: ACR waits for an operator to approve or reject.
- **L0 Observe**: ACR detects and recommends, but takes no action.
- **Constrained scenario**: couriers are saturated and the headphones are out of stock. Policy blocks both automated fixes, and refunds are always blocked, so both incidents go to a human.

## How it's built

```
src/engine/          pure TypeScript, no UI, fully tested
  systems.ts         mocked Order / Payment / Inventory / Logistics / CRM / Notification APIs
  seed.ts            demo journeys, customers and courier pool
  detection.ts       deterministic risk rules: DR-DELIVERY-01, DR-ORDER-01 (no ML claims)
  tools.ts           tool layer + permission layer; every call is audited
  policy.ts          recovery policy engine: final authority, autonomy levels
  advisor.ts         LLM contract: briefing in, validated advice out
  agent.ts           the shared loop: detect → investigate → plan → decide → act → verify → notify → learn
  playbooks/         per-failure investigation, options, execution and verification
                     (delivery.ts: courier rejected · orderSync.ts: order webhook dropped)
  metrics.ts         ARR, HER, MTTR, customer effort (PRD §20)
server/agentProxy.ts Vite middleware that calls Groq server-side; the key never reaches the browser
src/components/      dashboard panels
```

**Safety model:** LLM → tool layer → permission layer → business API. The LLM can only pick from options the agent proposed. Write tools (`reassign_delivery`, `replay_order_creation`, `send_notification`) need a policy decision for that incident. Below Level 2 they also need operator approval. Financial actions are always blocked in the MVP.
