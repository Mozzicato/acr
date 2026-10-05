// Demo data for NovaBank, a fictional retail bank. All names, banks and billers are made up.
// Demo 1: Adaeze sends ₦85,000 to another bank at 13:00; she is debited but the money never lands.
// Demo 2: Bola buys a ₦20,000 electricity token; she is debited but the token never arrives.

import { BankSystems, type Faults } from './systems';
import type { Customer, Journey, JourneyEvent, Transaction } from './types';

export const BANK_NAME = 'NovaBank';
export const DEMO_JOURNEY_ID = 'JRN-2041';
export const BILL_JOURNEY_ID = 'JRN-2047';
export const DEMO_START = '2026-10-04T12:59:00+01:00';

/** Recoverable: a safe automated fix exists. Constrained: the status is unclear, so ACR must not act. */
export type Scenario = 'recoverable' | 'constrained';

const FAULTS: Record<Scenario, Faults> = {
  recoverable: { nip: 'failed_final', biller: 'vended_undelivered' },
  constrained: { nip: 'pending_unknown', biller: 'unknown' },
};

/** The transfer and token purchase the demo customers are about to make. */
export const DEMO_TRANSFER = {
  amount: 85_000,
  beneficiary: { name: 'Tunde Adeyemi', bank: 'Lagoon Bank', account: '2093318841' },
};
export const DEMO_BILL = { amount: 20_000, biller: 'Lumen Power', meter: '4502-1187-336' };

interface Persona {
  id: string;
  name: string;
  tier: 'standard' | 'premier';
  channel: 'push' | 'sms';
  balance: number;
  failedTransactions: number;
  title: string;
  /** Completed activity shown in the journey and the customer's app. */
  done: Array<Omit<Transaction, 'id' | 'accountNumber' | 'status'> & { status?: Transaction['status'] }>;
}

const at = (hhmm: string, day = '04') => `2026-10-${day}T${hhmm}:00+01:00`;

const PERSONAS: Persona[] = [
  {
    id: 'C201', name: 'Adaeze Okafor', tier: 'premier', channel: 'push', balance: 497_300, failedTransactions: 2,
    title: 'Transfer ₦85,000 to Tunde Adeyemi',
    done: [
      { type: 'inflow', amount: 650_000, direction: 'credit', narration: 'Salary: Brightwave Ltd', at: at('09:12', '01') },
      { type: 'card', amount: 23_400, direction: 'debit', narration: 'Card: Shoprite Lekki', at: at('18:40', '03') },
      { type: 'bill_payment', amount: 5_000, direction: 'debit', narration: 'Airtime top-up', at: at('08:05') },
    ],
  },
  {
    id: 'C207', name: 'Bola Ogunleye', tier: 'standard', channel: 'push', balance: 136_750, failedTransactions: 0,
    title: 'Buy ₦20,000 Lumen Power token',
    done: [
      { type: 'inflow', amount: 150_000, direction: 'credit', narration: 'Transfer from Kemi Alade', at: at('10:30', '02') },
      { type: 'card', amount: 8_250, direction: 'debit', narration: 'Card: Chicken Republic', at: at('13:15', '03') },
    ],
  },
  persona('C202', 'Chinedu Bello', 'Transfer ₦40,000 to Ifeoma Nnaji', [{ type: 'nip_transfer', amount: 40_000, direction: 'debit', narration: 'Transfer to Ifeoma Nnaji', at: at('09:41') }]),
  persona('C203', 'Fatima Yusuf', 'Pay ₦12,500 at Ikeja City Mall', [{ type: 'card', amount: 12_500, direction: 'debit', narration: 'Card: Ikeja City Mall', at: at('10:02') }]),
  persona('C204', 'Emeka Nwosu', 'Receive ₦310,000 salary', [{ type: 'inflow', amount: 310_000, direction: 'credit', narration: 'Salary: Harbor Logistics', at: at('10:20') }]),
  persona('C205', 'Zainab Ibrahim', 'Buy ₦2,000 airtime', [{ type: 'bill_payment', amount: 2_000, direction: 'debit', narration: 'Airtime top-up', at: at('11:05') }]),
  persona('C206', 'Tunde Bakare', 'Transfer ₦150,000 to Segun Bakare', [{ type: 'nip_transfer', amount: 150_000, direction: 'debit', narration: 'Transfer to Segun Bakare', at: at('11:32') }]),
  persona('C208', 'Ngozi Eze', 'Pay ₦7,800 TV subscription', [{ type: 'bill_payment', amount: 7_800, direction: 'debit', narration: 'TV subscription', at: at('11:58') }]),
  persona('C209', 'Ibrahim Musa', 'Pay ₦64,000 at Hubmart', [{ type: 'card', amount: 64_000, direction: 'debit', narration: 'Card: Hubmart Ikoyi', at: at('12:20') }]),
  persona('C210', 'Kemi Alade', 'Transfer ₦25,000 to Bola Ogunleye', [{ type: 'nip_transfer', amount: 25_000, direction: 'debit', narration: 'Transfer to Bola Ogunleye', at: at('12:41') }]),
];

