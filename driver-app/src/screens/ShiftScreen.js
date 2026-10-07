import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Modal, Pressable } from 'react-native';
import { useApp } from '../state/store';
import { Card, Button, Pill, LiveDot } from '../components/UI';
import { S as SUPPLY, LABELS } from '../lib/supplyState';
import OfferSheet from '../components/OfferSheet';
import { C, T, R, SP, S, SHADOW, Z } from '../theme';

/**
 * Home. Fits a 360×640 phone with nothing to scroll: who you are working as,
 * one action, and the way to everything else along the bottom.
 */
export default function ShiftScreen({ navigation }) {
  const {
    supply, setSupply, offer, job,
    roamingPremium, zone, toast, toastMsg, pendingSync, earnings,
    driver, fetchAccount, fetchMessages, jobs,
  } = useApp();

  const [account, setAccount] = useState(null);
  const [unread, setUnread] = useState(0);

  // A driver who has not cleared onboarding sees what is missing instead of a
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
  const onDark = online ? { color: C.white } : null;

  return (
    <View style={S.page}>

      {/* The status card is the app's whole status signal: deep green when
          you are earning, white when you are not. */}
      <Card tone={online ? 'forest' : 'plain'}>
        <View style={st.top}>
          <View style={st.stateRow}>
            {online && <LiveDot />}
            <View style={{ marginLeft: online ? SP.sm : 0, flex: 1 }}>
              <Text style={[T.h3, onDark]}>{label.title}</Text>
              <Text style={[T.small, online && st.subOnDark]}>{label.sub}</Text>
            </View>
          </View>
          <Pill text={zone} tone={online ? 'onDark' : 'wash'} />
        </View>

        {online && (
          <>
            <View style={st.earnedRow}>
              <Text style={st.earnedLabel}>EARNED TODAY</Text>
              <Text style={st.earned}>R{today.delivery + today.tips}</Text>
            </View>
            <View style={st.track}><View style={[st.fill, { width: `${pct}%` }]} /></View>
            <Text style={st.trackNote}>{today.orders} of about 11 trips this shift</Text>
          </>
        )}

        {account && account.canWork === false ? (
          <View style={{ marginTop: SP.md }}>
            <Pill text="ACCOUNT NOT ACTIVE YET" tone="amber" />
            <Text style={[T.small, { marginTop: SP.xs }]}>
              {account.outstanding?.length
                ? `Still needed: ${account.outstanding.join(', ')}.`
                : 'The office is reviewing your documents.'}
            </Text>
          </View>
        ) : supply === SUPPLY.OFFLINE ? (
          <Button title="Go online" subtitle={`${zone} · jobs held until food is ready`}
            kind="live" onPress={() => setSupply(SUPPLY.ZONE_COMMITTED)}
            style={{ marginTop: SP.md }} />
        ) : (
          <View style={st.onlineActions}>
            {supply === SUPPLY.ZONE_COMMITTED && (
              <Button title="Include long runs" kind="ghost" style={st.darkGhost} textColor={C.white}
                subtitle={roamingPremium > 0 ? `+${Math.round(roamingPremium * 100)}% now` : null}
                onPress={() => setSupply(SUPPLY.ROAMING_ELIGIBLE)} />
            )}
            {supply === SUPPLY.ROAMING_ELIGIBLE && (
              <Button title="Zone trips only" kind="ghost" style={st.darkGhost} textColor={C.white}
                onPress={() => setSupply(SUPPLY.ZONE_COMMITTED)} />
            )}
            {supply === SUPPLY.RETURNING && (
              <Text style={[st.returning, { flex: 1 }]}>
                Looking for a trip back toward {zone}.
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

      {job ? (
        <Card tone="wash" style={st.gap}>
          <Text style={T.h3} numberOfLines={1}>
            {jobs?.length > 1 ? `Run of ${jobs.length} orders` : job.pickup?.name}
          </Text>
          <Text style={T.small} numberOfLines={1}>
            {jobs?.length > 1
              ? `${jobs.filter((j) => !j.done).length} still to deliver`
              : `to ${(job.dropoff?.name ?? 'Delivery address').split(',')[0]}`}
          </Text>
          <Button title="Continue delivery" kind="live"
            onPress={() => navigation.navigate('ActiveJob')} style={{ marginTop: SP.sm }} />
        </Card>
      ) : null}

      {online && !offer && !job ? (
        <Text style={[T.small, st.gap]}>
          Waiting for a trip. Jobs come when the kitchen is nearly done, so you are not
          left standing around.
        </Text>
      ) : null}

      {pendingSync > 0 ? (
        <Card style={[st.gap, st.sync]}>
          <Text style={T.h3}>{pendingSync} offline completion{pendingSync > 1 ? 's' : ''} to sync</Text>
          <Text style={T.small}>
            You can take {Math.max(0, 3 - pendingSync)} more before you need signal.
          </Text>
        </Card>
      ) : null}

      <View style={{ flex: 1 }} />

      {/* Everything else, one tap away along the bottom. */}
      <View style={st.bottomRow}>
        <Button title={unread ? `Messages · ${unread}` : 'Messages'} kind={unread ? 'live' : 'ghost'}
          onPress={() => navigation.navigate('Messages')} style={st.bottomBtn} />
        <Button title="Trips" kind="ghost" onPress={() => navigation.navigate('Jobs')}
          style={st.bottomBtn} />
        <Button title="Earnings" kind="ghost" onPress={() => navigation.navigate('Earnings')}
          style={st.bottomBtn} />
      </View>

      {/* The offer card: shared with the delivery screen. */}
      <OfferSheet navigation={navigation} />

      <Modal visible={!!toast} transparent animationType="fade" onRequestClose={() => toastMsg(null)}>
        <Pressable style={st.toastWrap} onPress={() => toastMsg(null)}>
          <View style={[st.toast, SHADOW.lift]}>
            <Text style={T.body}>{toast}</Text>
            <Text style={[T.tiny, { marginTop: SP.md }]}>Tap anywhere to dismiss</Text>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const st = StyleSheet.create({
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  stateRow: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  subOnDark: { color: 'rgba(255,255,255,0.66)' },
  earnedRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: SP.md },
  earnedLabel: { ...T.label, color: 'rgba(255,255,255,0.6)' },
  earned: { ...T.h1, color: C.white },
  track: {
    height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.16)',
    overflow: 'hidden', marginTop: SP.xs,
  },
  fill: { height: 6, borderRadius: 3, backgroundColor: C.live },
  trackNote: { ...T.tiny, color: 'rgba(255,255,255,0.62)', marginTop: SP.xs },
  onlineActions: { flexDirection: 'row', alignItems: 'center', gap: SP.sm, marginTop: SP.md },
  darkGhost: { flex: 1, borderColor: 'rgba(255,255,255,0.3)' },
  returning: { ...T.small, color: 'rgba(255,255,255,0.78)' },
  offline: { minHeight: Z.tap, paddingHorizontal: SP.md, alignItems: 'center', justifyContent: 'center' },
  offlineText: { color: 'rgba(255,255,255,0.75)', fontSize: Z.body, fontWeight: '700' },
  gap: { marginTop: SP.md },
  sync: { borderColor: C.amber, borderWidth: 1.5 },
  bottomRow: { flexDirection: 'row', gap: SP.sm },
  bottomBtn: { flex: 1, paddingHorizontal: SP.xs, minHeight: Z.tap },

  toastWrap: { flex: 1, backgroundColor: 'rgba(12,26,18,0.45)', justifyContent: 'center', padding: SP.xl },
  toast: { backgroundColor: C.white, borderRadius: R.lg, padding: SP.lg },
});
