// Domain model for the ACR MVP (PRD §14), scoped to e-commerce delivery recovery.

export type Zone = 'Lekki' | 'Yaba' | 'Ikeja';

export interface Customer {
  id: string;
  name: string;
  email: string;
  phone: string;
  tier: 'standard' | 'priority';
  preferences: { channel: 'sms' | 'email' };
  history: { previousDelays: number; supportContacts: number };
}

export interface Courier {
  id: string;
  name: string;
  zone: Zone;
  /** Share of route capacity already committed, 0–1. */
  capacity: number;
  available: boolean;
  /** Minutes from assignment until the courier can collect the parcel. */
  pickupMinutes: number;
}

export type OrderStatus = 'created' | 'accepted' | 'courier_assigned' | 'in_transit' | 'delivered';

export interface Order {
  id: string;
  customerId: string;
  item: string;
  sku: string;
  amount: number;
  zone: Zone;
  status: OrderStatus;
  courierId: string | null;
  /** Delivery deadline promised to the customer. */
  promisedBy: string;
  eta: string;
  /** Minutes of transit from warehouse to the customer once collected. */
  transitMinutes: number;
}

export interface Payment {
  orderId: string;
  status: 'confirmed' | 'pending' | 'failed';
  amount: number;
  reference: string;
}

export interface InventoryRecord {
  sku: string;
  orderId: string;
  reserved: boolean;
  warehouse: string;
}

export type Health = 'healthy' | 'at_risk' | 'critical' | 'recovered' | 'escalated';

export interface JourneyEvent {
  id: string;
  journeyId: string;
  at: string;
  type: string;
  summary: string;
  payload: Record<string, unknown>;
}

export interface Journey {
  id: string;
  /** What the customer bought, for display. */
  title: string;
  customerId: string;
  orderId: string;
  objective: string;
  currentState: string;
  expectedState: string;
  deadline: string;
  health: Health;
  /** 0–100; 100 is a perfectly healthy journey. */
  healthScore: number;
  events: JourneyEvent[];
}

export type Severity = 'high' | 'critical';

export type IncidentStatus =
  | 'investigating'
  | 'planning'
  | 'observing'
  | 'awaiting_approval'
  | 'executing'
  | 'resolved'
  | 'escalated';

export interface Incident {
  id: string;
  journeyId: string;
  kind: FailureKind;
  severity: Severity;
  /** Probability (0–100) that the journey fails without intervention. */
  risk: number;
  rule: string;
  ruleDescription: string;
  /** Signals that caused the detection rule to fire. */
  signals: string[];
  cause: string | null;
  confidence: number | null;
  /** The planning agent's own diagnosis and choice, when an LLM was consulted. */
  assessment: { diagnosis: string; selectedAction: ActionId; rationale: string; confidence: number; source: string } | null;
  status: IncidentStatus;
  resolution: string | null;
  detectedAt: string;
  resolvedAt: string | null;
}

export type FailureKind = 'courier_rejected' | 'order_not_created';

export type ActionId = 'reassign_courier' | 'recreate_order' | 'delay_with_credit' | 'refund' | 'human_review';

export interface RecoveryOption {
  action: ActionId;
  label: string;
  successProbability: number;
  costNgn: number;
  customerImpact: 'low' | 'medium' | 'high';
  /** Alternate courier for a reassignment. */
  courierId?: string;
  /** Order to recreate from its captured payment. */
  orderId?: string;
  projectedEta?: string;
}

export type AutonomyLevel = 0 | 1 | 2;

export interface PolicyVerdict {
  action: ActionId;
  policy: string;
  allowed: boolean;
  /** Whether the current autonomy level lets ACR execute without a human. */
  autonomous: boolean;
  reason: string;
}

export interface PolicyDecision {
  incidentId: string;
  verdicts: PolicyVerdict[];
  selected: RecoveryOption;
  selectedVerdict: PolicyVerdict;
  level: AutonomyLevel;
}

export type Actor = 'acr-agent' | 'policy-engine' | 'operator';

export interface AuditEntry {
  id: string;
  incidentId: string;
  tool: string;
  actor: Actor;
  input: Record<string, unknown>;
  output: unknown;
  at: string;
  ok: boolean;
}

export type Phase = 'detect' | 'investigate' | 'plan' | 'decide' | 'act' | 'verify' | 'notify' | 'learn';

export interface TraceStep {
  id: string;
  incidentId: string;
  journeyId: string;
  phase: Phase;
  status: 'ok' | 'warn' | 'fail' | 'info';
  title: string;
  detail?: string;
  at: string;
}

export interface Notification {
  id: string;
  incidentId: string;
  customerId: string;
  channel: 'sms' | 'email';
  to: string;
  body: string;
  at: string;
}

export interface RecoveryRecord {
  incidentId: string;
  journeyId: string;
  failure: string;
  proposedAction: ActionId;
  actualAction: ActionId | null;
  costNgn: number;
  outcome: 'successful' | 'failed' | 'escalated' | 'observed';
  customerImpact: 'none' | 'low' | 'medium' | 'high';
  complaintAvoided: boolean;
  ticketsCreated: number;
  customerActionsRequired: number;
  recoverySeconds: number | null;
}
