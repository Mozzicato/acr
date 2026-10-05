import { Activity, CircleAlert, CircleCheck, Gauge, Hand, Ticket, Timer, TriangleAlert, UserRound, type LucideIcon } from 'lucide-react';
import type { Metrics } from '../engine/metrics';
import { formatDuration } from '../format';

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);

function Kpi({ label, value, sub, icon: Icon, tone }: { label: string; value: string | number; sub?: string; icon: LucideIcon; tone?: 'good' | 'warn' | 'bad' }) {
  return (
    <div className={`kpi ${tone ? `is-${tone}` : ''}`}>
      <div className="kpi-label"><Icon size={13} aria-hidden="true" />{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

export function Kpis({ m }: { m: Metrics }) {
  const share = (n: number) => `${(n / Math.max(1, m.active)) * 100}%`;
  return (
    <>
      <div className="kpis">
        <Kpi label="Active journeys" value={m.active} icon={Activity} sub="Simulated" />
        <Kpi label="Healthy" value={m.healthy} icon={CircleCheck} tone="good" sub={m.recovered ? `${m.recovered} recovered by ACR` : 'On track'} />
        <Kpi label="At risk" value={m.atRisk} icon={TriangleAlert} tone={m.atRisk ? 'warn' : undefined} />
        <Kpi label="Critical" value={m.critical} icon={CircleAlert} tone={m.critical ? 'bad' : undefined} />
        <Kpi label="With operator" value={m.withOperator} icon={UserRound} />
        <Kpi label="Autonomous recovery" value={pct(m.arr)} icon={Gauge} tone={m.arr === null ? undefined : m.arr >= 0.5 ? 'good' : 'warn'} sub="Recovered without a complaint" />
        <Kpi label="Human escalation" value={pct(m.her)} icon={Hand} sub="Incidents needing a human" />
        <Kpi label="Mean time to recovery" value={m.mttr === null ? '—' : formatDuration(m.mttr)} icon={Timer} sub="Detection → verified fix" />
        <Kpi label="Customer effort" value={m.customerEffort === null ? '—' : m.customerEffort} icon={Ticket} sub={`Actions needed · ${m.tickets} tickets`} />
      </div>
      <div className="healthbar" role="img" aria-label={`Customer journey health ${Math.round(m.healthPct * 100)} percent. ${m.healthy} healthy, ${m.atRisk} at risk, ${m.critical} critical, ${m.withOperator} with an operator.`}>
        <div className="healthbar-head"><span>Customer journey health</span><span className="mono">{Math.round(m.healthPct * 100)}%</span></div>
        <div className="healthbar-track" aria-hidden="true">
          <span style={{ flexBasis: share(m.healthy), background: 'var(--accent)' }} />
          <span style={{ flexBasis: share(m.atRisk), background: 'var(--warn)' }} />
          <span style={{ flexBasis: share(m.critical), background: 'var(--danger)' }} />
          <span style={{ flexBasis: share(m.withOperator), background: 'var(--info)' }} />
        </div>
        <div className="healthbar-legend" aria-hidden="true">
          <span><i style={{ background: 'var(--accent)' }} />Healthy {m.healthy}</span>
          <span><i style={{ background: 'var(--warn)' }} />At risk {m.atRisk}</span>
          <span><i style={{ background: 'var(--danger)' }} />Critical {m.critical}</span>
          <span><i style={{ background: 'var(--info)' }} />With operator {m.withOperator}</span>
        </div>
      </div>
    </>
  );
}
