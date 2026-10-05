import { Bot, Package, ShieldCheck, ThumbsDown, ThumbsUp, TriangleAlert } from 'lucide-react';
import type { Incident, Journey } from '../engine/types';
import { formatDateTime, formatTime } from '../format';
import { HealthBadge, Panel, StatusBadge } from './ui';

const DOT: Record<string, string> = {
  payment_confirmed: 'ok', order_accepted: 'ok', courier_assigned: 'ok', parcel_collected: 'ok',
  courier_rejected_route: 'fail', incident_opened: 'warn',
  courier_reassigned: 'agent', customer_notified: 'agent', escalated_to_human: 'warn',
};

export function JourneyPanel({ journey }: { journey: Journey }) {
  return (
    <Panel title={`Journey ${journey.id}`} icon={Package} aside={<HealthBadge health={journey.health} />}>
      <div className="panel-body">
        <dl className="facts">
          <div><dt>Objective</dt><dd>{journey.objective}</dd></div>
          <div><dt>Current state</dt><dd className="mono">{journey.currentState}</dd></div>
          <div><dt>Promised by</dt><dd>{formatDateTime(journey.deadline)}</dd></div>
          <div><dt>Health score</dt><dd className="mono">{journey.healthScore}/100</dd></div>
        </dl>
        <ol className="timeline" aria-label="Journey events">
          {journey.events.map((e) => (
            <li key={e.id}>
              <time dateTime={e.at}>{formatTime(e.at)}</time>
              <span className={`dot ${DOT[e.type] ?? ''}`} aria-hidden="true" />
              <div>
                <div className="ev-summary">{e.summary}</div>
                <div className="ev-type">{e.type}</div>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </Panel>
  );
}

const STATUS_TEXT: Record<Incident['status'], [string, 'ok' | 'warn' | 'info' | 'fail' | 'agent']> = {
  investigating: ['Investigating', 'agent'],
  planning: ['Planning recovery', 'agent'],
  observing: ['Observed only (Level 0)', 'info'],
  awaiting_approval: ['Awaiting approval', 'warn'],
  executing: ['Executing', 'agent'],
  resolved: ['Resolved', 'ok'],
  escalated: ['With operator', 'info'],
};

export function IncidentPanel({ incident, busy, onApprove, onReject }: {
  incident: Incident;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const [label, tone] = STATUS_TEXT[incident.status];
  const cls = incident.status === 'resolved' ? 'is-resolved' : incident.status === 'escalated' ? 'is-escalated' : '';
  return (
    <Panel title={`Incident ${incident.id}`} icon={TriangleAlert} className={`incident ${cls}`} aside={<StatusBadge status={tone}>{label}</StatusBadge>}>
      <div className="panel-body">
        <div className="rule">
          <StatusBadge status={incident.severity === 'critical' ? 'fail' : 'warn'}>{incident.severity.toUpperCase()} · risk {incident.risk}%</StatusBadge>
          <span className="mono">{incident.rule}</span>
          <span className="muted">{incident.ruleDescription}</span>
        </div>
        <ul className="signals" aria-label="Evidence that fired the rule">
          {incident.signals.map((s) => <li key={s}>{s}</li>)}
        </ul>
        {incident.cause && (
          <div className="cause">
            <strong>Root cause</strong> <span className="dim mono">({Math.round((incident.confidence ?? 0) * 100)}% confidence)</span>
            <div>{incident.cause}</div>
          </div>
        )}
        {incident.assessment && (
          <div className="cause">
            <strong><Bot size={14} aria-hidden="true" style={{ verticalAlign: '-2px' }} /> Agent assessment</strong> <span className="dim mono">({incident.assessment.source})</span>
            <div>{incident.assessment.diagnosis}</div>
            <div className="muted" style={{ marginTop: 4 }}>{incident.assessment.rationale}</div>
          </div>
        )}
        {incident.resolution && (
          <div className="cause"><strong><ShieldCheck size={14} aria-hidden="true" style={{ verticalAlign: '-2px' }} /> Resolution</strong><div>{incident.resolution}</div></div>
        )}
        {incident.status === 'awaiting_approval' && (
          <div className="approval" role="group" aria-label="Operator approval">
            <p>Level 1: ACR recommends a recovery that policy permits. Approve it to execute.</p>
            <button type="button" className="btn btn-primary btn-sm" onClick={onApprove} disabled={busy}><ThumbsUp size={14} aria-hidden="true" />Approve</button>
            <button type="button" className="btn btn-danger btn-sm" onClick={onReject} disabled={busy}><ThumbsDown size={14} aria-hidden="true" />Reject</button>
          </div>
        )}
      </div>
    </Panel>
  );
}
