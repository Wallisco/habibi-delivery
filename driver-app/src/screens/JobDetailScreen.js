import React from 'react';
import { View, Text, FlatList, StyleSheet } from 'react-native';
import { Card, Row, Pill, Button, Label, useBottomPad } from '../components/UI';
import { suburbOf } from '../components/OfferSheet';
import { C, T, R, SP, S } from '../theme';

/**
 * Every line of pay, shown to the driver.
 *
 * Mr D pays a driver R52.83 an order and shows them one number. We found that
 * 77% of it is fixed base fees with no time component, so a driver waiting 25
 * minutes at a restaurant earns nothing for it and cannot tell. Showing the
 * arithmetic costs nothing and is the difference between trusting the number
 * and suspecting it.
 *
 * The total and the trip stay put; the pay lines are the list, and only they
 * scroll if a stacked run has many.
 */
export default function JobDetailScreen({ route, navigation }) {
  // Clear the phone's navigation buttons (Android draws edge to edge).
  const bottomPad = useBottomPad();
  const job = route.params?.job;
  if (!job) {
    return (
      <View style={[S.page, bottomPad, { justifyContent: 'center' }]}>
        <Text style={T.h2}>Trip not found</Text>
        <Button title="Back" onPress={() => navigation.goBack()} style={{ marginTop: SP.md }} />
      </View>
    );
  }

  const e = job.earnings;
  const when = job.completedAt ? new Date(job.completedAt) : null;
  const lines = e?.lines ?? [];

  return (
    <View style={[S.page, bottomPad]}>
      <Card tone="forest">
        <View style={st.totalRow}>
          <Text style={st.lbl}>YOU EARNED</Text>
          <Text style={st.total}>R{e?.total ?? job.fee}</Text>
        </View>
        <Text style={st.sub} numberOfLines={1}>
          {job.pickup?.name ?? 'Collection point'} → {suburbOf(job.dropoff?.name)}
        </Text>
        <Text style={st.sub} numberOfLines={1}>
          {when ? `${when.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} · ${
            when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ` : ''}
          {job.distanceKm ?? '–'} km · {job.bagCount ?? 1} bag{(job.bagCount ?? 1) === 1 ? '' : 's'}
          {' · '}{job.proofGrade === 'FLAGGED' ? 'under review' : `grade ${job.proofGrade ?? '–'}`}
        </Text>
      </Card>

      {job.proofGrade === 'FLAGGED' ? (
        <Card style={st.flagged}>
          <Text style={[T.h3, { color: C.red }]}>This trip is under review</Text>
          <Text style={T.small}>
            Completed without signal and the location trail did not match the drop-off.
            Payment is held until support checks it.
          </Text>
        </Card>
      ) : null}

      <Label style={{ marginTop: SP.md }}>HOW THIS WAS CALCULATED</Label>
      <FlatList
        style={{ flex: 1 }}
        data={lines}
        keyExtractor={(l) => l.code}
        ItemSeparatorComponent={() => <View style={st.sep} />}
        ListEmptyComponent={
          <Text style={T.small}>
            No breakdown was recorded for this trip. It was completed before itemised pay was
            switched on.
          </Text>
        }
        renderItem={({ item: l }) => (
          <View style={st.line}>
            <View style={st.lineTop}>
              <Text style={[T.body, { flex: 1, fontWeight: '600' }]}>{l.label}</Text>
              <Text style={[T.body, { fontWeight: '800' }]}>R{l.amount.toFixed(2)}</Text>
            </View>
            {l.detail ? <Text style={T.tiny}>{l.detail}</Text> : null}
            {l.fundedBy === 'customer' ? <Pill text="PAID BY THE CUSTOMER" tone="wash" /> : null}
          </View>
        )}
        ListFooterComponent={lines.length ? (
          <View>
            <Row label="Total" value={`R${e.total.toFixed(2)}`} bold />
            {e?.waitMinutes > 0 ? (
              <Text style={T.small}>
                You waited {Math.round(e.waitMinutes)} min at the restaurant.
                {e.waitMinutes > 8 ? ' Anything past 8 minutes is paid (above).' : ' Under 8 minutes is not paid.'}
              </Text>
            ) : null}
          </View>
        ) : null}
      />
    </View>
  );
}

const st = StyleSheet.create({
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  lbl: { ...T.label, color: 'rgba(255,255,255,0.6)' },
  total: { ...T.h1, color: C.white },
  sub: { ...T.small, color: 'rgba(255,255,255,0.75)' },
  flagged: { marginTop: SP.sm, borderColor: C.red, borderWidth: 1.5 },
  line: { backgroundColor: C.white, borderRadius: R.sm, paddingHorizontal: SP.md, paddingVertical: SP.xs, gap: 2 },
  lineTop: { flexDirection: 'row', alignItems: 'baseline', gap: SP.sm },
  sep: { height: SP.xs },
});
