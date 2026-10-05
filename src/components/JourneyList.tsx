import { Waypoints } from 'lucide-react';
import type { EngineState } from '../engine/agent';
import { BILL_JOURNEY_ID, DEMO_JOURNEY_ID } from '../engine/seed';
import { HealthBadge, Panel } from './ui';

const ORDER: Record<string, number> = { critical: 0, at_risk: 1, escalated: 2, recovered: 3, healthy: 4 };
/** Demo journeys stay pinned to the top, in demo order. */
const PINNED = [DEMO_JOURNEY_ID, BILL_JOURNEY_ID];
const pin = (id: string) => (PINNED.includes(id) ? PINNED.indexOf(id) : PINNED.length);

export function JourneyList({ state, selectedId, onSelect }: { state: EngineState; selectedId: string; onSelect: (id: string) => void }) {
  const sorted = [...state.journeys].sort((a, b) =>
    pin(a.id) - pin(b.id) || ORDER[a.health] - ORDER[b.health] || a.id.localeCompare(b.id));

  return (
    <Panel title="Customer journeys" icon={Waypoints} aside={`${state.journeys.length} active`}>
      <ul className="journeys">
        {sorted.map((j) => (
          <li key={j.id}>
            <button type="button" className="journey-btn" aria-current={j.id === selectedId} onClick={() => onSelect(j.id)}>
              <span className="j-title">
                {state.customers.find((c) => c.id === j.customerId)?.name}
                {PINNED.includes(j.id) && <span className="demo-tag">demo</span>}
              </span>
              <HealthBadge health={j.health} />
              <span className="j-sub">{j.title} · {j.currentState.replace(/_/g, ' ')}</span>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
