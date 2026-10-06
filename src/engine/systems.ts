// Mocked bank systems: core banking, the NIP interbank switch, the bill-payment gateway, CRM and
// notifications. They stand in for real APIs; ACR only reaches them through the tool layer.
// All state lives in a plain JSON object so it can be persisted between serverless requests.

import type { Account, Customer, Notification, Transaction } from './types.js';

export interface Clock {
  now(): string;
  /** Moves simulated time forward. Real time can't be moved, so it just returns now. */
  advance(seconds: number): string;
}

export class SimClock implements Clock {
  constructor(private readonly state: { ms: number }) {}
  static at(iso: string): SimClock {
    return new SimClock({ ms: Date.parse(iso) });
  }
  now(): string {
    return new Date(this.state.ms).toISOString();
  }
  advance(seconds: number): string {
    this.state.ms += seconds * 1000;
    return this.now();
  }
}

export class RealClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
  advance(): string {
    return this.now();
  }
}

export const addSeconds = (iso: string, seconds: number): string => new Date(Date.parse(iso) + seconds * 1000).toISOString();

/** What the NIP switch reports for a transfer (transaction status query). */
export interface NipStatus {
  sessionId: string;
  responseCode: string;
  message: string;
  /** Whether the status is final. "In progress" is not final, so reversing could pay twice. */
  final: boolean;
}

/** What the biller reports for a token purchase (requery). */
export interface VendStatus {
  status: 'successful' | 'failed' | 'unknown';
  token: string | null;
  units: string | null;
}

/** Live health of other banks on NIP. Unstable means transfers hang "in progress". */
export type BankHealth = 'up' | 'down' | 'unstable';
/** Live health of a biller. Stuck means tokens vend but never reach us; down means no answer. */
export type BillerHealth = 'up' | 'stuck' | 'down';

export interface SupportContact {
  customerId: string;
  at: string;
  topic: string;
}

export interface BankData {
  customers: Record<string, Customer>;
  accounts: Record<string, Account>;
  transactions: Record<string, Transaction>;
  nip: Record<string, NipStatus>;
  vends: Record<string, VendStatus>;
  bankStatus: Record<string, BankHealth>;
  billerStatus: Record<string, BillerHealth>;
  supportHistory: SupportContact[];
  outbox: Notification[];
  /** Complaint tickets opened. ACR's goal is to keep this empty. */
  tickets: string[];
  seq: number;
}

export const emptyBank = (): BankData => ({
  customers: {}, accounts: {}, transactions: {}, nip: {}, vends: {}, bankStatus: {}, billerStatus: {},
  supportHistory: [], outbox: [], tickets: [], seq: 0,
});

const NIP_MESSAGES: Record<string, string> = {
  '00': 'Approved or completed successfully',
  '09': 'Request in progress',
  '91': 'Beneficiary bank not available',
};

export class BankSystems {
  constructor(readonly data: BankData) {}

  private nextId(prefix: string, now: string): string {
    this.data.seq += 1;
    return `${prefix}${now.slice(2, 10).replace(/-/g, '')}${String(this.data.seq).padStart(5, '0')}`;
  }

  // ── CRM ──
  getCustomer(id: string): Customer {
    return required(this.data.customers[id], `customer ${id}`);
  }

  searchSupportHistory(customerId: string): SupportContact[] {
    return this.data.supportHistory.filter((c) => c.customerId === customerId);
  }

  // ── Core banking ──
  getAccount(number: string): Account {
    return required(this.data.accounts[number], `account ${number}`);
  }

  getTransaction(id: string): Transaction {
    return required(this.data.transactions[id], `transaction ${id}`);
  }

  transactionsFor(accountNumber: string): Transaction[] {
    return Object.values(this.data.transactions)
      .filter((t) => t.accountNumber === accountNumber)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }

  reversalOf(transactionId: string): Transaction | null {
    return Object.values(this.data.transactions).find((t) => t.reverses === transactionId) ?? null;
  }

