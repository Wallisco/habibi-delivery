import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, ScrollView, StyleSheet, RefreshControl, Pressable } from 'react-native';
import { useApp } from '../state/store';
import { Card, Pill, Button, Label } from '../components/UI';
import { C, T, SP, S } from '../theme';

function when(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return ts >= today.getTime() ? time : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} · ${time}`;
}

export default function JobsScreen({ navigation }) {
  const { fetchJobs, job: liveJob } = useApp();
  const [data, setData] = useState({ active: [], completed: [] });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    setBusy(true); setErr(null);
    try { setData(await fetchJobs()); }
    catch (e) { setErr(e.message ?? 'Could not load your trips.'); }
    finally { setBusy(false); }
  }, [fetchJobs]);

  useEffect(() => { load(); }, [load]);

  const active = data.active ?? [];
  const done = data.completed ?? [];

  return (
    <ScrollView
      style={S.screen}
      contentContainerStyle={S.content}
      refreshControl={<RefreshControl refreshing={busy} onRefresh={load} tintColor={C.green} />}>

      {err ? (
        <Card style={{ borderColor: C.red, borderWidth: 1.5, marginBottom: SP.md }}>
          <Text style={[T.small, { color: C.red }]}>{err}</Text>
          <Button title="Try again" onPress={load} style={{ marginTop: SP.md }} />
        </Card>
      ) : null}

      {liveJob ? (
        <>
          <Label>ON THIS TRIP NOW</Label>
          <Pressable onPress={() => navigation.navigate('ActiveJob')} accessibilityRole="button">
            <Card tone="forest">
              <View style={st.row}>
                <Text style={[T.h3, { color: C.white, flex: 1 }]}>
                  {liveJob.pickup?.name ?? 'Collection point'}
                </Text>
                <Pill text={`R${liveJob.fee}`} tone="live" />
              </View>
              <Text style={[T.small, { color: 'rgba(255,255,255,0.7)', marginTop: 4 }]}>
                to {(liveJob.dropoff?.name ?? 'Delivery address').split(',')[0]}
              </Text>
              <Text style={[T.tiny, { color: C.live, marginTop: SP.sm }]}>
                Tap to continue this delivery
              </Text>
            </Card>
          </Pressable>
        </>
      ) : null}

      {active.length > 0 && !liveJob ? (
        <>
          <Label style={{ marginTop: liveJob ? SP.xl : 0 }}>ASSIGNED TO YOU</Label>
          {active.map((j) => (
            <Card key={j.id} style={{ marginBottom: SP.sm }}>
              <View style={st.row}>
                <Text style={[T.h3, { flex: 1 }]}>{j.pickup?.name ?? 'Collection point'}</Text>
                <Pill text={`R${j.fee}`} />
              </View>
              <Text style={[T.small, { marginTop: 4 }]}>
                to {(j.dropoff?.name ?? 'Delivery address').split(',')[0]} · {j.distanceKm} km
              </Text>
            </Card>
          ))}
        </>
      ) : null}

      <Label style={{ marginTop: (liveJob || active.length) ? SP.xl : 0 }}>
        COMPLETED {done.length ? `· ${done.length}` : ''}
      </Label>

      {done.length === 0 ? (
        <Card>
          <Text style={T.h3}>No completed trips yet</Text>
          <Text style={[T.small, { marginTop: 4 }]}>
            Finished deliveries appear here with what you earned on each.
          </Text>
        </Card>
      ) : (
        done.map((j) => (
          <Pressable key={j.id} onPress={() => navigation.navigate('JobDetail', { job: j })}
            accessibilityRole="button">
            <Card style={{ marginBottom: SP.sm }}>
              <View style={st.row}>
                <View style={{ flex: 1 }}>
                  <Text style={T.tiny}>{j.orderNumber ?? j.id}</Text>
                  <Text style={T.h3}>{j.pickup?.name ?? 'Collection point'}</Text>
                  <Text style={[T.small, { marginTop: 3 }]}>
                    to {(j.dropoff?.name ?? 'Delivery address').split(',')[0]}
                  </Text>
                  <Text style={[T.tiny, { marginTop: 5 }]}>
                    {when(j.completedAt)} · {j.distanceKm} km
                    {j.waitAtStoreMinutes > 8
                      ? ` · waited ${Math.round(j.waitAtStoreMinutes)} min` : ''}
                    {j.proofGrade === 'FLAGGED' ? ' · under review' : ''}
                  </Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={st.fee}>R{j.earnings?.total ?? j.fee}</Text>
                  <Text style={T.tiny}>see breakdown</Text>
                </View>
              </View>
            </Card>
          </Pressable>
        ))
      )}

      <Button title="Back to shift" kind="ghost"
        onPress={() => navigation.navigate('Shift')} style={{ marginTop: SP.xl }} />
    </ScrollView>
  );
}

const st = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: SP.sm },
  fee: { fontSize: 20, fontWeight: '800', color: C.green },
});
