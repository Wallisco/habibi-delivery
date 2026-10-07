import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Modal, Pressable } from 'react-native';
import { useApp } from '../state/store';
import { Card, Button, Pill, Divider, Label, LiveDot } from '../components/UI';
import { S as SUPPLY, LABELS } from '../lib/supplyState';
import OfferSheet from '../components/OfferSheet';
import { C, T, R, SP, S, SHADOW } from '../theme';

export default function ShiftScreen({ navigation }) {
  const {
    supply, setSupply, offer, job,
    roamingPremium, zone, toast, toastMsg, pendingSync, earnings,
    driver, fetchAccount, fetchMessages, jobs, next,
  } = useApp();

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
            {next ? (
              <Text style={[T.small, { marginTop: 4 }]}>Next: {next.pickup?.name ?? 'next store'}, after this drop</Text>
            ) : null}
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

      {/* The offer card: shared with the delivery screen. */}
      <OfferSheet navigation={navigation} />

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

  toastWrap: { flex: 1, backgroundColor: 'rgba(12,26,18,0.45)', justifyContent: 'center', padding: 30 },
  toast: { backgroundColor: C.white, borderRadius: R.lg, padding: SP.lg },
});
