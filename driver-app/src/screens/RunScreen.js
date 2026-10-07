import React, { useState, useEffect, useMemo } from 'react';
import { View, Text, FlatList, Image, StyleSheet, Linking, Platform, TextInput, Pressable } from 'react-native';
import { useApp } from '../state/store';
import { Card, Button, Pill } from '../components/UI';
import MapPanel from '../components/MapPanel';
import OfferSheet from '../components/OfferSheet';
import { metresBetween, insideGeofence } from '../lib/proof';
import { C, T, R, SP, S, Z } from '../theme';
import { stepOf, STEP, stageFor } from '../lib/currentJob';

/** "3 × Pizza Margherita" / "1 × Coke 500ml" (same as dispatch-service/src/items.js). */
const itemLine = (it) => `${it.qty} × ${it.name}${it.size ? ` ${it.size}` : ''}`;

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
    otpAttempts, noteOtpFail, completeJob, api, toastMsg, scanned, setScanned, batchId, toast,
    takeCollectionPhoto,
  } = useApp();

  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [collected, setCollected] = useState(false);
  // The collection photo for this stop (its local file; it uploads on its own).
  const [photo, setPhoto] = useState(null);

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

  useEffect(() => { setCode(''); setErr(null); setPhoto(null); }, [stopIndex]);

  const snap = async () => {
    const uri = await takeCollectionPhoto?.(stopJobs.map((j) => j.id));
    if (uri) setPhoto(uri);
  };

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
        // After a drop-off the next stop can be a store: the next job taken
        // near this drop-off. Go to "To store", not "To customer".
        goToStop(next, stageFor(effectiveStops[next]));
      } else {
        navigation.navigate('Shift');
      }
    } catch (e) {
      setErr(e.message ?? 'Could not complete. Try again.');
    } finally { setBusy(false); }
  };

  /* --------------------------------------------------------------- view */

  const isPickup = current?.kind === 'PICKUP';
  const step = stepOf({ stops, jobs, stopIndex, position });
  const stepAt = STEPS.findIndex((x) => x.key === step);
  const away = metres == null ? 'Waiting for GPS'
    : metres < 1000 ? `${metres} m away` : `${(metres / 1000).toFixed(1)} km away`;

  // Fits a 360×640 phone with nothing to scroll: where you are in the
  // delivery, where to go, and the one thing to do there.
  return (
    <View style={S.page}>
      {/* The four steps across the top, plus the stop count on a run. */}
      <View style={st.steps}>
        {STEPS.map((x, i) => (
          <View key={x.key} style={st.stepCell}>
            <View style={[st.stepBar, i <= stepAt && st.stepBarOn]} />
            <Text style={[st.stepText, i === stepAt && st.stepTextNow]} numberOfLines={1}>{x.label}</Text>
          </View>
        ))}
      </View>
      {effectiveStops.length > 2 ? (
        <Text style={st.runLine}>
          Stop {stopIndex + 1} of {effectiveStops.length} · {totalBags} bag{totalBags === 1 ? '' : 's'}
          {' · '}{live.length} to deliver
        </Text>
      ) : null}

      {/* Messages from dispatch mid-run, e.g. one order of the run cancelled. */}
      {toast ? (
        <Pressable onPress={() => toastMsg(null)} accessibilityRole="button" style={st.toast}>
          <Text style={T.small} numberOfLines={2}>{toast}</Text>
          <Text style={T.tiny}>Tap to dismiss</Text>
        </Pressable>
      ) : null}

      {/* At the store the map adds nothing; the checklist needs the room. */}
      {isPickup && inRange ? null : (
        <MapPanel
          pickup={isPickup ? { latitude: current.lat, longitude: current.lng,
            name: current.name } : null}
          dropoff={!isPickup && current ? { latitude: current.lat, longitude: current.lng,
            name: current.name } : null}
          driver={position ? { latitude: position.latitude, longitude: position.longitude,
            name: 'You' } : null}
          height={Z.map}
        />
      )}

      <Card tone="wash" flat>
        <Text style={T.label}>{isPickup ? 'COLLECT FROM' : 'DELIVER TO'}</Text>
        <Text style={st.address} numberOfLines={1}>{current?.name ?? 'Address not supplied'}</Text>
        <View style={st.row}>
          <Text style={[T.small, { flex: 1 }]} numberOfLines={1}>
            {away}{dropJob ? ` · ${dropJob.orderNumber ?? dropJob.id}` : ''}
          </Text>
          {dropJob?.earningsPreview ? (
            <Pill text={`R${dropJob.earningsPreview.total.toFixed(0)}`} tone="live" />
          ) : null}
          <Button title="Navigate" kind="ghost" onPress={openMaps} style={st.navigate} />
        </View>
      </Card>

      {isPickup ? (
        <Card style={[st.action, st.fill]}>
          <Text style={T.h3}>
            Collect {stopJobs.length} order{stopJobs.length === 1 ? '' : 's'} · {totalBags} bag{totalBags === 1 ? '' : 's'}
          </Text>
          {/* What should be in each bag: check it before you leave. The list is
              the one part of this screen that scrolls, if it is long. */}
          <FlatList
            style={st.fill}
            data={stopJobs}
            keyExtractor={(j) => j.id}
            renderItem={({ item: j }) => (
              <View style={st.order}>
                <Text style={T.small} numberOfLines={1}>
                  {j.orderNumber ?? j.id} · {j.bagCount ?? 1} bag{(j.bagCount ?? 1) === 1 ? '' : 's'}
                  {' · to '}{(j.dropoff?.name ?? '').split(',')[0]}
                </Text>
                {(j.items ?? []).map((it, i) => (
                  <Text key={i} style={st.item}>{itemLine(it)}</Text>
                ))}
              </View>
            )}
          />
          {/* The photo comes first: it confirms what is in the bags. */}
          {photo ? (
            <View style={st.photoRow}>
              <Image source={{ uri: photo }} style={st.thumb} accessibilityLabel="Your photo of the order" />
              <Text style={[T.small, { flex: 1 }]}>Photo taken</Text>
              <Pressable onPress={snap} style={st.retake} accessibilityRole="button">
                <Text style={st.linkText}>Retake</Text>
              </Pressable>
            </View>
          ) : (
            <Button title="Take a photo of the order" kind="ghost" onPress={snap}
              style={{ marginTop: SP.sm }} />
          )}
          <Button title={`I have all ${totalBags} bag${totalBags === 1 ? '' : 's'}`}
            kind="live" onPress={collectAll} loading={busy} disabled={!inRange || !photo}
            style={{ marginTop: SP.sm }} />
          {!photo ? (
            <Text style={st.hint}>Take the photo first.</Text>
          ) : !inRange ? (
            <Text style={st.hint}>Unlocks within {PICKUP_RADIUS_M} m of the store.</Text>
          ) : null}
          {photo && !inRange && metres != null && metres < 1200 ? (
            <Pressable style={st.link} accessibilityRole="button"
              onPress={() => { toastMsg('Pickup recorded with a GPS override.'); collectAll(); }}>
              <Text style={st.linkText}>My GPS is wrong, I am here</Text>
            </Pressable>
          ) : null}
        </Card>
      ) : (
        <Card style={st.action}>
          <Text style={T.h3}>Hand over and enter the code</Text>
          <Text style={T.small}>The customer has a 4-digit code in their chat.</Text>
          <View style={st.codeRow}>
            <TextInput
              style={st.code}
              value={code}
              onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 4))}
              keyboardType="number-pad"
              placeholder="0000"
              placeholderTextColor={C.line}
              maxLength={4}
              accessibilityLabel="Customer's 4-digit code"
            />
            <Button title="I'm here" kind="ghost" onPress={arrive} loading={busy} style={st.arrived} />
          </View>
          {err ? <Text style={st.err}>{err}</Text> : null}
          {otpAttempts > 0 && !err ? (
            <Text style={T.tiny}>{otpAttempts} wrong attempt{otpAttempts === 1 ? '' : 's'}</Text>
          ) : null}
          <Button title="Complete delivery" kind="live" onPress={submit}
            loading={busy} disabled={code.length !== 4 || !inRange}
            style={{ marginTop: SP.sm }} />
          {!inRange ? (
            <Text style={st.hint}>Unlocks within {radius} m of the door.</Text>
          ) : null}
        </Card>
      )}

      {isPickup ? null : <View style={{ flex: 1 }} />}
      <Pressable style={st.link} accessibilityRole="button" onPress={() => navigation.navigate('Messages')}>
        <Text style={st.linkText}>Message the office</Text>
      </Pressable>

      {/* On the run: a second order for this pickup can be offered here. */}
      <OfferSheet navigation={navigation} />
    </View>
  );
}

