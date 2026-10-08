/**
 * How far we deliver and what a long delivery costs the customer.
 *
 * The numbers are dispatch settings (src/settings.js), set per zone in the
 * back office Settings tab. Defaults: up to 11 km by road, store to customer
 * (about 7.9 km as the crow flies); the flat fee covers 5 km and each km
 * after it is added at the zone's "Per km to customer" rate (Pricing).
 *
 * Distance is the road route when we have one, else straight line x the
 * zone's road factor (default 1.4).
 */

import { metresBetween } from './supply.js';
import { SETTING_DEFAULTS } from './settings.js';

const fill = (s) => ({ ...SETTING_DEFAULTS, ...(s ?? {}) });

/** Store-to-customer distance by road, for limits and the customer fee. */
export function roadKm(routing, pickup, dropoff, settings = null) {
  if (routing?.source === 'osrm' && Number.isFinite(routing.deliverKm)) {
    return Number(routing.deliverKm.toFixed(2));
  }
  const f = fill(settings).roadFactor;
  return Number(((metresBetween(pickup, dropoff) / 1000) * f).toFixed(2));
}

/** The road distance a stored job was checked against. */
export function jobRoadKm(job, settings = null) {
  if (Number.isFinite(job.roadKm)) return job.roadKm;
  if (job.pickup && job.dropoff) return roadKm(job.routing, job.pickup, job.dropoff, settings);
  return Number(job.distanceKm ?? 0);
}

/** null when deliverable, else the refusal to send. */
export function outOfRange(km, settings = null) {
  const { maxDeliveryKm } = fill(settings);
  if (km <= maxDeliveryKm) return null;
  return {
    error: 'out_of_range',
    message: `The drop-off is ${km.toFixed(1)} km from the store by road; we deliver up to ${maxDeliveryKm} km.`,
    deliverKm: km,
    maxDeliveryKm,
  };
}

/**
 * The customer's delivery fee: the flat fee, plus every km after the included
 * distance at `perKmRate` (the zone's "Per km to customer").
 */
export function customerFee(baseFee, km, settings, perKmRate) {
  const { includedDeliveryKm } = fill(settings);
  const rate = Number(perKmRate ?? 0);
  const extraKm = Number(Math.max(0, km - includedDeliveryKm).toFixed(2));
  const extraKmFee = Number((extraKm * rate).toFixed(2));
  return {
    deliveryFee: Number((baseFee + extraKmFee).toFixed(2)),
    baseFee: Number(baseFee.toFixed(2)),
    roadKm: km,
    includedKm: includedDeliveryKm,
    extraKm,
    extraKmRate: rate,
    extraKmFee,
  };
}
