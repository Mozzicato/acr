import { Waypoints } from 'lucide-react';
import type { EngineState } from '../engine/agent';
import { DEMO_JOURNEY_ID } from '../engine/seed';
import { HealthBadge, Panel } from './ui';

const ORDER: Record<string, number> = { critical: 0, at_risk: 1, escalated: 2, recovered: 3, healthy: 4 };

export function JourneyList({ state, selectedId, onSelect }: { state: EngineState; selectedId: string; onSelect: (id: string) => void }) {
  const customers = new Map(state.journeys.map((j) => [j.id, j.events[0]?.summary ?? '']));
  const sorted = [...state.journeys].sort((a, b) =>
    (a.id === DEMO_JOURNEY_ID ? -1 : 0) - (b.id === DEMO_JOURNEY_ID ? -1 : 0) || ORDER[a.health] - ORDER[b.health] || a.id.localeCompare(b.id));

  return (
    <Panel title="Customer journeys" icon={Waypoints} aside={`${state.journeys.length} active`}>
      <ul className="journeys">
        {sorted.map((j) => (
          <li key={j.id}>
            <button type="button" className="journey-btn" aria-current={j.id === selectedId} onClick={() => onSelect(j.id)}>
              <span className="j-title mono">
                {j.orderId}
                {j.id === DEMO_JOURNEY_ID && <span className="demo-tag">demo</span>}
              </span>
              <HealthBadge health={j.health} />
              <span className="j-sub">{customers.get(j.id)?.replace('Ordered ', '')} · {j.currentState.replace(/_/g, ' ')}</span>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
