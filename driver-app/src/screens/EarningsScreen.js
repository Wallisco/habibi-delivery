import React, { useEffect } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { useApp } from '../state/store';
import { Card, Row, Button, Divider, Label, Pill } from '../components/UI';
import { C, T, SP, S } from '../theme';

export default function EarningsScreen() {
  const { earnings, loadEarnings, signOut, pendingSync, syncNow } = useApp();
  useEffect(() => { loadEarnings(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const t = earnings?.today ?? { orders: 0, delivery: 0, tips: 0 };
  const w = earnings?.week ?? { orders: 0, delivery: 0, tips: 0, vehicleFee: 900 };
  const net = w.delivery + w.tips - w.vehicleFee;

  return (
    <ScrollView style={S.screen} contentContainerStyle={S.content}>
      <Card tone="forest" style={st.hero}>
        <View style={st.heroTop}>
          <Text style={st.heroLabel}>Earned today</Text>
          <Pill text={`${t.orders} trips`} tone="onDark" />
        </View>
        <Text style={st.heroFig}>R{t.delivery + t.tips}</Text>
        <Divider onDark />
        <Row label="Delivery fees" value={`R${t.delivery}`} onDark />
        <Row label="Tips, all yours" value={`R${t.tips}`} onDark bold />
      </Card>

      <Label style={{ marginTop: SP.xl }}>THIS WEEK</Label>
      <Card>
        <Row label="Trips completed" value={String(w.orders)} />
        <Row label="Delivery fees" value={`R${w.delivery}`} />
        <Row label="Tips" value={`R${w.tips}`} />
        <Divider />
        <Row label="Vehicle and job access" value={`−R${w.vehicleFee}`} />
        <Divider />
        <Row label="Net to you" value={`R${net}`} bold />
      </Card>

      <Card tone="wash" style={{ marginTop: SP.md }} flat>
        <Text style={[T.small, { color: C.green }]}>
          The R{w.vehicleFee} covers your bike, its service and its insurance. Tips are never
          touched — every cent a customer adds is yours.
        </Text>
      </Card>

      {pendingSync > 0 ? (
        <Card style={{ marginTop: SP.md, borderColor: C.amber, borderWidth: 1.5 }}>
          <Pill text="WAITING TO SYNC" tone="amber" />
          <Text style={[T.h3, { marginTop: SP.sm }]}>
            {pendingSync} deliver{pendingSync > 1 ? 'ies' : 'y'} not yet uploaded
          </Text>
          <Text style={[T.small, { marginTop: 4, marginBottom: SP.md }]}>
            These were completed without signal. Payment clears once they sync.
          </Text>
          <Button title="Sync now" onPress={syncNow} />
        </Card>
      ) : null}

      <Button title="Sign out" kind="ghost" onPress={signOut} style={{ marginTop: SP.xl }} />
    </ScrollView>
  );
}

const st = StyleSheet.create({
  hero: { paddingVertical: SP.xl },
  heroTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  heroLabel: { ...T.label, color: 'rgba(255,255,255,0.6)' },
  heroFig: { ...T.money, color: C.white, marginTop: SP.sm, marginBottom: SP.xs },
});
