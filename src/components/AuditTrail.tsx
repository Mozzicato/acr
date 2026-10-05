import { ScrollText } from 'lucide-react';
import type { AuditEntry } from '../engine/types';
import { formatTimeSeconds } from '../format';
import { Panel, StatusBadge } from './ui';

const json = (v: unknown) => JSON.stringify(v, null, 1);

export function AuditTrail({ entries }: { entries: AuditEntry[] }) {
  return (
    <Panel title="Audit trail" icon={ScrollText} aside={`${entries.length} records · every tool call and policy decision`}>
      {entries.length === 0 ? (
        <p className="empty">No tool calls yet. Each call ACR makes is recorded here with its incident, input, output, time and actor.</p>
      ) : (
        <div className="table-scroll">
          <table className="audit">
            <thead>
              <tr>
                <th scope="col">Time</th><th scope="col">Record</th><th scope="col">Incident</th><th scope="col">Actor</th>
                <th scope="col">Tool</th><th scope="col">Result</th><th scope="col">Input / output</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const write = e.tool === 'post_reversal' || e.tool === 'deliver_token' || e.tool === 'send_notification';
                return (
                  <tr key={e.id}>
                    <td className="mono">{formatTimeSeconds(e.at)}</td>
                    <td className="mono dim">{e.id}</td>
                    <td className="mono">{e.incidentId}</td>
                    <td>{e.actor}</td>
                    <td className="mono">
                      {e.tool} {write && <StatusBadge status="agent">write</StatusBadge>}
                    </td>
                    <td><StatusBadge status={e.ok ? 'ok' : 'fail'}>{e.ok ? 'ok' : 'denied'}</StatusBadge></td>
                    <td>
                      <details>
                        <summary>View payload</summary>
                        <code>in: {json(e.input)}</code>
                        <code>out: {json(e.output)}</code>
                      </details>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
