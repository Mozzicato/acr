// The customer's side: a mock of the bank's mobile app with ACR built in. It shows the balance,
// recent transactions, ACR's proactive message, and a support chat that already knows what happened.

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BadgeCheck, Bell, Bot, Send, ShieldCheck, Smartphone } from 'lucide-react';
import type { EngineState } from '../engine/agent';
import { fallbackSupportReply, MAX_CHAT_CHARS, type ChatMessage, type SupportContext } from '../engine/advisor';
import { BANK_NAME } from '../engine/seed';
import type { Transaction } from '../engine/types';
import { requestSupportReply } from '../advisorClient';
import { formatNgn, formatTime } from '../format';
import { Panel } from './ui';

const STATUS_LABEL: Record<Transaction['status'], string> = {
  pending: 'Pending',
  successful: '',
  failed: 'Failed',
  reversed: 'Reversed',
};

/** Builds what the support assistant may know about this customer, from the engine's state. */
export function supportContext(state: EngineState, customerId: string): SupportContext {
  const customer = state.customers.find((c) => c.id === customerId)!;
  const account = state.accounts.find((a) => a.number === customer.accountNumber)!;
  const journeyIds = new Set(state.journeys.filter((j) => j.customerId === customerId).map((j) => j.id));
  const incident = state.incidents.filter((i) => journeyIds.has(i.journeyId)).at(-1);
  const journey = incident && state.journeys.find((j) => j.id === incident.journeyId);
  const sent = incident && state.notifications.filter((n) => n.incidentId === incident.id).at(-1);
  return {
    bank: BANK_NAME,
    customerName: customer.name,
    balance: formatNgn(account.balance),
    recentTransactions: state.transactions
      .filter((t) => t.accountNumber === account.number)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .slice(0, 6)
      .map((t) => ({ when: formatTime(t.at), description: t.narration, amount: `${t.direction === 'credit' ? '+' : '-'}${formatNgn(t.amount)}`, status: t.status })),
    issue: incident && journey ? {
      what: journey.title,
      status: incident.status === 'resolved' ? 'fixed automatically' : incident.status === 'escalated' ? 'with a human agent' : 'being looked into',
      whatAcrDid: incident.status === 'resolved' ? incident.resolution : null,
      messageSent: sent?.body ?? null,
    } : null,
  };
}

export function CustomerApp({ state, customerId, chat, onChat, aiEnabled }: {
  state: EngineState;
  customerId: string;
  chat: ChatMessage[];
  onChat: (messages: ChatMessage[]) => void;
  aiEnabled: boolean;
}) {
  const customer = state.customers.find((c) => c.id === customerId)!;
  const account = state.accounts.find((a) => a.number === customer.accountNumber)!;
  const notification = state.notifications.filter((n) => n.customerId === customerId).at(-1);
  const transactions = state.transactions
    .filter((t) => t.accountNumber === account.number)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 4);
  const firstName = customer.name.split(' ')[0];

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);
  const messages: ChatMessage[] = notification ? [{ role: 'assistant', text: notification.body }, ...chat] : chat;

  useEffect(() => {
    const el = chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, sending]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim().slice(0, MAX_CHAT_CHARS);
    if (!text || sending) return;
    const asked: ChatMessage[] = [...chat, { role: 'customer', text }];
    onChat(asked);
    setDraft('');
    setSending(true);
    const context = supportContext(state, customerId);
    let reply: string;
    try {
      reply = aiEnabled ? await requestSupportReply(context, [...messages, { role: 'customer', text }]) : fallbackSupportReply(context);
    } catch {
      reply = fallbackSupportReply(context);
    }
    onChat([...asked, { role: 'assistant', text: reply }]);
    setSending(false);
  };

  return (
    <Panel title="Customer's banking app" icon={Smartphone} aside={`${firstName}'s view`}>
      <div className="panel-body phone-wrap">
        <div className="device" role="group" aria-label={`${BANK_NAME} app as ${customer.name} sees it`}>
          <div className="device-bar"><span className="mono">{formatTime(state.now)}</span><span>{BANK_NAME}</span></div>
          <div className="app-greeting">Good afternoon, {firstName}</div>
          <div className="balance-card">
            <span>Available balance</span>
            <strong className="mono">{formatNgn(account.balance)}</strong>
            <span className="mono dim">•••• {account.number.slice(-4)}</span>
          </div>

          {notification && (
            <div className="app-alert" role="status">
              <div className="app-alert-head"><Bell size={13} aria-hidden="true" />{notification.title}</div>
              <div className="app-alert-tag"><BadgeCheck size={12} aria-hidden="true" />Fixed before you asked</div>
            </div>
          )}

          <div className="app-section">Recent</div>
          <ul className="app-tx">
            {transactions.map((t) => (
              <li key={t.id}>
                <div>
                  <div className="app-tx-name">{t.narration}</div>
                  <div className="app-tx-meta">
                    {formatTime(t.at)}
                    {STATUS_LABEL[t.status] && <span className={`app-chip chip-${t.status}`}>{STATUS_LABEL[t.status]}</span>}
                    {t.bill?.token && <span className="app-chip chip-successful">Token ready</span>}
                  </div>
                </div>
                <span className={`mono ${t.direction === 'credit' ? 'credit' : ''}`}>{t.direction === 'credit' ? '+' : '-'}{formatNgn(t.amount)}</span>
              </li>
            ))}
          </ul>

          <div className="app-section app-support-head">
            <span><Bot size={13} aria-hidden="true" /> Support</span>
            <span className="app-know"><ShieldCheck size={12} aria-hidden="true" />Knows your account</span>
          </div>
          <div className="app-chat" ref={chatRef} aria-live="polite">
            {messages.length === 0 && <p className="dim app-chat-empty">Ask anything about your account. No need to explain what happened, we can already see it.</p>}
            {messages.map((m, i) => (
              <p key={i} className={`chat-msg ${m.role}`}>{m.text}</p>
            ))}
            {sending && <p className="chat-msg assistant typing"><span className="pulse" aria-hidden="true" />Typing…</p>}
          </div>
          <form className="app-input" onSubmit={(e) => void submit(e)}>
            <label className="sr-only" htmlFor="support-input">Message support</label>
            <input id="support-input" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={`Message ${BANK_NAME} support`} maxLength={MAX_CHAT_CHARS} autoComplete="off" />
            <button type="submit" aria-label="Send" disabled={!draft.trim() || sending}><Send size={15} aria-hidden="true" /></button>
          </form>
        </div>
      </div>
    </Panel>
  );
}
