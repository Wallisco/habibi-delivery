/**
 * Fee engine.
 *
 * The line set mirrors Mr D's payslip exactly, so a driver moving across reads
 * something they already understand and can compare rand for rand. Rates come
 * from the zone's rate card (src/rates.js), which is editable live from the
 * back office.
 *
 * WHY ITEMISE
 * Mr D pays a driver about R53 an order and shows them one number. Our analysis
 * of 78,891 of their legs found 77% of the platform-funded portion is fixed
 * base fees with no time component -- so a courier waiting 25 minutes at a
 * restaurant earns nothing for it and cannot see that they earned nothing for
 * it. Showing every line costs us nothing and is the difference between a
 * driver trusting the number and suspecting it.
 */

/**
 * @param job  the job, after completion
 * @param card the zone's rate card
 * @param ctx  { collectKm, deliverKm, waitMinutes, supplyRatio, premiumMultiplier,
 *               surgeBonus, surgeLabels, tip,
 *               stacked, newStore, batchSize, marginalKm }
 *
 * STACKED ORDERS
 * When `stacked` is true this is the second or third order on a run. The driver
 * is already at the store and already heading that way, so the fixed costs are
 * not repeated -- but the marginal distance, the extra drop and any additional
 * store wait all are. That is the whole economics of batching: the driver earns
 * more per hour while the platform pays less per order.
 */
export function computeEarnings(job, card, ctx = {}) {
  const lines = [];
  const add = (code, label, amount, detail = null, fundedBy = 'platform') => {
    const v = Number(Number(amount).toFixed(2));
    if (v === 0 && code !== 'COLLECTION_BASE') return;
    lines.push({ code, label, detail, amount: v, fundedBy });
  };

  const stacked = Boolean(ctx.stacked);
  const collectKm = Number(ctx.collectKm ?? 0);
  // A stacked order is paid on what it ADDS to the run, not on the whole trip.
  const deliverKm = stacked
    ? Number(ctx.marginalKm ?? 0)
    : Number(ctx.deliverKm ?? job.distanceKm ?? 0);

  if (!stacked) {
    add('COLLECTION_BASE', 'Collection base fee', card.collectionBaseFee,
      'Paid on every collection');
    add('COLLECTION_KM', 'Per km to collection', collectKm * card.perKmCollectionFee,
      `${collectKm.toFixed(1)} km at R${card.perKmCollectionFee.toFixed(3)}/km`);
    add('DELIVERY_BASE', 'Delivery base fee', card.deliveryBaseFee,
      'Paid on every completed delivery');
    add('DELIVERY_KM', 'Per km to customer', deliverKm * card.perKmDeliveryFee,
      `${deliverKm.toFixed(1)} km at R${card.perKmDeliveryFee.toFixed(3)}/km`);
    add('FUEL', 'Fuel surcharge', card.fuelSurchargePerOrder, 'Per order');
  } else {
    // Only when it is a different kitchen -- a second order from the same
    // store costs the driver no extra stop.
    if (ctx.newStore) {
      add('STACKED_COLLECTION', 'Extra store on this run', card.stackedCollectionBaseFee,
        'Second collection point');
      add('COLLECTION_KM', 'Per km between stores',
        Number(ctx.collectKm ?? 0) * card.perKmCollectionFee,
        `${Number(ctx.collectKm ?? 0).toFixed(1)} km at R${card.perKmCollectionFee.toFixed(3)}/km`);
    }
    add('STACKED_DELIVERY', 'Extra drop on this run', card.stackedDeliveryBaseFee,
      `Order ${ctx.batchSize ?? 2} of ${ctx.batchSize ?? 2} on one run`);
    add('DELIVERY_KM', 'Extra km for this drop', deliverKm * card.perKmDeliveryFee,
      `${deliverKm.toFixed(1)} km added to the route at R${card.perKmDeliveryFee.toFixed(3)}/km`);
    add('FUEL', 'Fuel surcharge', card.stackedFuelSurcharge, 'Reduced on a stacked order');
  }

  if ((job.bagCount ?? 1) > 1 && card.perExtraBagFee > 0) {
    const extra = job.bagCount - 1;
    add('BAGS', 'Extra bags', extra * card.perExtraBagFee,
      `${extra} extra bag${extra > 1 ? 's' : ''} at R${card.perExtraBagFee.toFixed(2)}`);
  }

  // Premium. Mr D pays a flat R10 on 24.3% of legs by a rule their drivers
  // cannot see. Ours scales with the measured supply ratio for this zone, so
  // it rises exactly when drivers are scarce and costs nothing when they
  // are not.
  const mult = Number(ctx.premiumMultiplier ?? 0);
  if (mult > 0) {
    add('PREMIUM', 'Premium fee', card.premiumFee * mult,
      `Zone was short of drivers · ${mult.toFixed(2)}× premium`);
  }

  // Scheduled surge. Distinct from the premium: the premium reacts to a
  // shortage happening now, surge is planned against a demand curve we already
  // know -- 17:00-19:00 carries about 35% of food volume. A driver deciding on
  // Wednesday whether to work Friday needs to see Friday's rate on Wednesday.
  const surge = Number(ctx.surgeBonus ?? 0);
  if (surge > 0) {
    const labels = (ctx.surgeLabels ?? []).join(' + ');
    add('SURGE', 'Busy period bonus', surge, labels || 'Scheduled busy period');
  }

  // Restaurant delay. Same rate and trigger as Mr D. The difference is that
  // theirs pays out on 3.46% of legs while their couriers wait a median 13.3
  // minutes; ours will pay far more often, which is the entire point.
  // Waiting is paid in full on every order, stacked or not. Time standing
  // still is time standing still, whether it is the first kitchen or the third.
  const wait = Number(ctx.waitMinutes ?? 0);
  if (wait > card.restaurantDelayFreeMinutes) {
    const payable = wait - card.restaurantDelayFreeMinutes;
    const amount = Math.min(
      payable * card.restaurantDelayPerMinute, card.restaurantDelayCapRands);
    add('DELAY', 'Restaurant delay fee', amount,
      `${payable.toFixed(0)} min past the first ${card.restaurantDelayFreeMinutes} at ` +
      `R${card.restaurantDelayPerMinute.toFixed(2)}/min` +
      (payable * card.restaurantDelayPerMinute > card.restaurantDelayCapRands
        ? ` · capped at R${card.restaurantDelayCapRands.toFixed(2)}` : ''));
  }

  const platformFunded = lines.reduce((a, l) => a + l.amount, 0);

  const tip = Number(ctx.tip ?? 0);
  if (tip > 0) {
    add('TIP', 'Customer tip', tip, 'Every cent of every tip is yours', 'customer');
  }

  return {
    lines,
    platformFunded: Number(platformFunded.toFixed(2)),
    tip: Number(tip.toFixed(2)),
    total: Number(lines.reduce((a, l) => a + l.amount, 0).toFixed(2)),
    waitMinutes: Number(wait.toFixed(1)),
    premiumMultiplier: mult,
    stacked,
    batchSize: ctx.batchSize ?? 1,
    zone: job.zone ?? null,
  };
}

/**
 * Cost to serve, from the operator's side. Tips are the customer's money and
 * are deliberately excluded -- including them would flatter driver pay and
 * understate what we actually fund.
 */
export function costToServe(earnings, { quikrPerOrder = 3.00, infraPerOrder = 0.04 } = {}) {
  const driver = earnings.platformFunded;
  return {
    driver,
    software: quikrPerOrder,
    infrastructure: infraPerOrder,
    total: Number((driver + quikrPerOrder + infraPerOrder).toFixed(2)),
  };
}
