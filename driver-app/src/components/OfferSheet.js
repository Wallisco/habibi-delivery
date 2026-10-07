import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Modal, Pressable } from 'react-native';
import { useApp } from '../state/store';
import { Button, Row, Pill, Divider } from './UI';
import MapPanel from './MapPanel';
import { C, T, SP, SHADOW } from '../theme';

/** Seconds to accept. Dispatch holds an offer for 45 s (OFFER_TIMEOUT_MS). */
export const OFFER_SECONDS = 45;

/**
 * The offer card. On Home, and during a delivery: a driver still riding to
 * collect their order can be offered a second one for the same run.
 *
 * Running out of time is not a decline: the offer simply expires, the driver
 * is told so, and dispatch gives the job to someone else.
 */
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
                <View style={[st.runBanner, { marginTop: SP.md }]}>
                  <Text style={st.runBannerText}>Adds to your current run</Text>
                  <Text style={st.runBannerSub}>
                    Same pickup area · {offer.stops?.length ?? 0} stops in all
                  </Text>
                </View>
              ) : null}

              {/* The customer commits their tip at checkout, so this is the
                  real number, not an estimate. A driver deciding in 45
                  seconds should not have to guess what a job pays. */}
              <Text style={st.fee}>R{(offer.summary?.totalEarnings
                ?? offer.earningsPreview?.total ?? offer.fee).toFixed(0)}</Text>
              <Text style={[T.small, { marginTop: -2 }]}>
                {offer.tip > 0
                  ? `includes R${offer.tip.toFixed(0)} tip the customer already added`
                  : 'no tip on this one'}
              </Text>

              {offer.earningsPreview?.lines?.length ? (
                <View style={st.mini}>
                  {offer.earningsPreview.lines
                    .filter((l) => ['SURGE', 'PREMIUM', 'DELAY', 'TIP'].includes(l.code))
                    .map((l) => (
                      <View key={l.code} style={st.miniRow}>
                        <Text style={st.miniLabel}>{l.label}</Text>
                        <Text style={st.miniAmt}>+R{l.amount.toFixed(2)}</Text>
                      </View>
                    ))}
                </View>
              ) : null}

              <Divider />
              <MapPanel pickup={offer.pickup} dropoff={offer.dropoff} height={140} />
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
                <Text style={st.addrText}>{offer.pickup?.name ?? 'Collection point'}</Text>
                <Text style={[T.label, { marginTop: SP.sm }]}>
                  DELIVER TO{offer.jobs?.length > 1 ? ` (${offer.jobs.length})` : ''}
                </Text>
                {(offer.jobs?.length ? offer.jobs : [offer]).map((j) => (
                  <Text key={j.id} style={st.addrText}>
                    {j.dropoff?.name ?? 'Address not supplied'}
                  </Text>
                ))}
              </View>
              <Row label="Distance"
                value={`${offer.distanceKm} km${offer.distanceSource === 'navigation' ? '' : ' approx'}`} />
              <Row label="Bags to scan" value={String(offer.bagCount)} />
              <Row label="Food ready"
                value={offer.readyInMinutes === 0 ? 'now' : `in ~${offer.readyInMinutes} min`} />
              {offer.ageRestricted && (
                <View style={st.warn}>
                  <Text style={st.warnText}>
                    Age restricted. This must be handed to the customer.
                  </Text>
                </View>
              )}

              <Button title={offer.addsToRun ? 'Add to my run' : 'Accept trip'} kind="live"
                onPress={acceptOffer} style={{ marginTop: SP.lg }} />
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
    backgroundColor: C.white, borderTopLeftRadius: 28, borderTopRightRadius: 28,
    paddingHorizontal: 26, paddingBottom: 34, paddingTop: SP.sm,
  },
  grabber: {
    width: 40, height: 4, borderRadius: 2, backgroundColor: C.line,
    alignSelf: 'center', marginBottom: SP.lg,
  },
  sheetTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  timerWrap: { flexDirection: 'row', alignItems: 'baseline' },
  timer: { fontSize: 30, fontWeight: '800', color: C.red, letterSpacing: -1 },
  timerUnit: { fontSize: 14, fontWeight: '700', color: C.red, marginLeft: 1 },
  fee: { ...T.money, fontSize: 58, marginTop: SP.md },
  runBanner: { backgroundColor: C.live, borderRadius: 12, padding: 11, marginBottom: SP.sm },
  runBannerText: { fontSize: 14.5, fontWeight: '800', color: C.forest },
  runBannerSub: { fontSize: 12, color: C.forest, opacity: 0.8, marginTop: 2 },
  addr: { backgroundColor: C.wash, borderRadius: 12, padding: 13, marginBottom: SP.sm },
  addrText: { fontSize: 16, fontWeight: '700', color: C.ink, marginTop: 2, lineHeight: 21 },
  mini: { backgroundColor: C.wash, borderRadius: 12, padding: 12, marginTop: SP.md },
  miniRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  miniLabel: { fontSize: 13, color: C.green, fontWeight: '600', flex: 1 },
  miniAmt: { fontSize: 13, color: C.green, fontWeight: '800' },
  warn: { backgroundColor: '#FDF3E2', borderRadius: 12, padding: 13, marginTop: SP.sm },
  warnText: { color: C.amber, fontSize: 13.5, fontWeight: '600' },
  decline: { paddingVertical: 16, alignItems: 'center' },
  declineText: { color: C.muted, fontSize: 15.5, fontWeight: '700' },
});
