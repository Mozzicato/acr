// Domain model for ACR in retail banking (PRD §14), embedded in a bank's mobile app.

export interface Customer {
  id: string;
  name: string;
  email: string;
  phone: string;
  tier: 'standard' | 'premier';
  accountNumber: string;
  preferences: { channel: 'push' | 'sms' | 'email' };
  history: { failedTransactions: number; supportContacts: number };
}

export interface Account {
  number: string;
  customerId: string;
  balance: number;
  status: 'active' | 'restricted';
}

export type TransactionType = 'nip_transfer' | 'bill_payment' | 'card' | 'inflow' | 'reversal';

export interface Transaction {
  id: string;
  accountNumber: string;
  type: TransactionType;
  /** Positive amount; `direction` says which way it moved. */
  amount: number;
  direction: 'debit' | 'credit';
  narration: string;
  status: 'pending' | 'successful' | 'failed' | 'reversed';
  at: string;
  /** NIP transfer details. */
  beneficiary?: { name: string; bank: string; account: string };
  /** Bill payment details. */
  bill?: { biller: string; meter: string; token: string | null; delivered: boolean };
  /** For a reversal: the transaction it reverses. */
  reverses?: string;
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
  /** What the customer is doing, for display. */
  title: string;
  customerId: string;
  /** The transaction this journey is about, once it exists. */
  transactionId: string;
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

export type FailureKind = 'transfer_not_credited' | 'bill_token_missing';

export type ActionId = 'reverse_transfer' | 'retry_transfer' | 'redeliver_token' | 'reverse_bill_payment' | 'goodwill_credit' | 'human_review';

export interface Incident {
  id: string;
  journeyId: string;
  kind: FailureKind;
  severity: Severity;
  /** Probability (0–100) that the customer complains without intervention. */
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

export interface RecoveryOption {
  action: ActionId;
  label: string;
  successProbability: number;
  /** Cost to the bank. Returning the customer's own money costs the bank nothing. */
  costNgn: number;
  customerImpact: 'low' | 'medium' | 'high';
  /** Transaction the action applies to. */
  transactionId?: string;
}

export type AutonomyLevel = 0 | 1 | 2;

export interface PolicyVerdict {
  action: ActionId;
  policy: string;
  allowed: boolean;
  /** Whether ACR may execute without a human at the current autonomy level. */
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
  channel: 'push' | 'sms' | 'email';
  to: string;
  title: string;
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
