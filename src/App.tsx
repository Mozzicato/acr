import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Clock, Clapperboard, Play, RotateCcw, Zap } from 'lucide-react';
import { AcrEngine, FAILURES, type EngineState } from './engine/agent';
import { computeMetrics } from './engine/metrics';
import { AUTONOMY_LEVELS } from './engine/policy';
import { DEMO_JOURNEY_ID, ORDER_SYNC_JOURNEY_ID, type Scenario } from './engine/seed';
import type { AutonomyLevel, FailureKind } from './engine/types';
import { getAdvisorStatus, requestAdvice, type AdvisorStatus } from './advisorClient';
import { formatDateTime, formatTimeSeconds } from './format';
import { Kpis } from './components/Kpis';
import { JourneyList } from './components/JourneyList';
import { IncidentPanel, JourneyPanel } from './components/JourneyDetail';
import { NotificationPanel, PolicyPanel } from './components/Outcome';
import { AgentTrace } from './components/AgentTrace';
import { AuditTrail } from './components/AuditTrail';

const reducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const STEP_MS = reducedMotion ? 120 : 520;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SCENARIOS: Record<Scenario, string> = {
  recoverable: 'Recoverable: a safe fix exists',
  constrained: 'Constrained: no safe fix',
};

const DEMO_SEQUENCE: Array<[string, FailureKind]> = [
  [DEMO_JOURNEY_ID, 'courier_rejected'],
  [ORDER_SYNC_JOURNEY_ID, 'order_not_created'],
];

