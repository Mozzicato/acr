// "Does it actually work?" Thousands of random journeys with injected faults, run through the same
// engine and policy as the live system, with every safety invariant checked.

import { useRef, useState, type FormEvent } from 'react';
import { CircleCheck, CircleX, FlaskConical, Play, ShieldCheck } from 'lucide-react';
import type { StressConfig, StressReport } from '../engine/stress';
import type { StressMessage } from '../stressWorker';
import { formatDuration, formatNgn } from '../format';
import { Panel } from './ui';

const n = (x: number) => x.toLocaleString('en-NG');

export function StressPanel() {
  const [config, setConfig] = useState<StressConfig>({ journeys: 2_000, failureRate: 0.15, seed: 2026 });
  const [progress, setProgress] = useState<number | null>(null);
  const [report, setReport] = useState<StressReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);

  const run = (e: FormEvent) => {
    e.preventDefault();
    workerRef.current?.terminate();
    const worker = new Worker(new URL('../stressWorker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    setProgress(0);
    setError(null);
    setReport(null);
    worker.onmessage = (msg: MessageEvent<StressMessage>) => {
      if (msg.data.type === 'progress') setProgress(msg.data.value);
      if (msg.data.type === 'done') {
        setReport(msg.data.report);
        setProgress(null);
        worker.terminate();
      }
      if (msg.data.type === 'error') {
        setError(msg.data.message);
        setProgress(null);
        worker.terminate();
      }
    };
    worker.postMessage(config);
  };

  const c = report?.counts;
  const allPassed = report?.invariants.every((i) => i.passed);

  return (
    <div className="stress">
      <Panel title="Stress test" icon={FlaskConical} aside="Same engine and policy as the live system">
        <form className="panel-body stress-form" onSubmit={run}>
          <label>
            <span>Journeys</span>
            <select value={config.journeys} onChange={(e) => setConfig({ ...config, journeys: Number(e.target.value) })}>
              {[500, 2_000, 5_000].map((v) => <option key={v} value={v}>{n(v)}</option>)}
            </select>
          </label>
          <label>
            <span>Failure rate: {Math.round(config.failureRate * 100)}%</span>
            <input type="range" min={5} max={40} step={5} value={config.failureRate * 100} onChange={(e) => setConfig({ ...config, failureRate: Number(e.target.value) / 100 })} />
          </label>
          <label>
            <span>Seed</span>
            <input type="number" value={config.seed} onChange={(e) => setConfig({ ...config, seed: Number(e.target.value) || 1 })} />
          </label>
          <button type="submit" className="btn btn-primary" disabled={progress !== null}><Play size={16} aria-hidden="true" />{progress !== null ? 'Running…' : 'Run stress test'}</button>
          <p className="stress-note">
            Random transfers and bill payments to random banks and amounts (some over ₦1m). Faults are injected at random:
            banks down, transfers stuck "in progress" that later land or fail, billers that vend without delivering, billers that don't answer.
            Simulated clock with production detection windows (10 min for transfers, 5 min for bills). The same seed always gives the same result.
          </p>
        </form>
        {progress !== null && (
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} aria-label="Stress test progress">
            <span style={{ transform: `scaleX(${progress})` }} />
          </div>
        )}
        {error && <p className="panel-body" role="alert" style={{ color: 'var(--danger)' }}>{error}</p>}
      </Panel>

      {report && c && (
        <>
          <div className={`verdict ${allPassed ? 'pass' : 'fail'}`} role="status">
            <ShieldCheck size={22} aria-hidden="true" />
            <div>
              <strong>{allPassed ? `All ${report.invariants.length} safety checks passed` : 'A safety check failed'}</strong>
              <span>{n(c.journeys)} journeys · {n(c.faultsInjected)} faults injected · seed {report.config.seed} · ran in {(report.elapsedMs / 1000).toFixed(1)}s</span>
            </div>
          </div>

          <div className="kpis stress-kpis">
            <Tile label="Failures a customer would see" value={n(c.customerVisible)} />
            <Tile label="Detected by ACR" value={`${n(c.detected)}`} sub={`${Math.round((c.detected / Math.max(1, c.customerVisible)) * 100)}% of failures`} tone="good" />
            <Tile label="Fixed automatically" value={n(c.autoRecovered)} sub={`${Math.round((c.autoRecovered / Math.max(1, c.detected)) * 100)}% of incidents`} tone="good" />
            <Tile label="Sent to a human (unclear status)" value={n(c.escalated)} />
            <Tile label="Held for approval (over ₦1m)" value={n(c.heldForApproval)} />
            <Tile label="Double payments avoided" value={n(c.doublePaysAvoided)} sub='"In progress" transfers that later landed' tone="good" />
            <Tile label="Money returned" value={formatNgn(c.moneyReturnedNgn)} />
            <Tile label="Tokens delivered" value={n(c.tokensDelivered)} />
            <Tile label="Detection → fixed (median)" value={report.timing.detectToFixMedianSec === null ? '—' : formatDuration(report.timing.detectToFixMedianSec)} sub={report.timing.detectToFixP95Sec === null ? undefined : `p95 ${formatDuration(report.timing.detectToFixP95Sec)}`} />
          </div>

          <Panel title="Safety invariants" icon={ShieldCheck} aside="Checked on every run, and in CI">
            <ul className="invariants">
              {report.invariants.map((inv) => (
                <li key={inv.name} className={inv.passed ? 'pass' : 'fail'}>
                  {inv.passed ? <CircleCheck size={18} aria-label="passed" /> : <CircleX size={18} aria-label="failed" />}
                  <span>{inv.name}</span>
                  <span className="dim">{inv.detail}</span>
                </li>
              ))}
            </ul>
          </Panel>
        </>
      )}
    </div>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'good' }) {
  return (
    <div className={`kpi ${tone ? `is-${tone}` : ''}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}
