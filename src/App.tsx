// ACR operations console. Shows the live bank: every customer journey, what ACR detected,
// how it reasoned, what policy allowed, and the full audit trail. Also hosts the stress test.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Bot, Clock, Database, FlaskConical, RotateCcw, Smartphone, Zap } from 'lucide-react';
import type { EngineState } from './engine/agent';
import { computeMetrics } from './engine/metrics';
import { AUTONOMY_LEVELS } from './engine/policy';
import { BANK_NAME } from './engine/seed';
import type { BankHealth, BillerHealth } from './engine/systems';
import type { AutonomyLevel } from './engine/types';
import { api } from './api';
import { formatDateTime, formatTimeSeconds } from './format';
import { Kpis } from './components/Kpis';
import { JourneyList } from './components/JourneyList';
import { IncidentPanel, JourneyPanel } from './components/JourneyDetail';
import { OutcomePanel, PolicyPanel } from './components/Outcome';
import { AgentTrace } from './components/AgentTrace';
import { AuditTrail } from './components/AuditTrail';
import { LiveControl } from './components/LiveControl';
import { StressPanel } from './components/StressPanel';
import { Panel } from './components/ui';

const POLL_MS = 1_500;
const reducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const STEP_MS = reducedMotion ? 60 : 380;

interface WorldResponse {
  state: EngineState;
  storage: 'redis' | 'memory';
  llm: boolean;
}