  /** Records a transaction and moves the money. */
  record(tx: Transaction): Transaction {
    const account = this.getAccount(tx.accountNumber);
    account.balance += tx.direction === 'credit' ? tx.amount : -tx.amount;
    this.data.transactions[tx.id] = tx;
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
  /** Sends a transfer. The debit always posts; what NIP says depends on the other bank's health. */
  sendTransfer(accountNumber: string, amount: number, beneficiary: NonNullable<Transaction['beneficiary']>, narration: string, now: string): Transaction {
    const health = this.data.bankStatus[beneficiary.bank] ?? 'up';
    const code = health === 'up' ? '00' : health === 'down' ? '91' : '09';
    const tx = this.record({
      id: this.nextId('NIP', now),
      accountNumber, type: 'nip_transfer', amount, direction: 'debit',
      narration, status: code === '00' ? 'successful' : code === '91' ? 'failed' : 'pending', at: now, beneficiary,
    });
    this.data.nip[tx.id] = { sessionId: `000013${tx.id.slice(3)}`, responseCode: code, message: NIP_MESSAGES[code], final: code !== '09' };
    return tx;
  }

  /** NIP finally settles an "in progress" transfer. */
  settleTransfer(transactionId: string, outcome: 'successful' | 'failed'): boolean {
    const status = this.data.nip[transactionId];
    const tx = this.getTransaction(transactionId);
    if (!status || status.final) return false;
    const code = outcome === 'successful' ? '00' : '91';
    this.data.nip[transactionId] = { ...status, responseCode: code, message: NIP_MESSAGES[code], final: true };
    if (tx.status === 'pending') tx.status = outcome;
    return true;
  }

  statusQuery(transactionId: string): NipStatus {
    return { ...required(this.data.nip[transactionId], `NIP session for ${transactionId}`) };
  }

  // ── Bill-payment gateway ──
  /** Buys a prepaid token. The debit always posts; delivery depends on the biller's health. */
  buyToken(accountNumber: string, amount: number, biller: string, meter: string, now: string): Transaction {
    const health = this.data.billerStatus[biller] ?? 'up';
    const tx = this.record({
      id: this.nextId('BIL', now),
      accountNumber, type: 'bill_payment', amount, direction: 'debit',
      narration: `${biller} prepaid token`, status: 'pending', at: now,
      bill: { biller, meter, token: null, delivered: false },
    });
    const vended = health !== 'down';
    this.data.vends[tx.id] = vended
      ? { status: 'successful', token: tokenFor(this.data.seq, meter), units: `${(amount / 225).toFixed(1)} kWh` }
      : { status: 'unknown', token: null, units: null };
    if (health === 'up') this.deliverToken(tx.id);
    return tx;
  }

  billerRequery(transactionId: string): VendStatus {
    return { ...required(this.data.vends[transactionId], `vend for ${transactionId}`) };
  }

  /** Puts a vended token in front of the customer. Only works if the biller generated one. */
  deliverToken(transactionId: string): { delivered: boolean; token?: string; reason?: string } {
    const tx = this.getTransaction(transactionId);
    const vend = this.data.vends[transactionId];
    if (!tx.bill) return { delivered: false, reason: 'not a bill payment' };
    if (vend?.status !== 'successful' || !vend.token) return { delivered: false, reason: 'biller has not confirmed a token' };
    if (tx.bill.delivered) return { delivered: false, reason: 'already delivered' };
    tx.bill.token = vend.token;
    tx.bill.delivered = true;
    tx.status = 'successful';
    return { delivered: true, token: vend.token };
  }

  // ── Notifications ──
  send(notification: Notification): Notification {
    this.data.outbox.push(notification);
    return notification;
  }
}

/** A plausible 20-digit prepaid token, deterministic for a given purchase. */
function tokenFor(seq: number, meter: string): string {
  const n = BigInt(seq) * 7919n + BigInt(meter.replace(/\D/g, '').slice(-6) || '1') * 104729n + 48210937551266031194n;
  return (n % 10n ** 20n).toString().padStart(20, '0').match(/.{4}/g)!.join('-');
}

function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`Not found: ${what}`);
  return value;
}
