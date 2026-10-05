import { Mail, MessageSquareText, Scale, Smartphone } from 'lucide-react';
import { AUTONOMY_LEVELS, POLICIES } from '../engine/policy';
import type { Notification, PolicyDecision, RecoveryOption, RecoveryRecord } from '../engine/types';
import { formatDateTime, formatNgn, formatTime } from '../format';
import { Panel, StatusBadge } from './ui';

export function PolicyPanel({ options, decision }: { options: RecoveryOption[]; decision: PolicyDecision | undefined }) {
  const verdictFor = (o: RecoveryOption) => decision?.verdicts.find((v) => v.action === o.action);
  return (
    <Panel title="Recovery plan & policy decision" icon={Scale} aside={decision ? `Level ${decision.level} · ${AUTONOMY_LEVELS[decision.level].name}` : 'Screening'}>
      <div className="panel-body table-scroll">
        <table className="options">
          <thead>
            <tr><th scope="col">Option</th><th scope="col">Success</th><th scope="col">Cost</th><th scope="col">Impact</th><th scope="col">Policy</th></tr>
          </thead>
          <tbody>
            {options.map((o) => {
              const v = verdictFor(o);
              const selected = decision?.selected.action === o.action;
              return (
                <tr key={o.action} className={selected ? 'selected' : ''} aria-current={selected || undefined}>
                  <td>
                    {o.label}
                    {o.projectedEta && <div className="reason">ETA {formatDateTime(o.projectedEta)}</div>}
                  </td>
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

export function NotificationPanel({ notification, record }: { notification: Notification | undefined; record: RecoveryRecord | undefined }) {
  const Channel = notification?.channel === 'email' ? Mail : Smartphone;
  return (
    <Panel title="Customer communication" icon={MessageSquareText} aside={notification ? `${notification.channel.toUpperCase()} · ${formatTime(notification.at)}` : undefined}>
      <div className="panel-body">
        {notification ? (
          <div className="phone">
            <div className="phone-meta"><span><Channel size={12} aria-hidden="true" style={{ verticalAlign: '-2px' }} /> {notification.to}</span><span className="mono">{notification.id}</span></div>
            <p className="bubble" style={{ margin: 0 }}>{notification.body}</p>
          </div>
        ) : (
          <p className="dim" style={{ margin: 0 }}>
            {record?.outcome === 'escalated' || record?.outcome === 'failed'
              ? 'Not contacted yet. A human operator owns this incident.'
              : 'No message sent. ACR only contacts customers after a verified recovery.'}
          </p>
        )}
        {record && (
          <div className="outcome-row" aria-label="Recorded outcome">
            <StatusBadge status={record.outcome === 'successful' ? 'ok' : 'info'}>Outcome: {record.outcome}</StatusBadge>
            <StatusBadge status="info">Cost: {formatNgn(record.costNgn)}</StatusBadge>
            <StatusBadge status={record.complaintAvoided ? 'ok' : 'warn'}>Complaint avoided: {record.complaintAvoided ? 'yes' : 'not yet'}</StatusBadge>
            <StatusBadge status="ok">Support tickets: {record.ticketsCreated}</StatusBadge>
            <StatusBadge status="ok">Customer actions: {record.customerActionsRequired}</StatusBadge>
          </div>
        )}
      </div>
    </Panel>
  );
}