export default function App() {
  const [scenario, setScenario] = useState<Scenario>('recoverable');
  const [level, setLevel] = useState<AutonomyLevel>(2);
  const [useAi, setUseAi] = useState(true);
  const [advisor, setAdvisor] = useState<AdvisorStatus | null>(null);

  const engineRef = useRef<AcrEngine>(new AcrEngine(scenario, level));
  const runRef = useRef(0); // bumps on reset so in-flight runs stop touching the UI
  const [state, setState] = useState<EngineState>(() => engineRef.current.snapshot());
  const [trace, setTrace] = useState(state.trace);
  const [revealed, setRevealed] = useState(0);
  const revealedRef = useRef(0);
  const [thinking, setThinking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState(DEMO_JOURNEY_ID);
  const [error, setError] = useState<string | null>(null);
  const [demoRunning, setDemoRunning] = useState(false);

  useEffect(() => { void getAdvisorStatus().then(setAdvisor); }, []);

  const reset = useCallback((nextScenario: Scenario = scenario) => {
    runRef.current += 1;
    engineRef.current = new AcrEngine(nextScenario, level);
    const snap = engineRef.current.snapshot();
    setState(snap);
    setTrace(snap.trace);
    revealedRef.current = 0;
    setRevealed(0);
    setThinking(null);
    setBusy(false);
    setError(null);
  }, [scenario, level]);

  /** Reveals new trace steps one at a time, then publishes the engine's state. Returns false if a reset interrupted it. */
  const reveal = useCallback(async (run: number): Promise<boolean> => {
    const snap = engineRef.current.snapshot();
    setTrace(snap.trace);
    while (revealedRef.current < snap.trace.length) {
      if (runRef.current !== run) return false;
      revealedRef.current += 1;
      setRevealed(revealedRef.current);
      await sleep(STEP_MS);
    }
    if (runRef.current !== run) return false;
    setState(snap);
    return true;
  }, []);

  const execute = useCallback(async (incidentId: string, run: number, approvedBy?: 'operator') => {
    setThinking('Executing recovery and verifying the outcome…');
    engineRef.current.execute(incidentId, approvedBy);
    await reveal(run);
  }, [reveal]);

  const trigger = useCallback(async (journeyId: string, kind: FailureKind) => {
    const run = runRef.current;
    const engine = engineRef.current;
    setBusy(true);
    setError(null);
    try {
      const incident = engine.trigger(journeyId, kind);
      if (!(await reveal(run)) || !incident) return;

      setThinking('Investigating through read-only tools…');
      await sleep(STEP_MS);
      const briefing = engine.investigate(incident.id);
      if (!(await reveal(run))) return;

      if (useAi && advisor?.configured) {
        setThinking(`Reasoning over evidence with ${advisor.model}…`);
        try {
          const { advice, model, latencyMs } = await requestAdvice(briefing);
          if (runRef.current !== run) return;
          engine.conclude(incident.id, advice, `${model} · ${(latencyMs / 1000).toFixed(1)}s`);
        } catch (e) {
          if (runRef.current !== run) return;
          engine.conclude(incident.id, null, `LLM unavailable (${e instanceof Error ? e.message : 'error'}). Options ranked by customer impact, then cost.`);
        }
      } else {
        engine.conclude(incident.id, null);
      }
      setThinking('Policy engine evaluating…');
      if (!(await reveal(run))) return;

      const status = engine.snapshot().incidents.find((i) => i.id === incident.id)?.status;
      if (status === 'executing') await execute(incident.id, run);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await reveal(run);
    } finally {
      if (runRef.current === run) {
        setThinking(null);
        setBusy(false);
      }
    }
  }, [advisor, execute, reveal, useAi]);

  /** Resets, then runs each failure type in turn, for a hands-off walkthrough. */
  const playDemo = useCallback(async () => {
    reset();
    const run = runRef.current;
    setDemoRunning(true);
    try {
      for (const [journeyId, kind] of DEMO_SEQUENCE) {
        setSelectedId(journeyId);
        await sleep(STEP_MS * 2);
        if (runRef.current !== run) return;
        await trigger(journeyId, kind);
        if (runRef.current !== run) return;
        await sleep(STEP_MS * 5);
      }
    } finally {
      setDemoRunning(false);
    }
  }, [reset, trigger]);

  const decide = useCallback(async (incidentId: string, approve: boolean) => {
    const run = runRef.current;
    setBusy(true);
    try {
      if (approve) await execute(incidentId, run, 'operator');
      else {
        engineRef.current.reject(incidentId);
        await reveal(run);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (runRef.current === run) {
        setThinking(null);
        setBusy(false);
      }
    }
  }, [execute, reveal]);

  const changeLevel = (next: AutonomyLevel) => {
    setLevel(next);
    engineRef.current.setLevel(next);
  };

  const metrics = useMemo(() => computeMetrics(state), [state]);
  const journey = state.journeys.find((j) => j.id === selectedId) ?? state.journeys[0];
  const incidents = state.incidents.filter((i) => i.journeyId === journey.id);
  const incident = incidents.at(-1);
  const visibleTrace = trace.slice(0, revealed).filter((s) => s.journeyId === journey.id);
  const triggers = busy || demoRunning ? [] : engineRef.current.availableTriggers(journey.id);
  const locked = busy || demoRunning;
  const aiActive = useAi && !!advisor?.configured;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true"><Zap size={20} /></div>
          <div>
            <h1>ACR</h1>
            <p>Autonomous Customer Recovery</p>
          </div>
        </div>
        <div className="clock" aria-label="Simulated time">
          <Clock size={14} aria-hidden="true" />
          <strong className="mono">{formatTimeSeconds(state.now)}</strong> WAT <span className="sim-tag">Simulated</span>
        </div>
        <div className="controls">
          <div role="radiogroup" aria-label="Autonomy level" className="segmented">
            {([0, 1, 2] as AutonomyLevel[]).map((l) => (
              <button key={l} type="button" role="radio" aria-checked={level === l} title={AUTONOMY_LEVELS[l].summary} onClick={() => changeLevel(l)} disabled={locked}>
                L{l} {AUTONOMY_LEVELS[l].name}
              </button>
            ))}
          </div>
          <label>
            <span className="sr-only">Scenario</span>
            <select value={scenario} disabled={locked} onChange={(e) => { const s = e.target.value as Scenario; setScenario(s); reset(s); }}>
              {Object.entries(SCENARIOS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <div role="radiogroup" aria-label="Planner" className="segmented" title={advisor?.configured ? `LLM planner: ${advisor.model} via Groq` : 'GROQ_API_KEY is not configured on the server'}>
            <button type="button" role="radio" aria-checked={aiActive} onClick={() => setUseAi(true)} disabled={locked || !advisor?.configured}>
              <Bot size={13} aria-hidden="true" style={{ verticalAlign: '-2px' }} /> LLM
            </button>
            <button type="button" role="radio" aria-checked={!aiActive} onClick={() => setUseAi(false)} disabled={locked}>Rules</button>
          </div>
          <button type="button" className="btn btn-sm" onClick={() => reset()}><RotateCcw size={14} aria-hidden="true" />Reset</button>
        </div>
      </header>

      <section className="mission" aria-label="Demo control">
        <div className="mission-copy">
          <h2>{journey.orderId} · {journey.title}</h2>
          <p>
            {journey.objective} (deadline {formatDateTime(journey.deadline)}). {AUTONOMY_LEVELS[level].summary}{' '}
            {aiActive ? `The planner reasons with ${advisor!.model}, and policy has the final say.` : 'The planner uses deterministic rules.'}
          </p>
        </div>
        <div className="mission-actions">
          {thinking && <span className="status-line"><span className="pulse" aria-hidden="true" />{thinking}</span>}
          {error && <span className="status-line" role="alert" style={{ color: 'var(--danger)' }}>{error}</span>}
          {triggers.map((kind) => (
            <button key={kind} type="button" className="btn btn-primary" onClick={() => void trigger(journey.id, kind)} title={FAILURES[kind].label}>
              <Play size={16} aria-hidden="true" />Simulate {FAILURES[kind].trigger}
            </button>
          ))}
          {!locked && triggers.length === 0 && <span className="status-line">No failure to simulate on this journey right now.</span>}
          <button type="button" className="btn" onClick={() => void playDemo()} disabled={locked}>
            <Clapperboard size={16} aria-hidden="true" />Play full demo
          </button>
        </div>
      </section>

      <Kpis m={metrics} />

      <div className="grid">
        <div className="col">
          <JourneyList state={state} selectedId={journey.id} onSelect={setSelectedId} />
        </div>
        <div className="col">
          {incident && <IncidentPanel incident={incident} busy={busy} onApprove={() => void decide(incident.id, true)} onReject={() => void decide(incident.id, false)} />}
          {incident && state.options[incident.id] && <PolicyPanel options={state.options[incident.id]} decision={state.decisions[incident.id]} />}
          {incident && ['resolved', 'escalated', 'observing'].includes(incident.status) && (
            <NotificationPanel
              notification={state.notifications.filter((n) => n.incidentId === incident.id).at(-1)}
              record={state.recoveries.filter((r) => r.incidentId === incident.id).at(-1)}
            />
          )}
          <JourneyPanel journey={journey} />
        </div>
        <div className="col col-trace">
          <AgentTrace
            steps={visibleTrace}
            thinking={thinking}
            idleText={`Watching ${state.journeys.length} journeys. No incidents on ${journey.orderId}. Simulate a courier rejection to see ACR detect, investigate, decide, act, verify and notify.`}
          />
        </div>
      </div>

      <div style={{ marginTop: 'var(--space-4)' }}>
        <AuditTrail entries={state.audit} />
      </div>

      <p className="footer-note">
        Simulated e-commerce delivery recovery (PRD MVP). Business systems are mocked. Detection and policy are deterministic.
        The LLM may only choose among options that policy permits.
      </p>
    </div>
  );
}
