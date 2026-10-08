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
 *
 * Each item belongs to the driver who completed it. Another driver signing in
 * on the same phone never sends it with their token, and it never counts
 * against them. Items from before this have no driver and count for whoever
 * is signed in.
 *
 * A completion dispatch refuses for good (the order was cancelled or closed
 * meanwhile, or the proof is not enough) is dropped, not retried forever: it
 * would otherwise sit in the queue and block the driver from new jobs.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'pending_completions_v1';
export const MAX_UNSYNCED = 3;
export const MAX_UNSYNCED_AGE_MS = 4 * 60 * 60 * 1000;
// Dispatch's answers that will never change on a retry.
const PERMANENT = [404, 409, 410, 422];

const mine = (driverId) => (i) => !i.driverId || !driverId || i.driverId === driverId;

/** The queue, or only this driver's part of it. */
export async function readQueue(driverId) {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const items = raw ? JSON.parse(raw) : [];
    return driverId ? items.filter(mine(driverId)) : items;
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

export async function enqueue(evidence, driverId = null) {
  const items = await readQueue();
  items.push({ ...evidence, driverId, queuedAt: Date.now(), attempts: 0 });
  await writeQueue(items);
  return items.filter(mine(driverId)).length;
}

export async function isBlocked(driverId) {
  const items = await readQueue(driverId);
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

/**
 * Send this driver's queued completions. Returns how many synced, how many
 * dispatch refused for good, how many are left, and whether it stopped because
 * the driver is signed out (401: keep everything for when they sign in again).
 */
export async function drain(api, driverId) {
  const items = await readQueue();
  if (!items.length) return { synced: 0, rejected: 0, remaining: 0, unauthorized: false };

  const keep = [];
  let synced = 0;
  let rejected = 0;
  let unauthorized = false;

  for (const item of items) {
    if (unauthorized || !mine(driverId)(item)) { keep.push(item); continue; }
    try {
      const res = await api.postCompletion(item);
      if (res.accepted) synced += 1;
      else rejected += 1;      // server keeps it, flagged for review; do not retry
    } catch (e) {
      if (e.status === 401) { unauthorized = true; keep.push(item); }
      else if (PERMANENT.includes(e.status)) rejected += 1;
      else keep.push({ ...item, attempts: item.attempts + 1 });
    }
  }
  await writeQueue(keep);
  return { synced, rejected, remaining: keep.filter(mine(driverId)).length, unauthorized };
}
