// The bank kept in this browser, for deployments with no shared storage. Tabs on the same device
// (the console and the embedded customer app) share one bank and take turns through a Web Lock.

import type { World } from './engine/agent';
import type { Store } from '../server/store';

const KEY = 'acr:world:v2';
let queue: Promise<void> = Promise.resolve();

export const localStore: Store = {
  kind: 'local',
  load: async () => {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as World) : null;
  },
  save: async (world) => {
    localStorage.setItem(KEY, JSON.stringify(world));
  },
  lock: () =>
    new Promise((acquired) => {
      if (navigator.locks) {
        void navigator.locks.request('acr-world', () => new Promise<void>((release) => acquired(async () => release())));
      } else {
        queue = queue.then(() => new Promise<void>((release) => acquired(async () => release())));
      }
    }),
};
