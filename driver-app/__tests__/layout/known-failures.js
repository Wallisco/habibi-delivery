/**
 * Screens that do not fit yet. Step 2 of the playbook empties this list.
 *
 * It can only shrink: a listed screen that fits fails the test until its line
 * is removed, and a screen that stops fitting fails unless someone adds it here
 * on purpose. Keys are `Screen/state@WIDTHxHEIGHT`, as printed by the test.
 *
 * Measured on 7 Oct 2026 (Step 0). Every one is a screen-sized ScrollView of
 * stacked cards: spec irritation 6.
 */
export const KNOWN_FAILURES = [
  'Shift/online@360x640',
  'Shift/online@390x844',
  'Shift/offer@360x640',
  'Shift/offer@390x844', // the offer sheet is taller than the screen
  'Delivery/to-store@360x640',
  'Delivery/to-store@390x844',
  'Delivery/at-door@360x640',
  'Delivery/at-door@390x844',
  'Delivery/run-of-3@360x640',
  'Delivery/run-of-3@390x844',
  'Trips/8-trips@360x640',
  'Trips/8-trips@390x844',
  'TripDetail/single@360x640',
  'TripDetail/single@390x844',
  'TripDetail/stacked@360x640',
  'TripDetail/stacked@390x844',
  'Messages/6-messages@360x640',
  'Earnings/loaded@360x640',
  'Earnings/loaded@390x844',
];
