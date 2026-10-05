import { useEffect, useRef } from 'react';
import { Bot } from 'lucide-react';
import type { Phase, TraceStep } from '../engine/types';
import { formatTimeSeconds } from '../format';
import { Panel, STATUS_ICON } from './ui';

const PHASE_LABEL: Record<Phase, string> = {
  detect: 'Detect', investigate: 'Investigate', plan: 'Plan', decide: 'Decide',
  act: 'Act', verify: 'Verify', notify: 'Notify customer', learn: 'Learn',
};

const HEADLINES = new Set(['ACTION APPROVED', 'ACTION APPROVED by operator', 'RECOVERY COMPLETE', 'ESCALATED TO HUMAN']);

export function AgentTrace({ steps, thinking, idleText }: { steps: TraceStep[]; thinking: string | null; idleText: string }) {
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [steps.length, thinking]);

  return (
    <Panel title="ACR agent trace" icon={Bot} className="trace-panel" aside={thinking ? 'Running' : steps.length ? `${steps.length} steps` : 'Idle'}>
      {steps.length === 0 && !thinking ? (
        <p className="empty">{idleText}</p>
      ) : (
        <ol className="trace" ref={listRef} aria-live="polite" aria-relevant="additions">
          {steps.map((s, i) => {
            const Icon = STATUS_ICON[s.status];
            const newPhase = i === 0 || steps[i - 1].phase !== s.phase || steps[i - 1].incidentId !== s.incidentId;
            return (
              <li key={s.id}>
                {newPhase && <div className="trace-phase">{PHASE_LABEL[s.phase]}{i === 0 || steps[i - 1].incidentId !== s.incidentId ? ` · ${s.incidentId}` : ''}</div>}
                <div className={`trace-step ${s.status} ${HEADLINES.has(s.title) ? 'headline' : ''}`}>
                  <Icon size={14} aria-label={s.status} />
                  <div>
                    <div className="trace-title">{s.title}</div>
                    {s.detail && <div className="trace-detail">{s.detail}</div>}
                    <div className="trace-time">{formatTimeSeconds(s.at)}</div>
                  </div>
                </div>
              </li>
            );
          })}
          {thinking && (
            <li className="thinking"><span className="pulse" aria-hidden="true" />{thinking}</li>
          )}
        </ol>
      )}
    </Panel>
  );
}
