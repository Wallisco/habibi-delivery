import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Modal, Pressable } from 'react-native';
import { useApp } from '../state/store';
import { Card, Button, Row, Pill, Divider, Label, LiveDot } from '../components/UI';
import { S as SUPPLY, LABELS } from '../lib/supplyState';
import MapPanel from '../components/MapPanel';
import { C, T, R, SP, S, SHADOW } from '../theme';

const OFFER_SECONDS = 25;

export default function ShiftScreen({ navigation }) {
  const {
    supply, setSupply, offer, acceptOffer, declineOffer, job,
    roamingPremium, zone, toast, toastMsg, pendingSync, earnings,
    driver, fetchAccount, fetchMessages, jobs,
  } = useApp();

  const [left, setLeft] = useState(OFFER_SECONDS);
  const [account, setAccount] = useState(null);
  const [unread, setUnread] = useState(0);

  // A driver who has not cleared onboarding sees a checklist instead of a
  // Go online button, so the reason they cannot work is on screen rather than
  // discovered by tapping and being refused.
  useEffect(() => {
    if (!driver) return;
    fetchAccount().then(setAccount).catch(() => {});
    const t = setInterval(() =>
      fetchMessages().then((d) => setUnread(d.unread ?? 0)).catch(() => {}), 15000);
    fetchMessages().then((d) => setUnread(d.unread ?? 0)).catch(() => {});
    return () => clearInterval(t);
  }, [driver, fetchAccount, fetchMessages]);

  // Timing out is the same as declining: the job returns to the pool rather
  // than dying with this driver.
  useEffect(() => {
    if (!offer) { setLeft(OFFER_SECONDS); return; }
    setLeft(OFFER_SECONDS);
    const t = setInterval(() => {
      setLeft((v) => { if (v <= 1) { clearInterval(t); declineOffer(); return 0; } return v - 1; });
    }, 1000);
    return () => clearInterval(t);
  }, [offer, declineOffer]);

  useEffect(() => { if (job) navigation.navigate('ActiveJob'); }, [job, navigation]);

  const online = supply !== SUPPLY.OFFLINE;
  const label = LABELS[supply];
  const today = earnings?.today ?? { orders: 0, delivery: 0, tips: 0 };
  const pct = Math.min(100, Math.round((today.orders / 11) * 100));

  return (
    <ScrollView style={S.screen} contentContainerStyle={S.content}>

      {/* The hero surface is the app's whole status signal: deep green when
          you are earning, white when you are not. */}
      <Card tone={online ? 'forest' : 'plain'} style={st.hero}>
        <View style={st.heroTop}>
          <View style={st.stateRow}>
            {online && <LiveDot />}
            <View style={{ marginLeft: online ? SP.sm : 0 }}>
              <Text style={[T.h2, online && { color: C.white }]}>{label.title}</Text>
              <Text style={[T.small, online && { color: 'rgba(255,255,255,0.66)' }]}>
                {label.sub}
              </Text>
            </View>
          </View>
          <Pill text={zone} tone={online ? 'onDark' : 'wash'} />
        </View>

        {online && (
          <>
            <Divider onDark />
            <Text style={st.heroLabel}>EARNED TODAY</Text>
            <Text style={st.heroFig}>R{today.delivery + today.tips}</Text>
            <View style={st.track}>
              <View style={[st.fill, { width: `${pct}%` }]} />
            </View>
            <Text style={st.trackNote}>{today.orders} of about 11 trips this shift</Text>
          </>
        )}

        {account && account.canWork === false ? (
          <View style={{ marginTop: SP.lg }}>
            <Pill text="ACCOUNT NOT ACTIVE YET" tone="amber" />
            <Text style={[T.small, { marginTop: SP.sm }]}>
              {account.outstanding?.length
                ? `Still needed: ${account.outstanding.join(', ')}.`
                : 'The office is reviewing your documents.'}
            </Text>
            <Button title="Message the office" kind="ghost"
              onPress={() => navigation.navigate('Messages')} style={{ marginTop: SP.md }} />
          </View>
        ) : supply === SUPPLY.OFFLINE ? (
          <Button title="Go online" subtitle={`${zone} · jobs held until food is ready`}
            kind="live" onPress={() => setSupply(SUPPLY.ZONE_COMMITTED)}
            style={{ marginTop: SP.lg }} />
        ) : (
          <View style={{ marginTop: SP.lg }}>
            {supply === SUPPLY.ZONE_COMMITTED && (
              <Button
                title="Include long runs"
                subtitle={roamingPremium > 0
                  ? `Paying ${Math.round(roamingPremium * 100)}% extra right now`
                  : 'Trips outside your zone'}
                kind="live"
                onPress={() => setSupply(SUPPLY.ROAMING_ELIGIBLE)} />
            )}
            {supply === SUPPLY.ROAMING_ELIGIBLE && (
              <Button title="Zone trips only" kind="ghost"
                onPress={() => setSupply(SUPPLY.ZONE_COMMITTED)}
                style={{ borderColor: 'rgba(255,255,255,0.25)' }} />
            )}
            {supply === SUPPLY.RETURNING && (
              <Text style={st.returning}>
                Looking for something heading back toward {zone} so the trip is not one-way.
              </Text>
            )}
            {supply !== SUPPLY.ROAMING_ACTIVE && (
              <Pressable onPress={() => setSupply(SUPPLY.OFFLINE)} style={st.offline}
                accessibilityRole="button">
                <Text style={st.offlineText}>Go offline</Text>
              </Pressable>
            )}
          </View>
        )}
      </Card>

      {job && (
        <>
          <Label style={{ marginTop: SP.xl }}>DELIVERY IN PROGRESS</Label>
          <Card tone="wash">
            <Text style={T.h3}>
              {jobs?.length > 1 ? `Run of ${jobs.length} orders` : job.pickup?.name}
            </Text>
            <Text style={[T.small, { marginTop: 4 }]}>
              {jobs?.length > 1
                ? `${jobs.filter((j) => !j.done).length} still to deliver`
                : `to ${(job.dropoff?.name ?? 'Delivery address').split(',')[0]}`}
            </Text>
            <Button title="Continue delivery" kind="live"
              onPress={() => navigation.navigate('ActiveJob')} style={{ marginTop: SP.md }} />
          </Card>
        </>
      )}

      {online && !offer && !job && (
        <>
          <Label style={{ marginTop: SP.xl }}>NEXT UP</Label>
          <Card>
            <Text style={T.h3}>Waiting for a trip</Text>
            <Text style={[T.small, { marginTop: 5 }]}>
              We hold jobs back until the kitchen is nearly done, so you are not standing
              around waiting for food.
            </Text>
          </Card>
        </>
      )}

      {pendingSync > 0 && (
        <Card style={{ marginTop: SP.md, borderColor: C.amber, borderWidth: 1.5 }}>
          <Pill text="OFFLINE COMPLETIONS" tone="amber" />
          <Text style={[T.h3, { marginTop: SP.sm }]}>{pendingSync} waiting to sync</Text>
          <Text style={[T.small, { marginTop: 4 }]}>
            You can take {Math.max(0, 3 - pendingSync)} more before you need to find coverage.
          </Text>
        </Card>
      )}

      <Button
        title={unread ? `Office · ${unread} new` : 'Message the office'}
        kind={unread ? 'live' : 'ghost'}
        onPress={() => navigation.navigate('Messages')} style={{ marginTop: SP.xl }} />
      <Button title="Your trips" kind="ghost" onPress={() => navigation.navigate('Jobs')}
        style={{ marginTop: SP.sm }} />
      <Button title="Earnings" kind="ghost" onPress={() => navigation.navigate('Earnings')}
        style={{ marginTop: SP.sm }} />

      {/* --------------------------------------------------------- offer sheet */}
      <Modal visible={!!offer} transparent animationType="slide" onRequestClose={declineOffer}>
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

                {/* The customer commits their tip at checkout, so this is the
                    real number, not an estimate. A driver deciding in 25
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

                <Button title="Accept trip" kind="live" onPress={acceptOffer}
                  style={{ marginTop: SP.lg }} />
                <Pressable onPress={declineOffer} style={st.decline} accessibilityRole="button">
                  <Text style={st.declineText}>Decline</Text>
                </Pressable>
              </>
            )}
          </View>
        </View>
      </Modal>

      {/* -------------------------------------------------------------- toast */}
      <Modal visible={!!toast} transparent animationType="fade" onRequestClose={() => toastMsg(null)}>
        <Pressable style={st.toastWrap} onPress={() => toastMsg(null)}>
          <View style={[st.toast, SHADOW.lift]}>
            <Text style={T.body}>{toast}</Text>
            <Text style={[T.tiny, { marginTop: SP.md }]}>Tap anywhere to dismiss</Text>
          </View>
        </Pressable>
      </Modal>
    </ScrollView>
  );
}

const st = StyleSheet.create({
  hero: { paddingVertical: SP.lg },
  heroTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  stateRow: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  heroLabel: { ...T.label, color: 'rgba(255,255,255,0.6)' },
  heroFig: { ...T.money, color: C.white, marginTop: 2 },
  track: {
    height: 7, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.16)',
    overflow: 'hidden', marginTop: SP.md,
  },
  fill: { height: 7, borderRadius: 4, backgroundColor: C.live },
  trackNote: { ...T.tiny, color: 'rgba(255,255,255,0.62)', marginTop: SP.sm },
  returning: { ...T.small, color: 'rgba(255,255,255,0.78)' },
  offline: { paddingVertical: 15, alignItems: 'center', marginTop: SP.xs },
  offlineText: { color: 'rgba(255,255,255,0.65)', fontSize: 15, fontWeight: '600' },

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
  runBannerSub: { fontSize: 12, color: C.forest, opacity: .8, marginTop: 2 },
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

  toastWrap: { flex: 1, backgroundColor: 'rgba(12,26,18,0.45)', justifyContent: 'center', padding: 30 },
  toast: { backgroundColor: C.white, borderRadius: R.lg, padding: SP.lg },
});
