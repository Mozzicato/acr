// One HTTP router for everything, written against Web Request/Response so the same code runs as
// a Vercel function (api/router.ts) and inside the Vite dev server (server/plugin.ts).
// Routes are selected with ?path=, so the deployment needs no rewrites.

import type { AgentAdvice } from '../src/engine/advisor.js';
import { fallbackSupportReply, MAX_CHAT_CHARS, MAX_CHAT_MESSAGES, ADVISOR_MODEL, type ChatMessage } from '../src/engine/advisor.js';
import { DEMO_BILL, DEMO_CUSTOMERS, DEMO_TRANSFER, BILLER } from '../src/engine/seed.js';
import { customerView, supportContext } from '../src/engine/support.js';
import type { BankHealth, BillerHealth } from '../src/engine/systems.js';
import type { AutonomyLevel } from '../src/engine/types.js';
import { advise, supportReply } from './llm.js';
import { Busy, mutate, newLiveWorld, read, storeFor, type Env, type Store } from './store.js';

const MAX_CUSTOMERS = 300;
const MAX_CHAT_CALLS = 600;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

async function body<T>(req: Request): Promise<T> {
  const text = await req.text();
  if (text.length > 32_000) throw new HttpError(413, 'Request too large.');
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}

/** Admin routes (reset, faults, approvals) need ADMIN_KEY when one is configured. */
function requireAdmin(req: Request, env: Env): void {
  if (env.ADMIN_KEY && req.headers.get('x-admin-key') !== env.ADMIN_KEY) throw new HttpError(401, 'Admin key required.');
}

const llmKey = (env: Env) => env.GROQ_API_KEY?.trim() || undefined;

/**
 * Advances the agent: sweep for overdue debits, investigate, plan, decide, act.
 * The LLM call happens outside the lock, so the bank stays responsive while the model thinks.
 */
async function tick(store: Store, env: Env): Promise<{ opened: number; planned: number }> {
  const key = llmKey(env);
  const first = await mutate(store, (engine) => {
    const useLlm = !!key && engine.world.settings.planner === 'llm';
    const { opened, planning } = engine.runAutomatic(useLlm ? 'defer' : 'rules');
    const mine = useLlm ? engine.claim(planning) : [];
    return { opened, work: mine.map((id) => ({ id, briefing: engine.world.briefings[id] })) };
  });
  if (!first.work.length) return { opened: first.opened, planned: 0 };

  const results = await Promise.all(first.work.map(async ({ id, briefing }) => {
    try {
      return { id, ...(await advise(key!, briefing)) };
    } catch (e) {
      return { id, advice: null as AgentAdvice | null, note: `LLM unavailable (${e instanceof Error ? e.message : 'error'}). Options ranked by customer impact, then cost.` };
    }
  }));

  await mutate(store, (engine) => {
    for (const r of results) {
      const incident = engine.world.incidents.find((i) => i.id === r.id);
      if (incident?.status === 'planning') engine.conclude(r.id, r.advice, r.note);
    }
    engine.executeReady();
  });
  return { opened: first.opened, planned: results.length };
}