function persona(id: string, name: string, title: string, done: Persona['done']): Persona {
  return { id, name, tier: 'standard', channel: 'push', balance: 180_000, failedTransactions: 0, title, done };
}

export function seed(scenario: Scenario): { systems: BankSystems; journeys: Journey[] } {
  const systems = new BankSystems(FAULTS[scenario]);
  systems.bankStatus.set(DEMO_TRANSFER.beneficiary.bank, 'up');

  const journeys = PERSONAS.map((p, index): Journey => {
    const accountNumber = `01${String(23456700 + index * 1137).padStart(8, '0')}`;
    const slug = p.name.split(' ')[0].toLowerCase();
    const customer: Customer = {
      id: p.id,
      name: p.name,
      email: `${slug}@example.com`,
      phone: `+23480200000${String(index).padStart(2, '0')}`,
      tier: p.tier,
      accountNumber,
      preferences: { channel: p.channel },
      history: { failedTransactions: p.failedTransactions, supportContacts: p.failedTransactions },
    };
    systems.customers.set(p.id, customer);
    systems.accounts.set(accountNumber, { number: accountNumber, customerId: p.id, balance: p.balance, status: 'active' });
    for (let d = 0; d < p.failedTransactions; d += 1) {
      systems.supportHistory.push({ customerId: p.id, at: `2026-0${7 + d}-1${d}T10:00:00+01:00`, topic: 'Transfer debited but not received' });
    }
    // Starting balances already include the history, so record it without moving money again.
    const done = p.done.map((d, i): Transaction => ({ ...d, id: `HIS-${p.id}-${i}`, accountNumber, status: d.status ?? 'successful' }));
    for (const tx of done) systems.transactions.set(tx.id, tx);

    const journeyId = p.id === 'C201' ? DEMO_JOURNEY_ID : p.id === 'C207' ? BILL_JOURNEY_ID : `JRN-${2050 + index}`;
    const ev = (iso: string, type: string, summary: string, payload: Record<string, unknown> = {}): JourneyEvent =>
      ({ id: `${journeyId}-${type}-${iso}`, journeyId, at: iso, type, summary, payload });
    const isDemo = journeyId === DEMO_JOURNEY_ID || journeyId === BILL_JOURNEY_ID;
    const last = done.at(-1)!;

    return {
      id: journeyId,
      title: p.title,
      customerId: p.id,
      transactionId: isDemo ? '' : last.id,
      objective: journeyId === DEMO_JOURNEY_ID ? 'Money reaches the beneficiary, or comes back fast'
        : journeyId === BILL_JOURNEY_ID ? 'Token delivered within 5 minutes of payment'
        : 'Transaction completes as expected',
      currentState: journeyId === DEMO_JOURNEY_ID ? 'composing_transfer' : journeyId === BILL_JOURNEY_ID ? 'composing_bill' : 'completed',
      expectedState: 'completed',
      deadline: isDemo ? at('13:15') : last.at,
      health: 'healthy',
      healthScore: 97 - (index % 4),
      events: isDemo
        ? [ev(at('12:57'), 'app_session_started', 'Opened the mobile app'), ev(at('12:58'), 'payment_screen_opened', `Started: ${p.title}`)]
        : [ev(last.at, `${last.type}_completed`, last.narration, { amount: last.amount })],
    };
  });

  return { systems, journeys };
}
