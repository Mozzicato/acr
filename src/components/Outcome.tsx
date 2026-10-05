import { ClipboardCheck, Scale } from 'lucide-react';
import { AUTONOMY_LEVELS, POLICIES } from '../engine/policy';
import type { Notification, PolicyDecision, RecoveryOption, RecoveryRecord } from '../engine/types';
import { formatNgn, formatTime } from '../format';
import { Panel, StatusBadge } from './ui';

export function PolicyPanel({ options, decision }: { options: RecoveryOption[]; decision: PolicyDecision | undefined }) {
  const verdictFor = (o: RecoveryOption) => decision?.verdicts.find((v) => v.action === o.action);
  return (
    <Panel title="Recovery plan & policy decision" icon={Scale} aside={decision ? `Level ${decision.level} · ${AUTONOMY_LEVELS[decision.level].name}` : 'Screening'}>
      <div className="panel-body table-scroll">
        <table className="options">
          <thead>
            <tr><th scope="col">Option</th><th scope="col">Success</th><th scope="col">Cost to bank</th><th scope="col">Impact</th><th scope="col">Policy</th></tr>
          </thead>
          <tbody>
            {options.map((o) => {
              const v = verdictFor(o);
              const selected = decision?.selected.action === o.action;
              return (
                <tr key={o.action} className={selected ? 'selected' : ''} aria-current={selected || undefined}>
                  <td>{o.label}</td>
                  <td className="mono">{o.successProbability}%</td>
                  <td className="mono">{formatNgn(o.costNgn)}</td>
                  <td>{o.customerImpact}</td>
                  <td>
                    {v ? (
                      <>
                        <StatusBadge status={selected ? 'ok' : v.allowed ? 'info' : 'fail'}>{selected ? 'Selected' : v.allowed ? 'Permitted' : 'Blocked'}</StatusBadge>
                        <div className="reason" title={POLICIES[v.policy as keyof typeof POLICIES]}><span className="mono">{v.policy}</span>. {v.reason}</div>
                      </>
                    ) : <span className="dim">Pending</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

export function OutcomePanel({ notification, record }: { notification: Notification | undefined; record: RecoveryRecord }) {
  const handedOff = record.outcome === 'escalated' || record.outcome === 'failed';
  return (
    <Panel title="Recovery outcome" icon={ClipboardCheck} aside={notification ? `${notification.channel.toUpperCase()} sent · ${formatTime(notification.at)}` : undefined}>
      <div className="panel-body">
        <p className="muted" style={{ margin: 0 }}>
          {notification
            ? 'The customer got the message shown in their app.'
            : handedOff
              ? 'Not contacted yet. A human agent owns this incident and has ACR\'s full investigation.'
              : 'No message sent. ACR only contacts customers after a verified recovery.'}
        </p>
        <div className="outcome-row" aria-label="Recorded outcome">
          <StatusBadge status={record.outcome === 'successful' ? 'ok' : 'info'}>Outcome: {record.outcome}</StatusBadge>
          <StatusBadge status="info">Cost to bank: {formatNgn(record.costNgn)}</StatusBadge>
          <StatusBadge status={record.complaintAvoided ? 'ok' : 'warn'}>Complaint avoided: {record.complaintAvoided ? 'yes' : 'not yet'}</StatusBadge>
          <StatusBadge status="ok">Complaint tickets: {record.ticketsCreated}</StatusBadge>
          <StatusBadge status="ok">Customer actions: {record.customerActionsRequired}</StatusBadge>
        </div>
      </div>
    </Panel>
  );
}