const STEPS = [
  { key: STEP.TO_STORE, label: 'To store' },
  { key: STEP.AT_STORE, label: 'At store' },
  { key: STEP.TO_CUSTOMER, label: 'To customer' },
  { key: STEP.AT_DOOR, label: 'At door' },
];

const st = StyleSheet.create({
  steps: { flexDirection: 'row', gap: SP.xs, marginBottom: SP.sm },
  stepCell: { flex: 1 },
  stepBar: { height: 4, borderRadius: 2, backgroundColor: C.line },
  stepBarOn: { backgroundColor: C.live },
  stepText: { ...T.tiny, marginTop: 3 },
  stepTextNow: { color: C.ink, fontWeight: '800' },
  runLine: { ...T.small, color: C.ink, fontWeight: '700', marginBottom: SP.sm },
  toast: { backgroundColor: C.wash, borderRadius: R.sm, padding: SP.sm, marginBottom: SP.sm },
  address: { ...T.h3, color: C.ink, marginTop: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: SP.sm, marginTop: SP.xs },
  navigate: { paddingHorizontal: SP.md },
  action: { marginTop: SP.sm },
  fill: { flex: 1 },
  photoRow: { flexDirection: 'row', alignItems: 'center', gap: SP.sm, marginTop: SP.sm },
  thumb: { width: Z.tap, height: Z.tap, borderRadius: R.sm, backgroundColor: C.wash },
  retake: { minHeight: Z.tap, paddingHorizontal: SP.md, justifyContent: 'center' },
  order: { marginTop: SP.xs },
  item: { ...T.body, color: C.ink, fontWeight: '600' },
  codeRow: { flexDirection: 'row', alignItems: 'center', gap: SP.sm, marginTop: SP.sm },
  code: { flex: 1, height: Z.primary, borderWidth: 2, borderColor: C.line, borderRadius: R.sm,
    fontSize: 24, fontWeight: '800', letterSpacing: 10, textAlign: 'center',
    color: C.ink, backgroundColor: C.mist },
  arrived: { paddingHorizontal: SP.md },
  err: { ...T.small, color: C.red, marginTop: SP.xs },
  hint: { ...T.small, marginTop: SP.xs },
  link: { minHeight: Z.tap, alignItems: 'center', justifyContent: 'center' },
  linkText: { ...T.body, color: C.green, fontWeight: '700' },
});
