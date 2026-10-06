# ACR: Autonomous Customer Recovery

ACR sits inside a bank's systems and its mobile app. When a customer's transaction goes wrong, ACR spots it, finds the cause, fixes what policy allows it to fix, and tells the customer in the app, before they have to call. When they do ask, the in-app support assistant already knows what happened.

This is a working prototype built for the Ecobank hackathon. Every other bank, biller and customer is fictional, and all money is simulated.

- **`/`** is the operations console: live journeys, the agent's reasoning, policy decisions, the audit trail, network fault switches, and the stress test.
- **`/app/`** is the customer's mobile banking app. Anyone can open it on their own phone and join.

## Run locally

```bash
npm install
cp .env.example .env    # add GROQ_API_KEY (optional)
npm run dev             # console: http://localhost:5173   app: http://localhost:5173/app/
npm test                # engine tests, including a 1,500-journey stress test
```

## Deploy to Vercel

1. Push the repo to GitHub and import it in Vercel. The framework (Vite), build command and output are read from `vercel.json`.
2. **Add Upstash Redis** from the Vercel Marketplace (Storage → Upstash → Redis, free tier) and connect it to the project. This is required: serverless functions don't share memory, so the bank's state lives in Redis. The `KV_REST_API_URL`/`KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_*`) variables are set for you.
3. Add environment variables:
   - `GROQ_API_KEY`: powers the LLM planner and the support chat.
   - `ADMIN_KEY`: pick any secret. It protects reset, network switches and approvals on the public URL. Open the console once as `https://<your-app>.vercel.app/?key=<ADMIN_KEY>` and the browser remembers it.
4. Deploy. The console's header shows **Redis** when shared storage is working, and **Memory** if it isn't configured.

Everything API-side goes through one function, `api/router.ts` (`/api/router?path=...`), so no rewrites are needed.

## Presenting it (about 5 minutes)

1. **The problem.** "Debited but not credited" is the complaint every bank customer knows.
2. **Judges become customers.** Put the console on the projector. Judges scan the QR code, enter a first name, and get ₦500,000 of pretend money.
3. **Normal first.** A judge sends money to any bank. It just works: ACR stays out of the way.
4. **Break something live.** Set a bank to **Down** under *Network conditions*. A judge sends money there and sees *"This didn't go through"*. About 20 seconds later ACR detects it, checks the NIP status (code 91, a final failure), reverses the money, and their phone shows **"Your ₦… is back"**. The console shows every step of the reasoning, which policy allowed it, and the audit trail.
5. **Show judgment, not just automation.** Set the bank to **Unstable** (stuck "in progress"). This time ACR **refuses** to refund, because the money might still land and a refund would pay twice. It hands the case to a human agent instead.
6. **Ask the bank.** On their phone, the judge opens Help and asks anything ("Did Tunde get my money?"). The assistant answers from their actual account. It can't move money, and it won't take a PIN.
7. **Prove it at scale.** Open the *Stress test* tab and run 2,000 journeys. Every failure is detected, there are zero double payments and zero duplicate reversals, and every account reconciles to the naira. The same seed always gives the same result, and the same checks run in CI.
8. **Be straight about what's simulated.** The other banks, NIP switch and biller are simulators behind real APIs. The agent, policy engine, safety checks and audit are the real thing.

Live detection windows are 20 seconds for transfers and 15 for bills, so the room doesn't wait. In production they'd be 10 and 5 minutes, which is what the stress test uses.

## How it's built

```
src/engine/             pure TypeScript, no UI, fully tested
  agent.ts              shared loop: detect → investigate → plan → decide → act → verify → notify → learn
                        state is one plain-JSON World, so a serverless request can load, step and save it
  playbooks/            one per failure: detect, investigate, propose, execute, verify
  policy.ts             final authority: autonomy levels, ₦1m auto-reversal limit, "never pay twice"
  tools.ts              permission layer; every tool call is audited
  systems.ts            simulated core banking, NIP switch (status query), biller gateway
  advisor.ts            LLM contracts for the planner and the support assistant
  support.ts            the customer's view of their account, and the assistant's context
  stress.ts             seeded stress test with ten safety invariants
server/                 router (Web Request/Response), Redis or in-memory store with locking, Groq calls
api/router.ts           the Vercel function
src/customer/           the customer's mobile banking app
src/components/         the operations console
```

**Safety model:** LLM → tool layer → permission layer → bank systems. The LLM may only reorder options the agent proposed, and policy decides. Write tools need a policy decision for that exact incident and transaction. Below Level 2, or above ₦1m, they also need a human. Reversals can't happen twice. The support assistant's context is built server-side from the bank's records, never from the client. It is read-only and refuses PINs and OTPs.
