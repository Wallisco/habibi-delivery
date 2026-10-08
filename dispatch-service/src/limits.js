/**
 * How far we deliver, what a long delivery costs the customer, and when an
 * order rides alone.
 *
 *   maxDeliveryKm        11 km by road, store to customer. Further is refused
 *                        (`out_of_range`). As the crow flies that is about
 *                        7.9 km: road = straight line x 1.4.
 *   includedDeliveryKm    5 km by road is covered by the flat delivery fee.
 *                        Every km after that is added to the customer's fee at
 *                        the zone's "Per km to customer" rate.
 *   noStackBeyondKm       7 km by road. An order going further is never put on
 *                        a run with another order.
 *   maxReadyToDropMin    30 min from the food being ready to it reaching the
 *                        customer. A run that would break it is never formed,
 *                        and a run already on the road that drifts past it
 *                        loses its later order to another driver.
 *
 * All four sit on the zone's rate card, so the back office Pricing tab sets
 * them per zone like any other rate.
 */

import { metresBetween } from './supply.js';

/** Road distance from straight-line distance, when no road route is known. */
export const CROW_TO_ROAD = 1.4;

export const LIMIT_DEFAULTS = {
  maxDeliveryKm: 11,
  includedDeliveryKm: 5,
  noStackBeyondKm: 7,
  maxReadyToDropMin: 30,
};

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

/** The four limits for a zone's card, with the defaults filling any gap. */
export function limitsOf(card = {}) {
  return {
    maxDeliveryKm: num(card.maxDeliveryKm, LIMIT_DEFAULTS.maxDeliveryKm),
    includedDeliveryKm: num(card.includedDeliveryKm, LIMIT_DEFAULTS.includedDeliveryKm),
    noStackBeyondKm: num(card.noStackBeyondKm, LIMIT_DEFAULTS.noStackBeyondKm),
    maxReadyToDropMin: num(card.maxReadyToDropMin, LIMIT_DEFAULTS.maxReadyToDropMin),
  };
}

/**
 * Store-to-customer distance by road, for limits and the customer fee.
 * The road route when we have one; otherwise straight line x 1.4.
 */
export function roadKm(routing, pickup, dropoff) {
  if (routing?.source === 'osrm' && Number.isFinite(routing.deliverKm)) {
    return Number(routing.deliverKm.toFixed(2));
  }
  return Number(((metresBetween(pickup, dropoff) / 1000) * CROW_TO_ROAD).toFixed(2));
}

/** The road distance a stored job was checked against. */
export function jobRoadKm(job) {
  if (Number.isFinite(job.roadKm)) return job.roadKm;
  if (job.pickup && job.dropoff) return roadKm(job.routing, job.pickup, job.dropoff);
  return Number(job.distanceKm ?? 0);
}

/** null when deliverable, else the refusal to send. */
export function outOfRange(km, card) {
  const { maxDeliveryKm } = limitsOf(card);
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
 * distance at the zone's "Per km to customer" rate.
 */
export function customerFee(baseFee, km, card) {
  const { includedDeliveryKm } = limitsOf(card);
  const rate = Number(card.perKmDeliveryFee ?? 0);
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