export default function App() {
  const [tab, setTab] = useState<'live' | 'stress'>('live');
  const [world, setWorld] = useState<WorldResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<number | null>(null);
  const seenIncidents = useRef<number | null>(null);
  const latestLoad = useRef(0);

  const load = useCallback(async () => {
    const request = ++latestLoad.current;
    try {
      const response = await api<WorldResponse>('world');
      // Polls can finish out of order; never render an older snapshot after a newer one.
      if (request === latestLoad.current) {
        setWorld(response);
        setError(null);
      }
    } catch (e) {
      if (request === latestLoad.current) setError(e instanceof Error ? e.message : 'Cannot reach the server.');
    }
  }, []);

  // Poll the bank and drive the agent. On serverless hosting nothing runs between requests,
  // so the console's tick is what moves ACR through detect → investigate → decide → act.
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.hidden) return;
      void api('world/tick', { body: {} }).catch(() => undefined).finally(() => void load());
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const state = world?.state;

  // Reveal new trace steps one by one, so the audience can follow the agent's reasoning.
  useEffect(() => {
    if (!state) return;
    const total = state.trace.length;
    if (revealed === null || revealed > total) {
      setRevealed(total);
      return;
    }
    if (revealed === total) return;
    const timer = setTimeout(() => setRevealed((r) => Math.min(total, (r ?? total) + 1)), STEP_MS);
    return () => clearTimeout(timer);
  }, [state, revealed]);

  // Follow the action: when a new incident opens, jump to its journey.
  useEffect(() => {
    if (!state) return;
    const count = state.incidents.length;
    if (seenIncidents.current !== null && count > seenIncidents.current) setSelectedId(state.incidents[count - 1].journeyId);
    if (seenIncidents.current === null && !selectedId) {
      setSelectedId(state.incidents.at(-1)?.journeyId ?? state.journeys.at(-1)?.id ?? null);
    }
    seenIncidents.current = count;
  }, [state, selectedId]);

  const act = useCallback(async (path: string, body: unknown) => {
    setBusy(true);
    try {
      await api(path, { body });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [load]);

  const metrics = useMemo(() => (state ? computeMetrics(state) : null), [state]);

  if (!state || !metrics || !world) {
    return <div className="app"><p className="empty">{error ?? 'Connecting to the bank…'}</p></div>;
  }

  const journey = state.journeys.find((j) => j.id === selectedId) ?? state.journeys.at(-1)!;
  const customer = state.customers.find((c) => c.id === journey.customerId)!;
  const incident = state.incidents.filter((i) => i.journeyId === journey.id).at(-1);
  const record = incident && state.recoveries.filter((r) => r.incidentId === incident.id).at(-1);
  const visibleTrace = state.trace.slice(0, revealed ?? state.trace.length).filter((s) => s.journeyId === journey.id);
  const pendingSteps = state.trace.slice(revealed ?? state.trace.length).some((s) => s.journeyId === journey.id);
  const thinking = pendingSteps
    ? 'ACR is working…'
    : incident && ['investigating', 'planning'].includes(incident.status)
      ? (state.settings.planner === 'llm' && world.llm ? 'Reasoning over the evidence…' : 'Planning…')
      : null;
  const level = state.level;
  const llmOn = state.settings.planner === 'llm' && world.llm;
  const watching = state.journeys.filter((j) => j.currentState.startsWith('debited_awaiting') && !state.incidents.some((i) => i.journeyId === j.id));

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true"><Zap size={20} /></div>
          <div>
            <h1>ACR <span className="brand-for">for {BANK_NAME}</span></h1>
            <p>Autonomous Customer Recovery · operations console</p>
          </div>
        </div>
        <div className="clock" aria-label="Current time">
          <Clock size={14} aria-hidden="true" />
          <strong className="mono">{formatTimeSeconds(state.now)}</strong> WAT
          <span className="sim-tag" title={world.storage === 'redis' ? 'State is shared through Redis' : 'State lives in this server process'}>
            <Database size={11} aria-hidden="true" style={{ verticalAlign: '-1px' }} /> {world.storage === 'redis' ? 'Redis' : 'Memory'}
          </span>
        </div>
        <div className="controls">
          <div role="radiogroup" aria-label="Autonomy level" className="segmented">
            {([0, 1, 2] as AutonomyLevel[]).map((l) => (
              <button key={l} type="button" role="radio" aria-checked={level === l} title={AUTONOMY_LEVELS[l].summary} onClick={() => void act('world/settings', { level: l })} disabled={busy}>
                L{l} {AUTONOMY_LEVELS[l].name}
              </button>
            ))}
          </div>
          <div role="radiogroup" aria-label="Planner" className="segmented" title={world.llm ? 'LLM planner via Groq' : 'GROQ_API_KEY is not configured on the server'}>
            <button type="button" role="radio" aria-checked={llmOn} onClick={() => void act('world/settings', { planner: 'llm' })} disabled={busy || !world.llm}>
              <Bot size={13} aria-hidden="true" style={{ verticalAlign: '-2px' }} /> LLM
            </button>
            <button type="button" role="radio" aria-checked={!llmOn} onClick={() => void act('world/settings', { planner: 'rules' })} disabled={busy}>Rules</button>
          </div>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => { if (confirm('Reset the bank? Everyone who joined will need to join again.')) void act('world/reset', {}); }}>
            <RotateCcw size={14} aria-hidden="true" />Reset
          </button>
        </div>
      </header>

      <div role="tablist" aria-label="View" className="tabs">
        <button type="button" role="tab" aria-selected={tab === 'live'} onClick={() => setTab('live')}><Activity size={15} aria-hidden="true" />Live operations</button>
        <button type="button" role="tab" aria-selected={tab === 'stress'} onClick={() => setTab('stress')}><FlaskConical size={15} aria-hidden="true" />Stress test</button>
        {error && <span className="status-line" role="alert" style={{ color: 'var(--danger)', marginLeft: 'auto' }}>{error}</span>}
      </div>

      {world.storage === 'memory' && !['localhost', '127.0.0.1'].includes(location.hostname) && (
        <div className="status-line" role="alert" style={{ color: 'var(--danger)' }}>
          Bank state is not shared: Redis is not connected, so each server instance keeps its own bank and settings flip back. Connect Upstash Redis and redeploy.
        </div>
      )}

      {tab === 'stress' ? <StressPanel /> : (
        <>
          <LiveControl
            state={state}
            busy={busy}
            onBank={(bank: string, status: BankHealth) => void act('world/settings', { bank, bankStatus: status })}
            onBiller={(status: BillerHealth) => void act('world/settings', { billerStatus: status })}
            onDemo={() => void act('world/demo', {})}
          />

          <Kpis m={metrics} />

          {watching.length > 0 && (
            <div className="watching" role="status">
              <span className="pulse" aria-hidden="true" />
              Watchdog: {watching.length} debit{watching.length > 1 ? 's' : ''} not yet confirmed ({watching.map((j) => state.customers.find((c) => c.id === j.customerId)?.name.split(' ')[0]).join(', ')}).
              ACR opens an incident after {state.settings.windows.transferSeconds}s for transfers, {state.settings.windows.billSeconds}s for bills (production: 10 and 5 minutes).
            </div>
          )}

          <div className="grid">
            <div className="col">
              <Panel title={`${customer.name.split(' ')[0]}'s app, live`} icon={Smartphone} aside="The real customer app">
                <div className="device-frame">
                  <iframe key={customer.id} title={`${customer.name}'s banking app`} src={`/app/?as=${encodeURIComponent(customer.id)}`} />
                </div>
              </Panel>
              <JourneyList state={state} selectedId={journey.id} onSelect={setSelectedId} />
            </div>
            <div className="col">
              <section className="mission" aria-label="Selected journey">
                <div className="mission-copy">
                  <h2>{customer.name} · {journey.title}</h2>
                  <p>{journey.objective}. Started {formatDateTime(journey.events[0]?.at ?? journey.deadline)}. {AUTONOMY_LEVELS[level].summary} {llmOn ? 'The planner reasons with an LLM, and policy has the final say.' : 'The planner uses fixed rules.'}</p>
                </div>
              </section>
              {incident && <IncidentPanel incident={incident} busy={busy} onApprove={() => void act('world/decide', { incidentId: incident.id, approve: true })} onReject={() => void act('world/decide', { incidentId: incident.id, approve: false })} />}
              {incident && state.options[incident.id] && <PolicyPanel options={state.options[incident.id]} decision={state.decisions[incident.id]} />}
              {incident && record && <OutcomePanel notification={state.notifications.filter((n) => n.incidentId === incident.id).at(-1)} record={record} />}
              <JourneyPanel journey={journey} />
            </div>
            <div className="col col-trace">
              <AgentTrace
                steps={visibleTrace}
                thinking={thinking}
                idleText={`Watching ${state.journeys.length} journeys. Nothing wrong with this one. Set a bank to Down or Unstable, then send money from the app.`}
              />
            </div>
          </div>

          <div style={{ marginTop: 'var(--space-4)' }}>
            <AuditTrail entries={state.audit.filter((a) => !incident || state.incidents.some((i) => i.id === a.incidentId && i.journeyId === journey.id)).slice(-60)} />
          </div>
        </>
      )}

      <p className="footer-note">
        Prototype for the {BANK_NAME} hackathon. Every other bank, biller and customer is fictional, and all money is simulated.
        Core banking, the NIP switch and the biller are simulators behind real APIs. The agent, policy, safety checks and audit are the real thing.
      </p>
    </div>
  );
}
