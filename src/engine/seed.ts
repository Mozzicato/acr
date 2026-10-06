// Starting data for the bank ACR runs in. The bank is the hackathon host; every other bank, biller,
// customer and account here is fictional, and all money is simulated.

import { emptyBank, type BankData } from './systems.js';
import type { Customer, Journey, Transaction } from './types.js';

export const BANK_NAME = 'Ecobank';
/** Other banks customers can send to over NIP. All fictional. */
export const OTHER_BANKS = ['Lagoon Bank', 'Harbor Bank', 'Crest Bank', 'Meridian MFB', 'Savanna Bank'] as const;
export const BILLER = 'Lumen Power';
export const NEW_CUSTOMER_BALANCE = 500_000;

/** The two seeded customers the scripted demo uses. */
export const DEMO_CUSTOMERS = { transfer: 'C201', bill: 'C207' } as const;
export const DEMO_TRANSFER = { amount: 85_000, bank: 'Lagoon Bank', account: '2093318841', name: 'Tunde Adeyemi' };
export const DEMO_BILL = { amount: 20_000, meter: '45021187336' };

interface Persona {
  id: string;
  name: string;
  tier: 'standard' | 'premier';
  balance: number;
  failedTransactions: number;
  title: string;
  history: Array<Omit<Transaction, 'id' | 'accountNumber' | 'status'>>;
}

const day = (d: string, hhmm: string) => `2026-10-${d}T${hhmm}:00+01:00`;

const PERSONAS: Persona[] = [
  {
    id: 'C201', name: 'Adaeze Okafor', tier: 'premier', balance: 497_300, failedTransactions: 2,
    title: 'Card payment at Shoprite Lekki',
    history: [
      { type: 'inflow', amount: 650_000, direction: 'credit', narration: 'Salary: Brightwave Ltd', at: day('01', '09:12') },
      { type: 'card', amount: 23_400, direction: 'debit', narration: 'Card: Shoprite Lekki', at: day('03', '18:40') },
    ],
  },
  {
    id: 'C207', name: 'Bola Ogunleye', tier: 'standard', balance: 136_750, failedTransactions: 0,
    title: 'Card payment at Chicken Republic',
    history: [
      { type: 'inflow', amount: 150_000, direction: 'credit', narration: 'Transfer from Kemi Alade', at: day('02', '10:30') },
      { type: 'card', amount: 8_250, direction: 'debit', narration: 'Card: Chicken Republic', at: day('03', '13:15') },
    ],
  },
  persona('C202', 'Chinedu Bello', 'Transfer ₦40,000 to Ifeoma Nnaji', { type: 'nip_transfer', amount: 40_000, direction: 'debit', narration: 'Transfer to Ifeoma Nnaji', at: day('04', '09:41') }),
  persona('C203', 'Fatima Yusuf', 'Pay ₦12,500 at Ikeja City Mall', { type: 'card', amount: 12_500, direction: 'debit', narration: 'Card: Ikeja City Mall', at: day('04', '10:02') }),
  persona('C204', 'Emeka Nwosu', 'Receive ₦310,000 salary', { type: 'inflow', amount: 310_000, direction: 'credit', narration: 'Salary: Harbor Logistics', at: day('04', '10:20') }),
  persona('C205', 'Zainab Ibrahim', 'Buy ₦2,000 airtime', { type: 'bill_payment', amount: 2_000, direction: 'debit', narration: 'Airtime top-up', at: day('04', '11:05') }),
  persona('C206', 'Tunde Bakare', 'Transfer ₦150,000 to Segun Bakare', { type: 'nip_transfer', amount: 150_000, direction: 'debit', narration: 'Transfer to Segun Bakare', at: day('04', '11:32') }),
  persona('C208', 'Ngozi Eze', 'Pay ₦7,800 TV subscription', { type: 'bill_payment', amount: 7_800, direction: 'debit', narration: 'TV subscription', at: day('04', '11:58') }),
];

function persona(id: string, name: string, title: string, last: Persona['history'][number]): Persona {
  return { id, name, tier: 'standard', balance: 180_000, failedTransactions: 0, title, history: [last] };
}

/** Account numbers are 10 digits (NUBAN length). */
export const accountNumberFor = (n: number) => `01${String(23456700 + n * 1137).padStart(8, '0')}`;

/** Adds a customer and their account. History entries are shown but don't move money again. */
export function addCustomer(bank: BankData, input: { id: string; name: string; tier?: Customer['tier']; balance: number; failedTransactions?: number; history: Persona['history'] }): Customer {
  const index = Object.keys(bank.customers).length;
  const accountNumber = accountNumberFor(index);
  const slug = input.name.split(' ')[0].toLowerCase().replace(/[^a-z]/g, '') || 'customer';
  const customer: Customer = {
    id: input.id,
    name: input.name,
    email: `${slug}@example.com`,
    phone: `+23480300${String(index).padStart(5, '0')}`,
    tier: input.tier ?? 'standard',
    accountNumber,
    preferences: { channel: 'push' },
    history: { failedTransactions: input.failedTransactions ?? 0, supportContacts: input.failedTransactions ?? 0 },
  };
  bank.customers[customer.id] = customer;
  bank.accounts[accountNumber] = { number: accountNumber, customerId: customer.id, balance: input.balance, status: 'active' };
  input.history.forEach((h, i) => {
    const id = `HIS-${customer.id}-${i}`;
    bank.transactions[id] = { ...h, id, accountNumber, status: 'successful' };
  });
  for (let d = 0; d < (input.failedTransactions ?? 0); d += 1) {
    bank.supportHistory.push({ customerId: customer.id, at: `2026-0${7 + d}-1${d}T10:00:00+01:00`, topic: 'Transfer debited but not received' });
  }
  return customer;
}

/** History for someone who joins live, so their app doesn't look empty. */
export function starterHistory(now: string): Persona['history'] {
  const ago = (days: number) => new Date(Date.parse(now) - days * 86_400_000).toISOString();
  return [
    { type: 'inflow', amount: 450_000, direction: 'credit', narration: 'Salary: Hackathon Ventures', at: ago(3) },
    { type: 'card', amount: 12_500, direction: 'debit', narration: 'Card: Shoprite', at: ago(1) },
  ];
}

export function seedBank(): { bank: BankData; journeys: Journey[] } {
  const bank = emptyBank();
  for (const b of OTHER_BANKS) bank.bankStatus[b] = 'up';
  bank.billerStatus[BILLER] = 'up';

  const journeys = PERSONAS.map((p, index): Journey => {
    addCustomer(bank, { id: p.id, name: p.name, tier: p.tier, balance: p.balance, failedTransactions: p.failedTransactions, history: p.history });
    const last = p.history.at(-1)!;
    const journeyId = `JRN-${2050 + index}`;
    return {
      id: journeyId,
      title: p.title,
      customerId: p.id,
      transactionId: `HIS-${p.id}-${p.history.length - 1}`,
      objective: 'Transaction completes as expected',
      currentState: 'completed',
      expectedState: 'completed',
      deadline: last.at,
      health: 'healthy',
      healthScore: 97 - (index % 4),
      events: [{ id: `${journeyId}-E0`, journeyId, at: last.at, type: `${last.type}_completed`, summary: last.narration, payload: { amount: last.amount } }],
    };
  });

  return { bank, journeys };
}
