import { Waypoints } from 'lucide-react';
import type { EngineState } from '../engine/agent';
import { HealthBadge, Panel } from './ui';

const ORDER: Record<string, number> = { critical: 0, at_risk: 1, escalated: 2, recovered: 3, healthy: 4 };

export function JourneyList({ state, selectedId, onSelect }: { state: EngineState; selectedId: string; onSelect: (id: string) => void }) {
  const names = new Map(state.customers.map((c) => [c.id, c.name]));
  // Newest first, with anything still in trouble on top.
  const sorted = state.journeys
    .map((j, index) => ({ j, index }))
    .sort((a, b) => ORDER[a.j.health] - ORDER[b.j.health] || b.index - a.index)
    .map(({ j }) => j);

  return (
    <Panel title="Customer journeys" icon={Waypoints} aside={`${state.journeys.length} total`}>
      <ul className="journeys">
        {sorted.map((j) => (
          <li key={j.id}>
            <button type="button" className="journey-btn" aria-current={j.id === selectedId} onClick={() => onSelect(j.id)}>
              <span className="j-title">{names.get(j.customerId)}</span>
              <HealthBadge health={j.health} />
              <span className="j-sub">{j.title} · {j.currentState.replace(/_/g, ' ')}</span>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
