/**
 * Offline completion queue.
 *
 * Coverage here is patchy enough that this is not optional. A driver who
 * completes a delivery in a signal dead spot must be able to close it and
 * carry on, with the server settling it later.
 *
 * The controls that make that safe live on the back end, not the device:
 *   - a grade B completion holds driver payout until it syncs and re-verifies
 *   - the driver may hold at most MAX_UNSYNCED completions before the app
 *     stops accepting new offers. This is what prevents someone going dark
 *     and mass-closing a shift.
 *   - anything unsynced beyond MAX_UNSYNCED_AGE_MS auto-flags for review
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'pending_completions_v1';
export const MAX_UNSYNCED = 3;
export const MAX_UNSYNCED_AGE_MS = 4 * 60 * 60 * 1000;

export async function readQueue() {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function writeQueue(items) {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    // A full disk is not a reason to lose the delivery in memory.
  }
}

export async function enqueue(evidence) {
  const items = await readQueue();
  items.push({ ...evidence, queuedAt: Date.now(), attempts: 0 });
  await writeQueue(items);
  return items.length;
}

export async function isBlocked() {
  const items = await readQueue();
  if (items.length >= MAX_UNSYNCED) {
    return {
      blocked: true,
      reason: `You have ${items.length} deliveries waiting to sync. Find signal before taking another job.`,
    };
  }
  const stale = items.find((i) => Date.now() - i.queuedAt > MAX_UNSYNCED_AGE_MS);
  if (stale) {
    return { blocked: true, reason: 'A delivery has been waiting to sync too long. Contact support.' };
  }
  return { blocked: false };
}

/** Drain the queue. Returns how many synced and how many the server rejected. */
export async function drain(api) {
  const items = await readQueue();
  if (!items.length) return { synced: 0, rejected: 0, remaining: 0 };

  const remaining = [];
  let synced = 0;
  let rejected = 0;

  for (const item of items) {
    try {
      const res = await api.postCompletion(item);
      if (res.accepted) synced += 1;
      else rejected += 1;      // server keeps it, flagged for review; do not retry
    } catch {
      remaining.push({ ...item, attempts: item.attempts + 1 });
    }
  }
  await writeQueue(remaining);
  return { synced, rejected, remaining: remaining.length };
}