export async function handle(req: Request, env: Env, override?: Store): Promise<Response> {
  const url = new URL(req.url);
  const path = url.searchParams.get('path') ?? url.pathname.replace(/^\/api\/?/, '');
  const route = `${req.method} ${path}`;
  const store = override ?? storeFor(env);

  try {
    switch (route) {
      case 'GET status':
        return json({ llm: !!llmKey(env), model: ADVISOR_MODEL, storage: store.kind, adminRequired: !!env.ADMIN_KEY });

      // ── Operations console ──
      case 'GET world': {
        const engine = await read(store);
        return json({ state: engine.snapshot(), storage: store.kind, llm: !!llmKey(env) });
      }
      case 'POST world/tick':
        return json(await tick(store, env));
      case 'POST world/reset': {
        requireAdmin(req, env);
        const release = await store.lock();
        try {
          await store.save(newLiveWorld());
        } finally {
          await release();
        }
        return json({ ok: true });
      }
      case 'POST world/settings': {
        requireAdmin(req, env);
        const b = await body<{ level?: AutonomyLevel; planner?: 'llm' | 'rules'; bank?: string; bankStatus?: BankHealth; billerStatus?: BillerHealth }>(req);
        await mutate(store, (engine) => {
          if (b.level !== undefined) {
            if (![0, 1, 2].includes(b.level)) throw new HttpError(400, 'Level must be 0, 1 or 2.');
            engine.setLevel(b.level);
          }
          if (b.planner) engine.world.settings.planner = b.planner === 'llm' ? 'llm' : 'rules';
          if (b.bank && b.bankStatus) {
            if (!['up', 'down', 'unstable'].includes(b.bankStatus)) throw new HttpError(400, 'Bad bank status.');
            engine.setBankStatus(b.bank, b.bankStatus);
          }
          if (b.billerStatus) {
            if (!['up', 'stuck', 'down'].includes(b.billerStatus)) throw new HttpError(400, 'Bad biller status.');
            engine.setBillerStatus(BILLER, b.billerStatus);
          }
        });
        return json({ ok: true });
      }
      case 'POST world/demo': {
        requireAdmin(req, env);
        // The scripted walkthrough: one bank down, the biller stuck, two seeded customers transact.
        await mutate(store, (engine) => {
          engine.setBankStatus(DEMO_TRANSFER.bank, 'down');
          engine.setBillerStatus(BILLER, 'stuck');
          engine.startTransfer(DEMO_CUSTOMERS.transfer, DEMO_TRANSFER);
          engine.startBillPayment(DEMO_CUSTOMERS.bill, DEMO_BILL);
        });
        return json({ ok: true });
      }
      case 'POST world/decide': {
        requireAdmin(req, env);
        const b = await body<{ incidentId: string; approve: boolean }>(req);
        await mutate(store, (engine) => (b.approve ? engine.execute(b.incidentId, 'operator') : engine.reject(b.incidentId)));
        return json({ ok: true });
      }

      // ── Customer's mobile app ──
      case 'POST app/join': {
        const b = await body<{ name?: string }>(req);
        const customer = await mutate(store, (engine) => {
          if (Object.keys(engine.world.bank.customers).length >= MAX_CUSTOMERS) throw new HttpError(429, 'This demo bank is full. Ask the presenter to reset it.');
          return engine.join(String(b.name ?? ''));
        });
        return json({ customerId: customer.id });
      }
      case 'GET app/me': {
        const id = url.searchParams.get('id') ?? '';
        const engine = await read(store);
        if (!engine.world.bank.customers[id]) throw new HttpError(404, 'Account not found. It may have been reset.');
        return json(customerView(engine, id));
      }
      case 'POST app/transfer': {
        const b = await body<{ customerId: string; bank: string; account: string; name: string; amount: number; narration?: string }>(req);
        const journey = await mutate(store, (engine) => engine.startTransfer(b.customerId, b));
        return json({ journeyId: journey.id });
      }
      case 'POST app/bill': {
        const b = await body<{ customerId: string; meter: string; amount: number }>(req);
        const journey = await mutate(store, (engine) => engine.startBillPayment(b.customerId, b));
        return json({ journeyId: journey.id });
      }
      case 'POST app/chat': {
        const b = await body<{ customerId: string; messages: ChatMessage[] }>(req);
        const messages = (Array.isArray(b.messages) ? b.messages : [])
          .filter((m) => (m.role === 'customer' || m.role === 'assistant') && typeof m.text === 'string')
          .slice(-MAX_CHAT_MESSAGES)
          .map((m) => ({ role: m.role, text: m.text.slice(0, MAX_CHAT_CHARS) }));
        if (!messages.length || messages.at(-1)!.role !== 'customer') throw new HttpError(400, 'Send a message first.');
        // The context comes from the bank's own records, never from the client.
        const { context, allowed } = await mutate(store, (engine) => {
          if (!engine.world.bank.customers[b.customerId]) throw new HttpError(404, 'Account not found.');
          const allowed = engine.world.chatCalls < MAX_CHAT_CALLS;
          if (allowed) engine.world.chatCalls += 1;
          return { context: supportContext(engine, b.customerId), allowed };
        });
        const key = llmKey(env);
        let reply = fallbackSupportReply(context);
        // During an unsettled recovery, account truth outranks a conversational model.
        // The deterministic reply names the pending debit and cannot claim the transfer succeeded.
        if (key && allowed && context.issue?.status !== 'being looked into') {
          try {
            reply = await supportReply(key, context, messages);
          } catch {
            // Keep the rule-based reply.
          }
        }
        return json({ reply });
      }
      default:
        return json({ error: `No route for ${route}` }, 404);
    }
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    if (e instanceof Busy) return json({ error: e.message }, 503);
    const message = e instanceof Error ? e.message : 'Something went wrong.';
    // Engine validation errors are the customer's to fix; everything else is ours.
    const clientError = /digits|Minimum|Insufficient|bank from the list|Unknown|not ready|not awaiting|Not found/.test(message);
    if (!clientError) console.error(route, e);
    return json({ error: message }, clientError ? 400 : 500);
  }
}
