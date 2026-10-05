import type { ReactNode } from 'react';
import { CircleAlert, CircleCheck, CircleX, Info, TriangleAlert, UserRound, type LucideIcon } from 'lucide-react';
import { HEALTH_LABEL } from '../engine/agent';
import type { Health, TraceStep } from '../engine/types';

export function Panel({ title, icon: Icon, aside, className = '', children }: {
  title: string;
  icon: LucideIcon;
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`panel ${className}`} aria-label={title}>
      <header className="panel-head">
        <Icon size={16} aria-hidden="true" />
        <h3>{title}</h3>
        {aside && <span className="aside">{aside}</span>}
      </header>
      {children}
    </section>
  );
}

const HEALTH_ICON: Record<Health, LucideIcon> = {
  healthy: CircleCheck,
  at_risk: TriangleAlert,
  critical: CircleAlert,
  recovered: CircleCheck,
  escalated: UserRound,
};

export function HealthBadge({ health }: { health: Health }) {
  const Icon = HEALTH_ICON[health];
  return (
    <span className={`badge badge-${health}`}>
      <Icon size={12} aria-hidden="true" />
      {HEALTH_LABEL[health]}
    </span>
  );
}

export const STATUS_ICON: Record<TraceStep['status'], LucideIcon> = {
  ok: CircleCheck,
  warn: TriangleAlert,
  fail: CircleX,
  info: Info,
};

export function StatusBadge({ status, children }: { status: TraceStep['status'] | 'agent'; children: ReactNode }) {
  return <span className={`badge badge-${status}`}>{children}</span>;
}
