// The customer's side: a prototype mobile banking app with ACR built in. Judges open it on their
// own phones, send real (simulated) money, and watch ACR fix failures before they ask.

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowDownLeft, ArrowLeft, ArrowUpRight, BadgeCheck, Bell, Check, CircleAlert, Eye, EyeOff, Headset, House,
  LoaderCircle, MessageCircle, Send, ShieldCheck, Smartphone, UserRound, Zap,
} from 'lucide-react';
import { api, ApiError } from '../api';
import type { ChatMessage } from '../engine/advisor';
import { BANK_NAME } from '../engine/seed';
import type { CustomerJourney, CustomerView } from '../engine/support';
import type { Transaction } from '../engine/types';
import { formatNgn } from '../format';

const ID_KEY = 'acr.customerId';
const POLL_MS = 2_000;

type Screen =
  | { name: 'home' }
  | { name: 'transfer' }
  | { name: 'bills' }
  | { name: 'status'; journeyId: string }
  | { name: 'help' };

const shortDate = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const when = (iso: string) => shortDate.format(new Date(iso));

function greeting(): string {
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', hour: 'numeric', hour12: false }).format(new Date()));
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

/** Name enquiry: every real banking app confirms the account name before you send. Simulated here. */
const NAMES = ['Tunde Adeyemi', 'Ifeoma Nnaji', 'Musa Danjuma', 'Grace Effiong', 'Kunle Ajayi', 'Halima Sani', 'Chuka Obi', 'Aisha Bello', 'Femi Olatunji', 'Esther Okon'];
const nameFor = (account: string) => NAMES[[...account].reduce((s, d) => s + Number(d), 0) % NAMES.length];

function storedId(): string | null {
  try {
    const as = new URLSearchParams(location.search).get('as');
    return as ?? localStorage.getItem(ID_KEY);
  } catch {
    return null;
  }
}

export function CustomerApp() {
  const [customerId, setCustomerId] = useState<string | null>(storedId);
  const [view, setView] = useState<CustomerView | null>(null);
  const [screen, setScreen] = useState<Screen>({ name: 'home' });
  const [error, setError] = useState<string | null>(null);
  const [splash, setSplash] = useState<CustomerJourney | null>(null);
  const seenStatus = useRef<Map<string, CustomerJourney['status']> | null>(null);
  const embedded = new URLSearchParams(location.search).has('as');
  const latestRefresh = useRef(0);

  const refresh = useCallback(async () => {
    if (!customerId) return;
    const request = ++latestRefresh.current;
    try {
      const nextView = await api<CustomerView>('app/me', { query: { id: customerId } });
      // A slower earlier poll must not overwrite a newer balance or recovery status.
      if (request === latestRefresh.current) {
        setView(nextView);
        setError(null);
      }
    } catch (e) {
      if (request !== latestRefresh.current) return;
      if (e instanceof ApiError && e.status === 404) {
        try { localStorage.removeItem(ID_KEY); } catch { /* storage unavailable */ }
        setCustomerId(null);
        setView(null);
      } else {
        setError('Connection problem. Retrying…');
      }
    }
  }, [customerId]);

  // Phones also nudge the agent (one request at a time) so recovery never waits on the console being open.
  useEffect(() => {
    if (!customerId) return;
    void refresh();
    let inFlight = false;
    const timer = setInterval(() => {
      if (document.hidden) return;
      if (!inFlight) {
        inFlight = true;
        void api('world/tick', { body: {}, timeoutMs: 10_000 }).catch(() => undefined).finally(() => { inFlight = false; void refresh(); });
      }
    }, POLL_MS);
    const reads = setInterval(() => { if (!document.hidden) void refresh(); }, 1_000);
    return () => { clearInterval(timer); clearInterval(reads); };
  }, [customerId, refresh]);

  // Announce a recovery the moment it completes, but not ones that were already done when the app opened.
  useEffect(() => {
    if (!view) return;
    const prev = seenStatus.current;
    seenStatus.current = new Map(view.journeys.map((j) => [j.id, j.status]));
    const done = prev && view.journeys.find((j) => j.status === 'fixed' && j.outcome && prev.get(j.id) !== 'fixed');
    if (done) setSplash(done);
  }, [view]);

  if (!customerId) return <Join onJoined={(id) => { setCustomerId(id); setScreen({ name: 'home' }); }} />;
  if (!view) return <div className="eco-loading"><LoaderCircle className="spin" aria-hidden="true" /> Loading your account…</div>;

  const go = (s: Screen) => {
    setScreen(s);
    window.scrollTo({ top: 0 });
  };

  return (
    <div className={`eco ${embedded ? 'is-embedded' : ''}`}>
      <div className="eco-proto" role="note">Prototype for the {BANK_NAME} hackathon · simulated money · never enter real details</div>
      {error && <div className="eco-offline" role="status">{error}</div>}
      {splash && (
        <div className="eco-splash" role="alertdialog" aria-labelledby="splash-title">
          <div className="eco-splash-card">
            <span className="eco-splash-icon" aria-hidden="true"><BadgeCheck size={40} /></span>
            <h2 id="splash-title">{splash.outcome === 'reversed' ? 'Your transfer has been reversed' : 'Your token has been delivered'}</h2>
            <div className="eco-splash-amount">{formatNgn(splash.amount)}</div>
            <p>{splash.notification?.body ?? 'ACR fixed this for you. You did not need to contact anyone.'}</p>
            <button type="button" className="eco-btn" autoFocus onClick={() => { go({ name: 'status', journeyId: splash.id }); setSplash(null); }}>See what happened</button>
            <button type="button" className="eco-btn ghost" onClick={() => setSplash(null)}>Close</button>
          </div>
        </div>
      )}
      <main className="eco-main">
        {screen.name === 'home' && <Home view={view} go={go} />}
        {screen.name === 'transfer' && <Transfer view={view} back={() => go({ name: 'home' })} done={(journeyId) => { void refresh(); go({ name: 'status', journeyId }); }} />}
        {screen.name === 'bills' && <Bills view={view} back={() => go({ name: 'home' })} done={(journeyId) => { void refresh(); go({ name: 'status', journeyId }); }} />}
        {screen.name === 'status' && <Status view={view} journeyId={screen.journeyId} go={go} />}
        {screen.name === 'help' && <Help view={view} back={() => go({ name: 'home' })} />}
      </main>
      <nav className="eco-tabs" aria-label="Main">
        <Tab icon={<House />} label="Home" active={screen.name === 'home' || screen.name === 'status'} onClick={() => go({ name: 'home' })} />
        <Tab icon={<ArrowUpRight />} label="Transfer" active={screen.name === 'transfer'} onClick={() => go({ name: 'transfer' })} />
        <Tab icon={<Zap />} label="Bills" active={screen.name === 'bills'} onClick={() => go({ name: 'bills' })} />
        <Tab icon={<Headset />} label="Help" active={screen.name === 'help'} onClick={() => go({ name: 'help' })} />
      </nav>
    </div>
  );
}

function Tab({ icon, label, active, onClick }: { icon: ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`eco-tab ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} onClick={onClick}>
      <span aria-hidden="true">{icon}</span>
      {label}
    </button>
  );
}

// ── Join ─────────────────────────────────────────────────────────────────────
function Join({ onJoined }: { onJoined: (id: string) => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { customerId } = await api<{ customerId: string }>('app/join', { body: { name } });
      try { localStorage.setItem(ID_KEY, customerId); } catch { /* storage unavailable */ }
      onJoined(customerId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open an account.');
      setBusy(false);
    }
  };

  return (
    <div className="eco-join">
      <div className="eco-join-top">
        <div className="eco-wordmark">{BANK_NAME}</div>
        <p>The Pan African Bank, now with ACR</p>
      </div>
      <form className="eco-card eco-join-card" onSubmit={(e) => void submit(e)}>
        <h1>Open a demo account</h1>
        <p className="eco-muted">You'll get ₦500,000 of pretend money. Send it anywhere, pay a bill, and watch what happens when something goes wrong.</p>
        <label className="eco-field">
          <span>Your first name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="given-name" maxLength={40} required autoFocus placeholder="e.g. Amaka" />
        </label>
        {error && <p className="eco-error" role="alert">{error}</p>}
        <button type="submit" className="eco-btn" disabled={busy || !name.trim()}>{busy ? 'Opening…' : 'Open my account'}</button>
        <p className="eco-fine"><ShieldCheck size={14} aria-hidden="true" /> Prototype only. No real money, and we never ask for a PIN or password.</p>
      </form>
    </div>
  );
}

// ── Home ─────────────────────────────────────────────────────────────────────
function Home({ view, go }: { view: CustomerView; go: (s: Screen) => void }) {
  const [hidden, setHidden] = useState(false);
  const firstName = view.customer.name.split(' ')[0];
  const latest = view.journeys[0];
  const active = latest && ['failed', 'fixing', 'fixed', 'with_agent'].includes(latest.status) ? latest : null;

  return (
    <>
      <header className="eco-header">
        <div className="eco-hello">
          <span className="eco-avatar" aria-hidden="true">{firstName[0]}</span>
          <div>
            <div className="eco-hello-sub">{greeting()},</div>
            <div className="eco-hello-name">{firstName}</div>
          </div>
          <button type="button" className="eco-bell" aria-label={`Notifications${view.notifications.length ? `, ${view.notifications.length}` : ''}`} onClick={() => go({ name: 'help' })}>
            <Bell size={20} aria-hidden="true" />
            {view.notifications.length > 0 && <span className="eco-dot" aria-hidden="true" />}
          </button>
        </div>
        <div className="eco-account">
          <div className="eco-account-top">
            <span>Current Account · {view.customer.accountNumber}</span>
            <button type="button" className="eco-eye" onClick={() => setHidden((h) => !h)} aria-label={hidden ? 'Show balance' : 'Hide balance'}>
              {hidden ? <Eye size={18} aria-hidden="true" /> : <EyeOff size={18} aria-hidden="true" />}
            </button>
          </div>
          <div className="eco-balance-label">Available balance</div>
          <div className="eco-balance" aria-live="polite">{hidden ? '₦ ••••••' : formatNgn(view.balance)}</div>
          {view.pendingRecovery && !hidden && <div className="eco-balance-pending"><LoaderCircle size={13} className="spin" aria-hidden="true" /> Includes {formatNgn(view.pendingRecovery.amount)} under ACR review</div>}
        </div>
      </header>

      <div className="eco-actions">
        <Action icon={<ArrowUpRight />} label="Transfer" onClick={() => go({ name: 'transfer' })} />
        <Action icon={<Zap />} label="Pay bills" onClick={() => go({ name: 'bills' })} />
        <Action icon={<Smartphone />} label="Airtime" disabled />
        <Action icon={<MessageCircle />} label="Help" onClick={() => go({ name: 'help' })} />
      </div>

      {active && (
        <button type="button" className={`eco-acr eco-acr-${active.status}`} onClick={() => go({ name: 'status', journeyId: active.id })}>
          <span className="eco-acr-icon" aria-hidden="true">{active.status === 'fixed' ? <BadgeCheck /> : active.status === 'failed' ? <CircleAlert /> : <LoaderCircle className="spin" />}</span>
          <span>
            <strong>{active.notification?.title ?? STATUS_COPY[active.status].title}</strong>
            <span>{active.status === 'fixed' ? 'Fixed before you had to ask. Tap for details.' : STATUS_COPY[active.status].short}</span>
          </span>
        </button>
      )}

      <section className="eco-section" aria-labelledby="recent">
        <h2 id="recent">Recent transactions</h2>
        <ul className="eco-tx">
          {view.transactions.slice(0, 15).map((t) => <TxRow key={t.id} t={t} journey={view.journeys.find((j) => j.transactionId === t.id)} />)}
        </ul>
      </section>
    </>
  );
}

function Action({ icon, label, onClick, disabled }: { icon: ReactNode; label: string; onClick?: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="eco-action" onClick={onClick} disabled={disabled}>
      <span className="eco-action-icon" aria-hidden="true">{icon}</span>
      {label}
      {disabled && <span className="eco-soon">Soon</span>}
    </button>
  );
}

type Tag = [label: string, tone: 'warn' | 'bad' | 'good' | 'info'];

/** Every transaction gets a tag saying what became of it, including ACR's own reversals. */
function tagsFor(t: Transaction, journey?: CustomerJourney): Tag[] {
  if (t.type === 'reversal') return [['Reversal', 'good'], ['Refunded by ACR', 'info']];
  const tags: Tag[] = [];
  if (t.status === 'reversed') tags.push(['Failed', 'bad'], ['Reversed', 'good']);
  else if (t.status === 'failed') tags.push(['Failed', 'bad']);
  else if (t.status === 'pending') tags.push(['Pending', 'warn']);
  else if (t.type === 'nip_transfer') tags.push(['Successful', 'good']);
  if (journey?.status === 'fixing') tags.push(['ACR reviewing', 'info']);
  if (journey?.status === 'with_agent') tags.push(['With agent', 'info']);
  if (t.bill?.delivered) tags.push(['Token ready', 'good']);
  return tags;
}

function TxRow({ t, journey }: { t: Transaction; journey?: CustomerJourney }) {
  const credit = t.direction === 'credit';
  const struck = t.status === 'reversed';
  return (
    <li>
      <span className={`eco-tx-icon ${credit ? 'in' : 'out'}`} aria-hidden="true">{credit ? <ArrowDownLeft size={16} /> : <ArrowUpRight size={16} />}</span>
      <span className="eco-tx-main">
        <span className="eco-tx-name">{t.narration}</span>
        <span className="eco-tx-meta">
          {when(t.at)}
          {tagsFor(t, journey).map(([label, tone]) => <span key={label} className={`eco-chip ${tone}`}>{label}</span>)}
        </span>
      </span>
      <span className={`eco-tx-amt ${credit ? 'in' : ''} ${struck ? 'struck' : ''}`}>{credit ? '+' : '−'}{formatNgn(t.amount)}</span>
    </li>
  );
}

// ── Transfer ─────────────────────────────────────────────────────────────────
function Transfer({ view, back, done }: { view: CustomerView; back: () => void; done: (journeyId: string) => void }) {
  const [bank, setBank] = useState(view.banks[0] ?? '');
  const [account, setAccount] = useState('');
  const [amount, setAmount] = useState('');
  const [narration, setNarration] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolved = /^\d{10}$/.test(account) ? nameFor(account) : null;
  const value = Number(amount.replace(/\D/g, ''));
  const valid = !!resolved && value >= 100 && value <= view.balance;

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const { journeyId } = await api<{ journeyId: string }>('app/transfer', {
        body: { customerId: view.customer.id, bank, account, name: resolved, amount: value, narration },
      });
      done(journeyId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Transfer failed to start.');
      setBusy(false);
    }
  };

  if (confirming) {
    return (
      <Page title="Confirm transfer" back={() => setConfirming(false)}>
        <div className="eco-card eco-confirm">
          <div className="eco-confirm-amount">{formatNgn(value)}</div>
          <dl>
            <div><dt>To</dt><dd>{resolved}</dd></div>
            <div><dt>Bank</dt><dd>{bank}</dd></div>
            <div><dt>Account</dt><dd>{account}</dd></div>
            <div><dt>From</dt><dd>Current · {view.customer.accountNumber}</dd></div>
            <div><dt>Fee</dt><dd>₦0.00</dd></div>
            {narration && <div><dt>Description</dt><dd>{narration}</dd></div>}
          </dl>
        </div>
        <p className="eco-fine"><ShieldCheck size={14} aria-hidden="true" /> In the real app you'd approve with your PIN. Never share it with anyone, including support.</p>
        {error && <p className="eco-error" role="alert">{error}</p>}
        <button type="button" className="eco-btn" onClick={() => void send()} disabled={busy}>{busy ? 'Sending…' : `Send ${formatNgn(value)}`}</button>
      </Page>
    );
  }

  return (
    <Page title="Transfer to other banks" back={back}>
      <form className="eco-card eco-form" onSubmit={(e) => { e.preventDefault(); if (valid) setConfirming(true); }}>
        <fieldset className="eco-field">
          <legend>Bank</legend>
          <div className="eco-banks">
            {view.banks.map((b) => (
              <button key={b} type="button" className={`eco-bank ${b === bank ? 'on' : ''}`} aria-pressed={b === bank} onClick={() => setBank(b)}>{b}</button>
            ))}
          </div>
        </fieldset>
        <label className="eco-field">
          <span>Account number</span>
          <input inputMode="numeric" autoComplete="off" maxLength={10} value={account} onChange={(e) => setAccount(e.target.value.replace(/\D/g, ''))} placeholder="10 digits" />
        </label>
        {resolved && <div className="eco-resolved"><Check size={16} aria-hidden="true" /> {resolved}</div>}
        <label className="eco-field">
          <span>Amount</span>
          <div className="eco-amount">
            <span aria-hidden="true">₦</span>
            <input inputMode="numeric" value={amount ? Number(amount.replace(/\D/g, '')).toLocaleString('en-NG') : ''} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} placeholder="0" />
          </div>
        </label>
        <div className="eco-quick">
          {[5_000, 20_000, 50_000, 100_000].map((q) => <button key={q} type="button" onClick={() => setAmount(String(q))}>{formatNgn(q)}</button>)}
        </div>
        {value > view.balance && <p className="eco-error" role="alert">That's more than your balance of {formatNgn(view.balance)}.</p>}
        <label className="eco-field">
          <span>Description (optional)</span>
          <input value={narration} maxLength={60} onChange={(e) => setNarration(e.target.value)} placeholder="What's it for?" />
        </label>
        <button type="submit" className="eco-btn" disabled={!valid}>Continue</button>
      </form>
    </Page>
  );
}

// ── Bills ────────────────────────────────────────────────────────────────────
function Bills({ view, back, done }: { view: CustomerView; back: () => void; done: (journeyId: string) => void }) {
  const [meter, setMeter] = useState('');
  const [amount, setAmount] = useState(5_000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = /^\d{11}$/.test(meter) && amount <= view.balance;

  const pay = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { journeyId } = await api<{ journeyId: string }>('app/bill', { body: { customerId: view.customer.id, meter, amount } });
      done(journeyId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Payment failed to start.');
      setBusy(false);
    }
  };

  return (
    <Page title="Buy electricity" back={back}>
      <form className="eco-card eco-form" onSubmit={(e) => void pay(e)}>
        <div className="eco-biller"><Zap size={18} aria-hidden="true" /> Lumen Power · Prepaid</div>
        <label className="eco-field">
          <span>Meter number</span>
          <input inputMode="numeric" maxLength={11} value={meter} onChange={(e) => setMeter(e.target.value.replace(/\D/g, ''))} placeholder="11 digits" />
        </label>
        <fieldset className="eco-field">
          <legend>Amount</legend>
          <div className="eco-quick">
            {[2_000, 5_000, 10_000, 20_000].map((q) => (
              <button key={q} type="button" className={q === amount ? 'on' : ''} aria-pressed={q === amount} onClick={() => setAmount(q)}>{formatNgn(q)}</button>
            ))}
          </div>
        </fieldset>
        {error && <p className="eco-error" role="alert">{error}</p>}
        <button type="submit" className="eco-btn" disabled={!valid || busy}>{busy ? 'Paying…' : `Pay ${formatNgn(amount)}`}</button>
      </form>
    </Page>
  );
}

// ── Status ───────────────────────────────────────────────────────────────────
const STATUS_COPY: Record<CustomerJourney['status'], { title: string; short: string }> = {
  processing: { title: 'Confirming with the other bank', short: 'Your account is debited. Not confirmed yet, so this is not marked successful.' },
  successful: { title: 'Successful', short: 'All done.' },
  failed: { title: "This didn't go through", short: "Your account was debited. We're already checking." },
  fixing: { title: "We're fixing this for you", short: 'We spotted a problem. No need to call us.' },
  fixed: { title: 'Sorted', short: 'Fixed before you had to ask.' },
  with_agent: { title: 'A support agent is on it', short: "We'll update you here. You won't be charged twice." },
};

function Status({ view, journeyId, go }: { view: CustomerView; journeyId: string; go: (s: Screen) => void }) {
  const journey = view.journeys.find((j) => j.id === journeyId);
  const tx = journey && view.transactions.find((t) => t.id === journey.transactionId);
  const note = journey?.notification;
  if (!journey) return <Page title="Status" back={() => go({ name: 'home' })}><p className="eco-muted">Loading…</p></Page>;

  const copy = STATUS_COPY[journey.status];
  const good = journey.status === 'successful' || journey.status === 'fixed';
  const busy = journey.status === 'processing' || journey.status === 'fixing' || journey.status === 'failed';

  return (
    <Page title={journey.title} back={() => go({ name: 'home' })}>
      <div className={`eco-card eco-status ${good ? 'good' : busy ? 'busy' : 'agent'}`}>
        <span className="eco-status-icon" aria-hidden="true">{good ? <BadgeCheck size={34} /> : busy ? <LoaderCircle size={34} className="spin" /> : <UserRound size={34} />}</span>
        <h2 aria-live="polite">{note?.title ?? copy.title}</h2>
        {tx && <div className="eco-status-amount">{formatNgn(tx.amount)}</div>}
        <p>{note?.body ?? copy.short}</p>
        {journey.token && (
          <div className="eco-token">
            <span>Your token</span>
            <strong>{journey.token}</strong>
          </div>
        )}
      </div>

      <section className="eco-card eco-steps" aria-label="What happened">
        <h3>What happened</h3>
        <ol>
          {journey.steps.map((s, i) => (
            <li key={i} className={s.tone}>
              <span className="eco-step-dot" aria-hidden="true" />
              <span>{s.label}</span>
              <time dateTime={s.at}>{new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(s.at))}</time>
            </li>
          ))}
        </ol>
      </section>

      <div className="eco-row">
        <button type="button" className="eco-btn ghost" onClick={() => go({ name: 'help' })}>Ask support</button>
        <button type="button" className="eco-btn" onClick={() => go({ name: 'home' })}>Done</button>
      </div>
    </Page>
  );
}

// ── Help (support chat) ──────────────────────────────────────────────────────
function Help({ view, back }: { view: CustomerView; back: () => void }) {
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const firstName = view.customer.name.split(' ')[0];
  const intro: ChatMessage[] = [
    { role: 'assistant', text: `Hi ${firstName}, I can see your account activity, so you don't need to explain anything. How can I help?` },
    ...view.notifications.slice(-2).map((n): ChatMessage => ({ role: 'assistant', text: `${n.title}. ${n.body}` })),
  ];
  const messages = [...intro, ...chat];

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, sending]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    const asked: ChatMessage[] = [...chat, { role: 'customer', text }];
    setChat(asked);
    setDraft('');
    setSending(true);
    try {
      const { reply } = await api<{ reply: string }>('app/chat', { body: { customerId: view.customer.id, messages: [...intro, ...asked] } });
      setChat([...asked, { role: 'assistant', text: reply }]);
    } catch {
      setChat([...asked, { role: 'assistant', text: "Sorry, I couldn't reach the support desk. Please try again in a moment." }]);
    }
    setSending(false);
  };

  return (
    <Page title="Help & support" back={back}>
      <div className="eco-chat-know"><ShieldCheck size={14} aria-hidden="true" /> Knows your account · can't move money · never asks for your PIN</div>
      <div className="eco-chat" ref={listRef} aria-live="polite">
        {messages.map((m, i) => <p key={i} className={`eco-msg ${m.role}`}>{m.text}</p>)}
        {sending && <p className="eco-msg assistant typing"><LoaderCircle size={14} className="spin" aria-hidden="true" /> Typing…</p>}
      </div>
      <form className="eco-chat-input" onSubmit={(e) => void submit(e)}>
        <label className="eco-sr" htmlFor="chat">Message support</label>
        <input id="chat" value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={500} autoComplete="off" placeholder="e.g. Did my transfer go through?" />
        <button type="submit" aria-label="Send" disabled={!draft.trim() || sending}><Send size={18} aria-hidden="true" /></button>
      </form>
    </Page>
  );
}

function Page({ title, back, children }: { title: string; back: () => void; children: ReactNode }) {
  return (
    <>
      <header className="eco-pagebar">
        <button type="button" onClick={back} aria-label="Back"><ArrowLeft size={22} aria-hidden="true" /></button>
        <h1>{title}</h1>
      </header>
      <div className="eco-page">{children}</div>
    </>
  );
}
