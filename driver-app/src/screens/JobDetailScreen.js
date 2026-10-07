import React from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { Card, Row, Divider, Label, Pill, Button } from '../components/UI';
import { C, T, SP, S } from '../theme';

/**
 * Every line of pay, shown to the driver.
 *
 * Mr D pays a driver R52.83 an order and shows them one number. We found that
 * 77% of it is fixed base fees with no time component, so a driver waiting 25
 * minutes at a restaurant earns nothing for it and cannot tell. Showing the
 * arithmetic costs nothing and is the difference between trusting the number
 * and suspecting it.
 */
export default function JobDetailScreen({ route, navigation }) {
  const job = route.params?.job;
  if (!job) {
    return (
      <View style={[S.screen, { padding: SP.lg, justifyContent: 'center' }]}>
        <Text style={T.h2}>Trip not found</Text>
        <Button title="Back" onPress={() => navigation.goBack()} style={{ marginTop: SP.md }} />
      </View>
    );
  }

  const e = job.earnings;
  const when = job.completedAt ? new Date(job.completedAt) : null;

  return (
    <ScrollView style={S.screen} contentContainerStyle={S.content}>
      <Card tone="forest">
        <Text style={st.lbl}>YOU EARNED</Text>
        <Text style={st.total}>R{e?.total ?? job.fee}</Text>
        <Text style={st.sub}>
          {job.pickup?.name ?? 'Collection point'} →{' '}
          {(job.dropoff?.name ?? 'Delivery address').split(',')[0]}
        </Text>
        {when ? (
          <Text style={[st.sub, { marginTop: 3 }]}>
            {when.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}
            {' · '}
            {when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </Text>
        ) : null}
      </Card>

      <Label style={{ marginTop: SP.xl }}>HOW THIS WAS CALCULATED</Label>
      <Card>
        {e?.lines?.length ? (
          <>
            {e.lines.map((l, i) => (
              <View key={l.code}>
                {i > 0 ? <Divider /> : null}
                <View style={st.lineTop}>
                  <Text style={[T.body, { flex: 1, fontWeight: '600' }]}>{l.label}</Text>
                  <Text style={[T.body, { fontWeight: '800' }]}>R{l.amount.toFixed(2)}</Text>
                </View>
                {l.detail ? <Text style={[T.small, { marginTop: 2 }]}>{l.detail}</Text> : null}
                {l.fundedBy === 'customer' ? (
                  <View style={{ marginTop: 6 }}>
                    <Pill text="PAID BY THE CUSTOMER" tone="wash" />
                  </View>
                ) : null}
              </View>
            ))}
            <Divider />
            <Row label="Total" value={`R${e.total.toFixed(2)}`} bold />
          </>
        ) : (
          <Text style={T.small}>
            No breakdown was recorded for this trip. It was completed before itemised pay
            was switched on.
          </Text>
        )}
      </Card>

      {e?.waitMinutes > 0 ? (
        <Card tone="wash" style={{ marginTop: SP.md }} flat>
          <Text style={[T.h3, { color: C.green }]}>
            You waited {Math.round(e.waitMinutes)} min at the restaurant
          </Text>
          <Text style={[T.small, { color: C.green, marginTop: 4 }]}>
            {e.waitMinutes > 8
              ? 'Anything past the first 8 minutes is paid, and it is on the list above.'
              : 'Under 8 minutes, so no waiting fee applies.'}
          </Text>
        </Card>
      ) : null}

      <Label style={{ marginTop: SP.xl }}>TRIP DETAIL</Label>
      <Card>
        <Row label="Collected from" value={job.pickup?.name ?? '–'} />
        <Row label="Delivered to"
          value={(job.dropoff?.name ?? '–').split(',')[0]} />
        <Row label="Distance" value={`${job.distanceKm ?? '–'} km`} />
        <Row label="Bags" value={String(job.bagCount ?? 1)} />
        <Row label="Proof"
          value={job.proofGrade === 'FLAGGED' ? 'Under review' : `Grade ${job.proofGrade ?? '–'}`} />
      </Card>

      {job.proofGrade === 'FLAGGED' ? (
        <Card style={{ marginTop: SP.md, borderColor: C.red, borderWidth: 1.5 }}>
          <Text style={[T.h3, { color: C.red }]}>This trip is under review</Text>
          <Text style={[T.small, { marginTop: 4 }]}>
            It was completed without signal and the location trail did not match the
            drop-off. Payment is held until support checks it.
          </Text>
        </Card>
      ) : null}

      <Button title="Back to trips" kind="ghost"
        onPress={() => navigation.goBack()} style={{ marginTop: SP.xl }} />
    </ScrollView>
  );
}

const st = StyleSheet.create({
  lbl: { ...T.label, color: 'rgba(255,255,255,0.6)' },
  total: { ...T.money, color: C.white, marginTop: 2, marginBottom: SP.sm },
  sub: { ...T.small, color: 'rgba(255,255,255,0.72)' },
  lineTop: { flexDirection: 'row', alignItems: 'baseline', gap: SP.sm },
});
