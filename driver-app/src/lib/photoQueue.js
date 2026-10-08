/**
 * Collection photos waiting to upload.
 *
 * The photo is required before a driver can say they have everything, but
 * collection must never wait on signal: the photo goes into this queue and is
 * uploaded when there is a connection, possibly after the order has moved on.
 * Like the offline completion queue (queue.js), each photo belongs to the
 * driver who took it and is only ever sent with their token.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'collection_photos_v1';
// Refused for good: wrong order, not this driver's, not a photo, too big.
const PERMANENT = [400, 403, 404, 413, 415];

const mine = (driverId) => (p) => !driverId || p.driverId === driverId;

export async function readPhotos(driverId) {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const all = raw ? JSON.parse(raw) : [];
    return driverId ? all.filter(mine(driverId)) : all;
  } catch {
    return [];
  }
}

async function write(items) {
  try { await AsyncStorage.setItem(KEY, JSON.stringify(items)); } catch { /* keep going */ }
}

export async function enqueuePhoto({ uri, jobIds, driverId }) {
  const items = await readPhotos();
  items.push({ uri, jobIds, driverId, at: Date.now(), attempts: 0 });
  await write(items);
}

/** Upload this driver's waiting photos. Returns { uploaded, dropped, remaining, unauthorized }. */
export async function drainPhotos(api, driverId) {
  const items = await readPhotos();
  if (!items.length || !api?.uploadCollectionPhoto) {
    return { uploaded: 0, dropped: 0, remaining: items.filter(mine(driverId)).length, unauthorized: false };
  }
  const keep = [];
  let uploaded = 0, dropped = 0, unauthorized = false;
  for (const p of items) {
    if (unauthorized || !mine(driverId)(p)) { keep.push(p); continue; }
    try {
      await api.uploadCollectionPhoto(p.uri, p.jobIds);
      uploaded += 1;
    } catch (e) {
      if (e.status === 401) { unauthorized = true; keep.push(p); }
      else if (PERMANENT.includes(e.status)) dropped += 1;
      else keep.push({ ...p, attempts: p.attempts + 1 });
    }
  }
  await write(keep);
  return { uploaded, dropped, remaining: keep.filter(mine(driverId)).length, unauthorized };
}
