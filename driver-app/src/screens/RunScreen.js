import React, { useState, useEffect, useMemo } from 'react';
import { View, Text, ScrollView, StyleSheet, Linking, Platform, TextInput } from 'react-native';
import { useApp } from '../state/store';
import { Card, Button, Row, Pill, Divider, Label } from '../components/UI';
import MapPanel from '../components/MapPanel';
import { metresBetween, insideGeofence } from '../lib/proof';
import { C, T, R, SP, S } from '../theme';

/**
 * A run: one to three orders, collected together and delivered in sequence.
 *
 * The screen is a stop list rather than a single job, because a driver
 * carrying three bags for three doors needs to know which bag goes where and
 * which door is next. A single-order run has exactly one pickup and one
 * drop-off, so nothing special-cases batch size.
 *
 * PICKUP RADIUS IS LOOSER THAN DROP-OFF
 * 250 m at the store, 150 m at the door. A shopping centre pickup means
 * parking, walking in, and a GPS fix bouncing off the building. The tight
 * fence stays where it does real work: stopping a driver collecting the code
 * from the gate and abandoning the order.
 */
const PICKUP_RADIUS_M = 250;

export default function RunScreen({ navigation }) {
  const {
    jobs, stops, stopIndex, goToStop, markJobDone, position, trail, online,
    otpAttempts, noteOtpFail, completeJob, api, toastMsg, scanned, setScanned, batchId,
  } = useApp();

  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [collected, setCollected] = useState(false);

  const live = (jobs ?? []).filter((j) => !j.done);
  const stop = stops?.[stopIndex] ?? null;

  // A run with no stop list is a single order; synthesise the two stops so the
  // same screen drives both.
  const effectiveStops = useMemo(() => {
    if (stops?.length) return stops;
    const j = jobs?.[0];
    if (!j) return [];
    return [
      { kind: 'PICKUP', name: j.pickup?.name ?? 'Collection point', jobIds: [j.id],
        lat: j.pickup?.latitude, lng: j.pickup?.longitude },
      { kind: 'DROPOFF', name: j.dropoff?.name ?? 'Delivery address', jobIds: [j.id],
        lat: j.dropoff?.latitude, lng: j.dropoff?.longitude },
    ];
  }, [stops, jobs]);

  const current = effectiveStops[stopIndex] ?? null;
  const target = current ? { latitude: current.lat, longitude: current.lng } : null;
  const metres = position && target ? Math.round(metresBetween(position, target)) : null;
  const radius = current?.kind === 'PICKUP' ? PICKUP_RADIUS_M : 150;
  const inRange = position && target ? insideGeofence(position, target, radius) : false;

  const totalBags = live.reduce((a, j) => a + (j.bagCount ?? 1), 0);
  const stopJobs = (current?.jobIds ?? []).map((id) => jobs.find((j) => j.id === id)).filter(Boolean);
  const dropJob = current?.kind === 'DROPOFF' ? stopJobs[0] : null;

  useEffect(() => { setCode(''); setErr(null); }, [stopIndex]);

  if (!jobs?.length) {
    return (
      <View style={[S.screen, { padding: SP.lg, justifyContent: 'center' }]}>
        <Text style={T.h2}>No active delivery</Text>
        <Button title="Back to shift" onPress={() => navigation.navigate('Shift')}
          style={{ marginTop: SP.md }} />
      </View>
    );
  }

  const openMaps = () => {
    if (!current) return;
    const q = `${current.lat},${current.lng}`;
    Linking.openURL(Platform.select({
      ios: `maps://?daddr=${q}`,
      android: `google.navigation:q=${q}`,
    })).catch(() => Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${q}`));
  };

  /* ------------------------------------------------------------- pickup */

  const collectAll = async () => {
    setBusy(true);
    try {
      // Tell the server the food left the store, per order. This is the second
      // half of the ready-gate measurement and it must be recorded for each
      // job on the run, not once for the batch.
      for (const j of stopJobs) {
        try { await api.collect?.(j.id); } catch { /* queued offline */ }
      }
      setCollected(true);
      goToStop(stopIndex + 1, 'NAVIGATE_CUSTOMER');
    } finally { setBusy(false); }
  };

  /* ------------------------------------------------------------ dropoff */

  const arrive = async () => {
    if (!dropJob) return;
    setBusy(true);
    try { await api.approach?.(dropJob.id); toastMsg('Code sent to the customer.'); }
    catch { setErr('Could not reach dispatch. The customer may not have their code.'); }
    finally { setBusy(false); }
  };

  const submit = async () => {
    if (!dropJob || !inRange) return;
    setBusy(true); setErr(null);
    try {
      let verified = false;
      if (online) {
        const res = await api.verifyOtp(dropJob.id, code,
          { lat: position.latitude, lng: position.longitude });
        verified = res?.verified;
      } else {
        // Offline: accept it, grade B, and let the server re-verify the trail
        // on sync. Refusing to complete because there is no signal strands the
        // driver on someone's doorstep.
        verified = /^\d{4}$/.test(code);
      }
      if (!verified) { noteOtpFail(); setErr('That code did not match.'); return; }

      await completeJob({
        jobId: dropJob.id,
        grade: online ? 'A' : 'B',
        position: { lat: position.latitude, lng: position.longitude },
        gpsTrail: trail,
        code,
      });
      markJobDone(dropJob.id);

      const next = stopIndex + 1;
      if (next < effectiveStops.length) {
        toastMsg(`Delivered. ${effectiveStops.length - next} stop${
          effectiveStops.length - next === 1 ? '' : 's'} left.`);
        goToStop(next, 'NAVIGATE_CUSTOMER');
      } else {
        navigation.navigate('Shift');
      }
    } catch (e) {
      setErr(e.message ?? 'Could not complete. Try again.');
    } finally { setBusy(false); }
  };

  /* --------------------------------------------------------------- view */

  const isPickup = current?.kind === 'PICKUP';
  const done = effectiveStops.filter((_, i) => i < stopIndex).length;

  return (
    <ScrollView style={S.screen} contentContainerStyle={S.content}>
      {jobs.length > 1 && (
        <Card tone="forest" style={{ marginBottom: SP.md }}>
          <Text style={st.runLabel}>RUN OF {jobs.length} ORDERS</Text>
          <Text style={st.runProgress}>Stop {stopIndex + 1} of {effectiveStops.length}</Text>
          <Text style={st.runSub}>
            {totalBags} bag{totalBags === 1 ? '' : 's'} · {live.length} still to deliver
          </Text>
        </Card>
      )}

      <MapPanel
        pickup={isPickup ? { latitude: current.lat, longitude: current.lng,
          name: current.name } : null}
        dropoff={!isPickup && current ? { latitude: current.lat, longitude: current.lng,
          name: current.name } : null}
        driver={position ? { latitude: position.latitude, longitude: position.longitude,
          name: 'You' } : null}
        height={180}
      />

      <Card tone="wash" flat style={{ marginBottom: SP.md }}>
        <Text style={T.label}>{isPickup ? 'COLLECT FROM' : 'DELIVER TO'}</Text>
        <Text style={st.address}>{current?.name ?? 'Address not supplied'}</Text>
        {dropJob ? <Text style={T.tiny}>ORDER {dropJob.orderNumber ?? dropJob.id}</Text> : null}
        <View style={st.row}>
          <Text style={[T.small, { flex: 1 }]}>
            {metres == null ? 'Waiting for GPS'
              : metres < 1000 ? `${metres} m away` : `${(metres / 1000).toFixed(1)} km away`}
          </Text>
          {dropJob?.earningsPreview ? (
            <Pill text={`R${dropJob.earningsPreview.total.toFixed(0)}`} tone="live" />
          ) : null}
        </View>
        <Button title="Open in maps" kind="ghost" onPress={openMaps} style={{ marginTop: SP.md }} />
      </Card>

      {isPickup ? (
        <Card>
          <Text style={T.h3}>Collect {stopJobs.length} order{stopJobs.length === 1 ? '' : 's'}</Text>
          <Text style={[T.small, { marginTop: 4, marginBottom: SP.md }]}>
            Check each bag against its order number before you leave.
          </Text>
          {stopJobs.map((j) => (
            <View key={j.id}>
              <Divider />
              <Row label={j.orderNumber ?? j.id}
                value={`${j.bagCount ?? 1} bag${(j.bagCount ?? 1) === 1 ? '' : 's'}`} bold />
              <Text style={T.tiny}>to {(j.dropoff?.name ?? '').split(',')[0]}</Text>
            </View>
          ))}
          <Button title={`I have all ${totalBags} bag${totalBags === 1 ? '' : 's'}`}
            kind="live" onPress={collectAll} loading={busy} disabled={!inRange}
            style={{ marginTop: SP.lg }} />
          {!inRange && (
            <Text style={st.hint}>Unlocks within {PICKUP_RADIUS_M} m of {current?.name}.</Text>
          )}
          {!inRange && metres != null && metres < 1200 && (
            <Button title="My GPS is wrong, I am here" kind="ghost"
              onPress={() => { toastMsg('Pickup recorded with a GPS override.'); collectAll(); }}
              style={{ marginTop: SP.sm }} />
          )}
        </Card>
      ) : (
        <Card>
          <Text style={T.h3}>Hand over and enter the code</Text>
          <Text style={[T.small, { marginTop: 4 }]}>
            The customer has a 4-digit code in their chat. It only works at the door.
          </Text>
          <Button title="I have arrived" onPress={arrive} loading={busy}
            style={{ marginTop: SP.md }} />
          <TextInput
            style={st.code}
            value={code}
            onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 4))}
            keyboardType="number-pad"
            placeholder="0000"
            placeholderTextColor={C.line}
            maxLength={4}
          />
          {err ? <Text style={st.err}>{err}</Text> : null}
          {otpAttempts > 0 && !err ? (
            <Text style={T.tiny}>{otpAttempts} wrong attempt{otpAttempts === 1 ? '' : 's'}</Text>
          ) : null}
          <Button title="Complete delivery" kind="live" onPress={submit}
            loading={busy} disabled={code.length !== 4 || !inRange}
            style={{ marginTop: SP.md }} />
          {!inRange && (
            <Text style={st.hint}>
              You must be within {radius} m of the door to complete this delivery.
            </Text>
          )}
        </Card>
      )}

      {effectiveStops.length > 1 && (
        <>
          <Label style={{ marginTop: SP.xl }}>ALL STOPS</Label>
          <Card>
            {effectiveStops.map((s, i) => (
              <View key={`${s.kind}-${i}`}>
                {i > 0 ? <Divider /> : null}
                <View style={st.row}>
                  <View style={[st.bead, i < stopIndex && st.beadDone,
                    i === stopIndex && st.beadNow]} />
                  <View style={{ flex: 1 }}>
                    <Text style={[T.body, i === stopIndex && { fontWeight: '800' },
                      i < stopIndex && { color: C.muted }]}>
                      {s.kind === 'PICKUP' ? 'Collect' : 'Deliver'} · {s.name}
                    </Text>
                    {s.kind === 'DROPOFF' ? (
                      <Text style={T.tiny}>
                        {(jobs.find((j) => j.id === s.jobIds[0])?.orderNumber) ?? ''}
                      </Text>
                    ) : null}
                  </View>
                  {i < stopIndex ? <Pill text="DONE" tone="wash" /> : null}
                </View>
              </View>
            ))}
          </Card>
        </>
      )}

      <Button title="Message the office" kind="ghost"
        onPress={() => navigation.navigate('Messages')} style={{ marginTop: SP.xl }} />
    </ScrollView>
  );
}

const st = StyleSheet.create({
  runLabel: { ...T.label, color: 'rgba(255,255,255,0.6)' },
  runProgress: { fontSize: 24, fontWeight: '800', color: C.white, marginTop: 2 },
  runSub: { ...T.small, color: 'rgba(255,255,255,0.72)', marginTop: 3 },
  address: { fontSize: 21, fontWeight: '800', color: C.ink, letterSpacing: -0.3,
    lineHeight: 27, marginTop: 3, marginBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: SP.sm, marginTop: SP.sm },
  code: { borderWidth: 2, borderColor: C.line, borderRadius: R.md, fontSize: 34,
    fontWeight: '800', letterSpacing: 14, textAlign: 'center', paddingVertical: 14,
    marginTop: SP.md, color: C.ink, backgroundColor: C.mist },
  err: { color: C.red, fontSize: 13.5, marginTop: SP.sm },
  hint: { ...T.small, marginTop: SP.sm },
  bead: { width: 11, height: 11, borderRadius: 6, backgroundColor: C.line },
  beadDone: { backgroundColor: C.live },
  beadNow: { backgroundColor: C.white, borderWidth: 3, borderColor: C.live, width: 14, height: 14 },
});
