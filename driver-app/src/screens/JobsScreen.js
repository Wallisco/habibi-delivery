import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, FlatList, StyleSheet, RefreshControl, Pressable } from 'react-native';
import { useApp } from '../state/store';
import { Card, Pill, Button, Label } from '../components/UI';
import { suburbOf } from '../components/OfferSheet';
import { C, T, R, SP, S, Z } from '../theme';

function when(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return ts >= today.getTime() ? time : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} · ${time}`;
}

/**
 * Trips. The header stays put; only the list of trips scrolls (spec: only list
 * bodies scroll, their headers stay fixed).
 */
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

  const done = data.completed ?? [];

  return (
    <View style={S.page}>
      {err ? (
        <Card style={st.error}>
          <Text style={[T.small, { color: C.red }]}>{err}</Text>
          <Button title="Try again" kind="ghost" onPress={load} style={{ marginTop: SP.sm }} />
        </Card>
      ) : null}

      {liveJob ? (
        <Pressable onPress={() => navigation.navigate('ActiveJob')} accessibilityRole="button">
          <Card tone="forest" style={st.live}>
            <View style={st.row}>
              <Text style={[T.h3, { color: C.white, flex: 1 }]} numberOfLines={1}>
                On a trip now · {liveJob.pickup?.name ?? 'Collection point'}
              </Text>
              <Pill text={`R${liveJob.fee}`} tone="live" />
            </View>
            <Text style={[T.tiny, { color: C.live, marginTop: SP.xs }]}>Tap to continue this delivery</Text>
          </Card>
        </Pressable>
      ) : null}

      <Label>COMPLETED{done.length ? ` · ${done.length}` : ''}</Label>

      <FlatList
        style={{ flex: 1 }}
        data={done}
        keyExtractor={(j) => j.id}
        refreshControl={<RefreshControl refreshing={busy} onRefresh={load} tintColor={C.green} />}
        ItemSeparatorComponent={() => <View style={st.sep} />}
        ListEmptyComponent={
          <Card>
            <Text style={T.h3}>No completed trips yet</Text>
            <Text style={[T.small, { marginTop: SP.xs }]}>
              Finished deliveries appear here with what you earned on each.
            </Text>
          </Card>
        }
        renderItem={({ item: j }) => (
          <Pressable onPress={() => navigation.navigate('JobDetail', { job: j })}
            accessibilityRole="button" style={st.trip}>
            <View style={{ flex: 1 }}>
              <Text style={T.body} numberOfLines={1}>{j.pickup?.name ?? 'Collection point'}</Text>
              <Text style={T.tiny} numberOfLines={1}>
                {when(j.completedAt)} · {suburbOf(j.dropoff?.name)} · {j.distanceKm} km
                {j.waitAtStoreMinutes > 8 ? ` · waited ${Math.round(j.waitAtStoreMinutes)} min` : ''}
                {j.proofGrade === 'FLAGGED' ? ' · under review' : ''}
              </Text>
            </View>
            <Text style={st.fee}>R{j.earnings?.total ?? j.fee}</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const st = StyleSheet.create({
  error: { borderColor: C.red, borderWidth: 1.5, marginBottom: SP.sm },
  live: { marginBottom: SP.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: SP.sm },
  trip: { flexDirection: 'row', alignItems: 'center', gap: SP.sm, minHeight: Z.tap + 8,
    backgroundColor: C.white, borderRadius: R.sm, paddingHorizontal: SP.md, paddingVertical: SP.xs },
  sep: { height: SP.xs },
  fee: { ...T.h3, color: C.green },
});
