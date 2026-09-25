import { useCallback, useEffect, useState } from 'react'

type Journey = {
  journey_id: string
  customer_id: string
  score: number | null
  reason: string | null
  created_at: string
}

const JOURNEYS_URL = 'https://autonomous-customer-recovery-production.up.railway.app/journeys'

function App() {
  const [journeys, setJourneys] = useState<Journey[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchJourneys = useCallback(async (isRefresh = false, signal?: AbortSignal) => {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    setError(null)

    try {
      const response = await fetch(JOURNEYS_URL, { signal })
      if (!response.ok) throw new Error(`Request failed with status ${response.status}`)
      const data: unknown = await response.json()
      if (!Array.isArray(data)) throw new Error('The journeys response was not a list.')
      setJourneys(data as Journey[])
    } catch (fetchError) {
      if (fetchError instanceof Error && fetchError.name === 'AbortError') return
      setError(fetchError instanceof Error ? fetchError.message : 'Unable to load journeys.')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void fetchJourneys(false, controller.signal)
    return () => controller.abort()
  }, [fetchJourneys])

  const cardTone = (score: number | null) => {
    if (score === null) return 'border-slate-700 bg-slate-900/70'
    if (score >= 70) return 'border-rose-400/30 bg-rose-400/[0.07]'
    if (score >= 30) return 'border-amber-300/30 bg-amber-300/[0.07]'
    return 'border-emerald-300/25 bg-emerald-300/[0.06]'
  }

  const scoreTone = (score: number | null) => {
    if (score === null) return 'text-slate-400'
    if (score >= 70) return 'text-rose-300'
    if (score >= 30) return 'text-amber-200'
    return 'text-emerald-300'
  }

  return (
    <main className="min-h-screen bg-[#080d18] text-slate-100 selection:bg-cyan-300/25">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_top,_rgba(14,116,144,0.14),_transparent_45%)]" />
      <div className="relative mx-auto max-w-6xl px-5 py-8 sm:px-8 sm:py-12">
        <header className="flex flex-col gap-6 border-b border-white/10 pb-8 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-emerald-300/20 bg-emerald-300/[0.06] px-3 py-1.5 text-xs font-medium tracking-wide text-emerald-200">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-300 opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-300" />
              </span>
              LIVE MONITOR
            </div>
            <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              Autonomous Customer Recovery
            </h1>
            <p className="mt-2 text-sm text-slate-400 sm:text-base">Live Journey Monitor</p>
          </div>
          <button
            type="button"
            onClick={() => void fetchJourneys(true)}
            disabled={refreshing || loading}
            className="inline-flex items-center justify-center gap-2 self-start rounded-lg border border-white/15 bg-white/[0.06] px-4 py-2.5 text-sm font-medium text-slate-200 shadow-sm transition hover:border-white/25 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50 sm:self-auto"
          >
            <svg className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M16.2 8A6.5 6.5 0 0 0 4.4 6.3L3 8m0 0V4.8M3 8h3.2M3.8 12a6.5 6.5 0 0 0 11.8 1.7L17 12m0 0v3.2M17 12h-3.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </header>

        <section className="pt-8" aria-labelledby="journeys-heading">
          <div className="mb-5 flex items-center justify-between">
            <div>
              <h2 id="journeys-heading" className="text-lg font-semibold text-white">Journeys</h2>
              <p className="mt-1 text-sm text-slate-500">Friction scores update as events arrive.</p>
            </div>
            {!loading && !error && <span className="rounded-full border border-white/10 px-3 py-1 text-xs text-slate-400">{journeys.length} total</span>}
          </div>

          {loading ? (
            <div className="grid gap-4 md:grid-cols-2">
              {[0, 1, 2, 3].map((item) => <div key={item} className="h-36 animate-pulse rounded-2xl border border-white/[0.06] bg-white/[0.03]" />)}
            </div>
          ) : error ? (
            <div className="rounded-2xl border border-rose-300/20 bg-rose-300/[0.06] p-6 sm:p-8">
              <p className="font-medium text-rose-200">Could not load journeys</p>
              <p className="mt-2 text-sm text-rose-100/70">{error}</p>
              <button type="button" onClick={() => void fetchJourneys(true)} className="mt-5 rounded-lg bg-rose-200/10 px-3.5 py-2 text-sm font-medium text-rose-100 transition hover:bg-rose-200/15">Try again</button>
            </div>
          ) : journeys.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/15 px-6 py-16 text-center">
              <p className="font-medium text-slate-200">No journeys yet</p>
              <p className="mt-2 text-sm text-slate-500">New customer journeys will appear here.</p>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {journeys.map((journey, index) => (
                <article key={journey.journey_id} className={`rounded-2xl border p-5 shadow-[0_12px_35px_rgba(0,0,0,0.12)] transition-colors ${cardTone(journey.score)}`}>
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">Customer</p>
                      <p className="mt-1.5 truncate font-mono text-sm text-slate-200" title={journey.customer_id}>
                        {journey.customer_id.slice(0, 8)}...
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">Friction score</p>
                      <p className={`mt-1 text-2xl font-semibold tabular-nums ${scoreTone(journey.score)}`}>
                        {journey.score === null ? <span className="text-sm font-medium">Not scored yet</span> : `${journey.score}`} 
                        {journey.score !== null && <span className="text-xs font-medium text-slate-500">/ 100</span>}
                      </p>
                    </div>
                  </div>
                  {journey.reason && <p className="mt-5 border-t border-white/[0.08] pt-4 text-sm leading-relaxed text-slate-300">{journey.reason}</p>}
                  <div className="mt-5 flex items-center justify-between text-[11px] text-slate-500">
                    <span>JOURNEY {String(index + 1).padStart(2, '0')}</span>
                    <span>{new Date(journey.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
        <footer className="mt-12 border-t border-white/[0.07] pt-5 text-xs text-slate-600">
          Autonomous Customer Recovery <span className="mx-2 text-slate-700">/</span> Journey intelligence
        </footer>
      </div>
    </main>
  )
}

export default App
