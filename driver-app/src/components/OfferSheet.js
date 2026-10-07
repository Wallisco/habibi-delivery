import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Modal, Pressable } from 'react-native';
import { useApp } from '../state/store';
import { Button, Pill } from './UI';
import MapPanel from './MapPanel';
import { C, T, R, SP, SHADOW, Z } from '../theme';

/** Seconds to accept. Dispatch holds an offer for 45 s (OFFER_TIMEOUT_MS). */
export const OFFER_SECONDS = 45;

/** "14 Pienaar Road, Milnerton, Cape Town" -> "Milnerton". The spec shows the suburb. */
export function suburbOf(name) {
  const parts = String(name ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return 'Address not supplied';
  return parts.length > 1 ? parts[1] : parts[0];
}

/** Is this screen the one in front? Home stays mounted under a delivery. */
function useFocused(navigation) {
  const [focused, setFocused] = useState(() => navigation?.isFocused?.() ?? true);
  useEffect(() => {
    if (!navigation?.addListener) return undefined;
    const offFocus = navigation.addListener('focus', () => setFocused(true));
    const offBlur = navigation.addListener('blur', () => setFocused(false));
    return () => { offFocus?.(); offBlur?.(); };
  }, [navigation]);
  return focused;
}

/**
 * The offer card. On Home, and during a delivery: a driver still riding to
 * collect their order can be offered a second one for the same run.
 *
 * Running out of time is not a decline: the offer simply expires, the driver
 * is told so, and dispatch gives the job to someone else.
 *
 * Fits the sheet on a 360×640 phone: pay, where from and to, one line of
 * detail, Accept and Decline. Nothing to scroll in 45 seconds.
 */
export default function OfferSheet({ navigation }) {
  const { offer, acceptOffer, declineOffer, expireOffer } = useApp();
  // Only the screen in front shows it, or the driver would see it twice.
  const focused = useFocused(navigation);
  const shown = !!offer && focused;
  const [left, setLeft] = useState(OFFER_SECONDS);
  const expire = useRef(expireOffer);
  expire.current = expireOffer;

  useEffect(() => {
    setLeft(OFFER_SECONDS);
    if (!shown) return undefined;
    const t = setInterval(() => {
      setLeft((v) => { if (v <= 1) { clearInterval(t); expire.current(); return 0; } return v - 1; });
    }, 1000);
    return () => clearInterval(t);
  }, [offer?.id, shown]); // eslint-disable-line react-hooks/exhaustive-deps

  // Bonuses worth knowing about in one line: "Busy period +R8 · Waiting +R4".
  const extras = (offer?.earningsPreview?.lines ?? [])
    .filter((l) => ['SURGE', 'PREMIUM', 'DELAY'].includes(l.code))
    .map((l) => `${l.label} +R${l.amount.toFixed(0)}`);
  const pay = offer ? (offer.summary?.totalEarnings ?? offer.earningsPreview?.total ?? offer.fee ?? 0) : 0;
  const bags = offer?.bagCount ?? 1;
  // "5 items · 2 bags", only when Keychat sent what is in the order.
  const items = offer?.items?.length ? offer.itemCount : 0;

  return (
    <Modal visible={shown} transparent animationType="slide" onRequestClose={declineOffer}>
      <View style={st.sheetWrap}>
        <View style={[st.sheet, SHADOW.lift]}>
          {offer && (
            <>
              <View style={st.grabber} />
              <View style={st.sheetTop}>
                <Pill text={offer.orderNumber ?? (offer.kind === 'ROAMING' ? 'LONG RUN' : 'LOCAL')}
                  tone={offer.kind === 'ROAMING' ? 'forest' : 'live'} />
                <View style={st.timerWrap}>
                  <Text style={st.timer}>{left}</Text>
                  <Text style={st.timerUnit}>s</Text>
                </View>
              </View>

              {offer.addsToRun ? (
                <View style={[st.runBanner, { marginTop: SP.sm }]}>
                  <Text style={st.runBannerText}>Adds to your current run</Text>
                  <Text style={st.runBannerSub}>
                    Same pickup area · {offer.stops?.length ?? 0} stops in all
                  </Text>
                </View>
              ) : null}

              {/* The customer commits their tip at checkout, so this is the
                  real number, not an estimate. A driver deciding in 45
                  seconds should not have to guess what a job pays. */}
              <View style={st.feeRow}>
                <Text style={st.fee}>R{Number(pay).toFixed(0)}</Text>
                <Text style={[T.small, st.feeNote]} numberOfLines={2}>
                  {offer.tip > 0 ? `incl. R${offer.tip.toFixed(0)} tip` : 'no tip'}
                  {extras.length ? ` · ${extras.join(' · ')}` : ''}
                </Text>
              </View>

              <MapPanel pickup={offer.pickup} dropoff={offer.dropoff} height={Z.mapOffer} />
              {offer.jobs?.length > 1 ? (
                <View style={st.runBanner}>
                  <Text style={st.runBannerText}>
                    {offer.jobs.length} orders on one run
                    {offer.summary?.stores > 1 ? ` from ${offer.summary.stores} stores` : ''}
                    {offer.summary?.sameCustomer ? ' · same customer' : ''}
                  </Text>
                  <Text style={st.runBannerSub}>
                    {offer.stops?.length ?? 0} stops · {offer.summary?.km ?? '–'} km ·
                    about {Math.round(offer.summary?.minutes ?? 0)} min
                  </Text>
                </View>
              ) : null}

              <View style={st.addr}>
                <Text style={T.label}>COLLECT FROM</Text>
                <Text style={st.addrText} numberOfLines={1}>{offer.pickup?.name ?? 'Collection point'}</Text>
                <Text style={[T.label, { marginTop: SP.xs }]}>
                  DELIVER TO{offer.jobs?.length > 1 ? ` (${offer.jobs.length})` : ''}
                </Text>
                {(offer.jobs?.length ? offer.jobs : [offer]).map((j) => (
                  <Text key={j.id} style={st.addrText} numberOfLines={1}>{suburbOf(j.dropoff?.name)}</Text>
                ))}
              </View>
              <Text style={T.small}>
                {offer.distanceKm} km{offer.distanceSource === 'navigation' ? '' : ' approx'}
                {items ? ` · ${items} item${items === 1 ? '' : 's'}` : ''}
                {' · '}{bags} bag{bags === 1 ? '' : 's'}
                {' · '}food ready {offer.readyInMinutes === 0 ? 'now' : `in ~${offer.readyInMinutes} min`}
              </Text>
              {offer.ageRestricted && (
                <View style={st.warn}>
                  <Text style={st.warnText}>Age restricted. Hand it to the customer.</Text>
                </View>
              )}

              <Button title={offer.addsToRun ? 'Add to my run' : 'Accept trip'} kind="live"
                onPress={acceptOffer} style={{ marginTop: SP.md }} />
              <Pressable onPress={declineOffer} style={st.decline} accessibilityRole="button">
                <Text style={st.declineText}>Decline</Text>
              </Pressable>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const st = StyleSheet.create({
  sheetWrap: { flex: 1, backgroundColor: 'rgba(12,26,18,0.5)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: C.white, borderTopLeftRadius: R.lg, borderTopRightRadius: R.lg,
    paddingHorizontal: SP.lg, paddingBottom: SP.sm, paddingTop: SP.sm,
  },
  grabber: {
    width: 40, height: 4, borderRadius: 2, backgroundColor: C.line,
    alignSelf: 'center', marginBottom: SP.sm,
  },
  sheetTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  timerWrap: { flexDirection: 'row', alignItems: 'baseline' },
  timer: { ...T.h1, color: C.red },
  timerUnit: { ...T.h3, color: C.red, marginLeft: 1 },
  feeRow: { flexDirection: 'row', alignItems: 'center', gap: SP.sm, marginVertical: SP.xs },
  fee: { ...T.hero, color: C.ink },
  feeNote: { flex: 1 },
  runBanner: { backgroundColor: C.live, borderRadius: R.sm, padding: SP.sm, marginBottom: SP.sm },
  runBannerText: { ...T.h3, color: C.forest },
  runBannerSub: { ...T.tiny, color: C.forest },
  addr: { backgroundColor: C.wash, borderRadius: R.sm, padding: SP.sm, marginBottom: SP.xs },
  addrText: { ...T.h3, color: C.ink },
  warn: { backgroundColor: C.wash, borderRadius: R.sm, padding: SP.sm, marginTop: SP.xs },
  warnText: { ...T.small, color: C.amber, fontWeight: '700' },
  decline: { minHeight: Z.tap, alignItems: 'center', justifyContent: 'center' },
  declineText: { ...T.body, color: C.muted, fontWeight: '700' },
});
