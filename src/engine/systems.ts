// Mocked bank systems: core banking, the NIP interbank switch, the bill-payment gateway, CRM and
// notifications. They stand in for real APIs; ACR only reaches them through the tool layer.

import type { Account, Customer, Notification, Transaction } from './types';

export class SimClock {
  private ms: number;
  constructor(start: string) {
    this.ms = Date.parse(start);
  }
  now(): string {
    return new Date(this.ms).toISOString();
  }
  advance(seconds: number): string {
    this.ms += seconds * 1000;
    return this.now();
  }
}

export const addMinutes = (iso: string, minutes: number): string =>
  new Date(Date.parse(iso) + minutes * 60_000).toISOString();

/** What the NIP switch reports for a transfer (transaction status query). */
export interface NipStatus {
  sessionId: string;
  responseCode: string;
  message: string;
  /** Whether the status is final. "In progress" is not final, so reversing could double-pay. */
  final: boolean;
}

/** What the biller reports for a token purchase (requery). */
export interface VendStatus {
  status: 'successful' | 'failed' | 'unknown';
  token: string | null;
  units: string | null;
}

/** How the simulated failures play out. Seeded per scenario. */
export interface Faults {
  nip: 'failed_final' | 'pending_unknown';
  biller: 'vended_undelivered' | 'unknown';
}

export interface SupportContact {
  customerId: string;
  at: string;
  topic: string;
}

export class BankSystems {
  readonly customers = new Map<string, Customer>();
  readonly accounts = new Map<string, Account>();
  readonly transactions = new Map<string, Transaction>();
  readonly nip = new Map<string, NipStatus>();
  readonly bankStatus = new Map<string, 'up' | 'degraded' | 'down'>();
  readonly vends = new Map<string, VendStatus>();
  readonly supportHistory: SupportContact[] = [];
  readonly outbox: Notification[] = [];
  /** Complaint tickets opened. ACR's goal is to keep this empty. */
  readonly tickets: string[] = [];
  private seq = 0;

  constructor(readonly faults: Faults) {}

  // ── CRM ──
  getCustomer(id: string): Customer {
    return required(this.customers.get(id), `customer ${id}`);
  }

  searchSupportHistory(customerId: string): SupportContact[] {
    return this.supportHistory.filter((c) => c.customerId === customerId);
  }

  // ── Core banking ──
  getAccount(number: string): Account {
    return required(this.accounts.get(number), `account ${number}`);
  }

  getTransaction(id: string): Transaction {
    return required(this.transactions.get(id), `transaction ${id}`);
  }

  findTransaction(id: string): Transaction | null {
    return this.transactions.get(id) ?? null;
  }

  transactionsFor(accountNumber: string): Transaction[] {
    return [...this.transactions.values()]
      .filter((t) => t.accountNumber === accountNumber)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }

  reversalOf(transactionId: string): Transaction | null {
    return [...this.transactions.values()].find((t) => t.reverses === transactionId) ?? null;
  }

  record(tx: Transaction): Transaction {
    const account = this.getAccount(tx.accountNumber);
    account.balance += tx.direction === 'credit' ? tx.amount : -tx.amount;
    this.transactions.set(tx.id, tx);
    return tx;
  }

  /** Returns a debit to the customer's account. Idempotent: a transaction is never reversed twice. */
  postReversal(transactionId: string, now: string): { posted: boolean; reversalId?: string; balance?: number; reason?: string } {
    const original = this.getTransaction(transactionId);
    if (original.direction !== 'debit') return { posted: false, reason: 'not a debit' };
    if (original.status === 'reversed' || this.reversalOf(transactionId)) return { posted: false, reason: 'already reversed' };
    const reversal = this.record({
      id: `RVSL-${transactionId}`,
      accountNumber: original.accountNumber,
      type: 'reversal',
      amount: original.amount,
      direction: 'credit',
      narration: `Reversal: ${original.narration}`,
      status: 'successful',
      at: now,
      reverses: transactionId,
    });
    original.status = 'reversed';
    return { posted: true, reversalId: reversal.id, balance: this.getAccount(original.accountNumber).balance };
  }

  // ── NIP interbank switch ──
  /** The customer sends a transfer. The debit posts; the switch outcome depends on the seeded fault. */
  sendTransfer(accountNumber: string, amount: number, beneficiary: NonNullable<Transaction['beneficiary']>, now: string): Transaction {
    const id = `NIP${now.slice(2, 10).replace(/-/g, '')}${String(++this.seq).padStart(4, '0')}`;
    const tx = this.record({
      id, accountNumber, type: 'nip_transfer', amount, direction: 'debit',
      narration: `Transfer to ${beneficiary.name}`, status: 'pending', at: now, beneficiary,
    });
    const failed = this.faults.nip === 'failed_final';
    this.nip.set(id, {
      sessionId: `000013${id.slice(3)}`,
      responseCode: failed ? '91' : '09',
      message: failed ? 'Beneficiary bank not available' : 'Request in progress',
      final: failed,
    });
    if (failed) tx.status = 'failed';
    this.bankStatus.set(beneficiary.bank, failed ? 'down' : 'degraded');
    return tx;
  }

  statusQuery(transactionId: string): NipStatus {
    return { ...required(this.nip.get(transactionId), `NIP session for ${transactionId}`) };
  }

  // ── Bill-payment gateway ──
  /** The customer buys a prepaid token. The debit posts, but the token never reaches them. */
  buyToken(accountNumber: string, amount: number, biller: string, meter: string, now: string): Transaction {
    const id = `BIL${now.slice(2, 10).replace(/-/g, '')}${String(++this.seq).padStart(4, '0')}`;
    const tx = this.record({
      id, accountNumber, type: 'bill_payment', amount, direction: 'debit',
      narration: `${biller} prepaid token`, status: 'pending', at: now,
      bill: { biller, meter, token: null, delivered: false },
    });
    const vended = this.faults.biller === 'vended_undelivered';
    this.vends.set(id, vended
      ? { status: 'successful', token: '4821-0937-5512-6603-1194', units: `${(amount / 225).toFixed(1)} kWh` }
      : { status: 'unknown', token: null, units: null });
    return tx;
  }

  billerRequery(transactionId: string): VendStatus {
    return { ...required(this.vends.get(transactionId), `vend for ${transactionId}`) };
  }

  /** Puts a vended token in front of the customer. Only works if the biller generated one. */
  deliverToken(transactionId: string): { delivered: boolean; token?: string; reason?: string } {
    const tx = this.getTransaction(transactionId);
    const vend = this.vends.get(transactionId);
    if (!tx.bill) return { delivered: false, reason: 'not a bill payment' };
    if (vend?.status !== 'successful' || !vend.token) return { delivered: false, reason: 'biller has not confirmed a token' };
    tx.bill.token = vend.token;
    tx.bill.delivered = true;
    tx.status = 'successful';
    return { delivered: true, token: vend.token };
  }

  // ── Notifications ──
  send(notification: Notification): Notification {
    this.outbox.push(notification);
    return notification;
  }
}

function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`Not found: ${what}`);
  return value;
}
