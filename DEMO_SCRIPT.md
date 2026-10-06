# ACR — 5-Minute Demo Script

## Before you go on

Five minutes, two screens: the console on the projector, your own phone in hand as backup. Do these 15 minutes before your slot.

- [ ] Open the deployed console with your admin key (`/?key=…`) and check the header says **Redis**, not Memory.
- [ ] Click **Reset**, then confirm every bank and the biller show **Up**.
- [ ] Set autonomy to **L2 Autonomous** and planner to **LLM**.
- [ ] Join on your own phone as a test, send ₦1,000, then Reset again.
- [ ] Open the **Stress test** tab once so it's ready to click.
- [ ] Have a hotspot ready in case venue Wi-Fi blocks the judges' phones.

Timings below are cumulative. Lines in quotes are what you say; everything else is what you do.

## 0:00–0:30 · The problem

Open on the console, live operations tab, nothing happening yet.

> "Raise your hand if you've ever sent money, been debited, and the money never arrived."

Pause for hands.

> "Then you know what happens next. You call. You explain. You get a complaint number. You wait days for a reversal. The bank knew within seconds that the transfer failed. It just waited for you to complain."

> "We built ACR, Autonomous Customer Recovery. It catches the failure, fixes what it's allowed to fix, and tells you before you ever have to call. Let's not talk about it. Let's do it."

## 0:30–1:15 · Judges become customers

Point at the QR code in the **Be the customer** panel.

> "This is a prototype of the Ecobank app with ACR built in. Please scan it. Type your first name and you get ₦500,000. It's pretend money, and it'll never ask for your PIN."

While they scan, ask one judge to be your lead customer.

> "First, normal life. Send any amount to anyone at Crest Bank."

The judge sends it. Their phone shows **Successful**, and a new journey appears on the console as **Healthy**.

> "When everything works, ACR stays out of the way. Notice it's watching every journey on this screen. Now let's break something."

## 1:15–2:30 · Break a bank live

This is the moment the pitch rests on. In **Network conditions**, set **Harbor Bank → Down**.

> "Harbor Bank just went down. Please send any amount to Harbor Bank."

The judge's phone shows **"This didn't go through. Your account was debited."** Hold up your own phone or point at the embedded app on the console.

> "This is the moment customers start calling. Their money is gone from their balance. Watch the yellow bar: ACR's watchdog has seen the debit and is counting."

About 20 seconds later the console jumps to the new incident and the agent trace fills in. Walk it top to bottom, one line each:

1. **Detect:** "The rule fired: debited, not confirmed, high risk."
2. **Investigate:** "It checked the transfer status with NIP: code 91, a final failure. So the money never left us."
3. **Plan:** "The AI reasoned over the evidence and proposed options."
4. **Decide:** "Policy has the final say. It blocked resending the money, because that needs the customer's consent. It blocked a goodwill credit, because that spends the bank's money. It approved the reversal."
5. **Act and verify:** "It reversed the debit, then checked the balance really came back. It doesn't assume."

Now turn to the judge.

> "Look at your phone."

Their app says **"Your ₦… is back"**, with a timeline of what happened.

> "No call, no complaint, no ticket. Under a minute from failure to money back. And every step you just saw is in the audit trail below, with who did what and why."

If the timer runs short, skip reading the trace aloud and go straight to the phone.

## 2:30–3:15 · Knowing when not to act

Set **Lagoon Bank → Unstable**.

> "Automation is easy. Knowing when not to automate is what a bank needs. Lagoon Bank is now unstable: transfers hang 'in progress'. Please send something to Lagoon Bank."

Wait for the incident, then point at the policy decision.

> "The status isn't final, so the money might still land. If ACR refunded now and the transfer then went through, the bank would pay twice. So policy blocks the reversal and hands the case to a human agent, with the whole investigation already done."

The judge's phone shows **"A support agent is on it. You won't be charged twice."**

> "Same agent, opposite decision, because the facts were different. Reversals over a million naira always wait for a human too."

## 3:15–3:45 · Ask the bank

Ask the lead judge to tap **Help** and type a question, for example *"Did the money reach them? Should I send it again?"*

> "Normally this is where you explain your problem to a stranger. Here, support already knows your account and what ACR did."

Read the reply out. It will say the money was returned and they can resend once the bank is back.

> "It can't move money, and if you type a PIN it tells you not to. It explains. ACR acts."

## 3:45–4:30 · Proof at scale

Switch to the **Stress test** tab and click **Run stress test** (2,000 journeys, 15% failure rate, seed 2026). It finishes in about a second.

> "Three judges is a demo. Here's two thousand customers, with banks failing at random, transfers stuck that later land, billers that go silent. Same engine, same policy as what you just used."

Point at the green banner first, then these numbers:

| Point at | Say |
| --- | --- |
| 308 of 308 detected | "Every failure a customer could see, caught." |
| 200 fixed automatically | "Two thirds fixed with no human." |
| 49 double payments avoided | "49 transfers ACR refused to refund later landed. A naive bot pays twice, 49 times." |
| 0 duplicate reversals, 0 drift | "Every account reconciles to the naira." |

> "All ten safety checks pass. The same seed always gives the same result, and these checks run every time we change the code."

## 4:30–5:00 · Close

Go back to the live operations tab, so the recovered journeys are on screen.

> "To be straight with you: the other banks, the NIP switch and the biller here are simulators. The agent, the policy engine, the safety checks and the audit trail are real. Plugging in Ecobank's core banking and NIP means swapping the simulators, not rebuilding ACR."

> "Today, customer care starts when the customer complains. With ACR, it starts when the bank's own systems show something went wrong."

> "The best customer support interaction is the one the customer never has to start. Thank you."

## If something goes wrong

| Problem | What to do |
| --- | --- |
| Judges' phones can't load the app | Do it on your own phone, mirrored or held up. Then use **Run scripted demo**, which sends Adaeze's and Bola's transactions for you. |
| Nobody wants to scan | Ask one judge to hold your phone and tap through it. |
| The AI reasoning is slow or down | Switch the planner to **Rules**. Recovery still works; say "the AI only ranks options, policy decides, so the bank keeps working without it". |
| Incident takes longer than expected | Fill the gap by explaining the yellow watchdog bar. The window is 20 seconds on stage, 10 minutes in production. |
| The console loads but the live bank stops responding | Go straight to the stress test, which runs in the browser, then the close. |

## Likely judge questions

| Question | Short answer |
| --- | --- |
| Isn't this just a chatbot? | No. The chat explains; the agent acts. It reverses money, delivers tokens, and verifies the result. |
| What stops the AI doing something wrong? | The AI only ranks options it's given. A rules-based policy engine checks the facts itself and has the final say. Every action is audited. |
| What if it refunds money that later arrives? | It won't refund while the status is "in progress". The stress test proves it: 49 such cases, zero double payments. |
| How would this connect to a real bank? | ACR talks to banking systems through a tool layer. Swap the simulators for core banking, NIP status queries and biller requeries. |
| What about large amounts? | Reversals over ₦1,000,000 always wait for a human, even in autonomous mode. |
| Why 20 seconds? | Stage time. Production windows are 10 minutes for transfers and 5 for bills, which is what the stress test uses. |
| What does the bank gain? | Fewer complaint calls and branch visits, faster reversals, and customers who don't leave after a bad transfer. |
