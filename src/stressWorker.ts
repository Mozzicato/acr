// Runs the stress test off the main thread so the console stays responsive.

import { runStress, type StressConfig, type StressReport } from './engine/stress';

export type StressMessage = { type: 'progress'; value: number } | { type: 'done'; report: StressReport } | { type: 'error'; message: string };

const ctx = self as unknown as { postMessage(message: StressMessage): void; onmessage: ((e: MessageEvent<StressConfig>) => void) | null };

ctx.onmessage = (e) => {
  try {
    const run = runStress(e.data);
    let last = 0;
    let step = run.next();
    while (!step.done) {
      if (step.value - last >= 0.01) {
        last = step.value;
        ctx.postMessage({ type: 'progress', value: step.value });
      }
      step = run.next();
    }
    ctx.postMessage({ type: 'done', report: step.value });
  } catch (err) {
    ctx.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
