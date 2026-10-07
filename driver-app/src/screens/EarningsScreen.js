import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useApp } from '../state/store';
import { Card, Row, Button, Divider, Pill, useBottomPad } from '../components/UI';
import { C, T, R, SP, S, Z } from '../theme';

/**
 * Earnings. Today and this week as two tabs, so nothing scrolls (spec section
 * 2: "No scrolling: today and this week side by side as two tabs").
 */
export default function EarningsScreen() {
  // Clear the phone's navigation buttons (Android draws edge to edge).
  const bottomPad = useBottomPad();
  const { earnings, loadEarnings, signOut, pendingSync, syncNow } = useApp();
  const [tab, setTab] = useState('today');
  useEffect(() => { loadEarnings(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const t = earnings?.today ?? { orders: 0, delivery: 0, tips: 0 };
  const w = earnings?.week ?? { orders: 0, delivery: 0, tips: 0, vehicleFee: 900 };
  const net = w.delivery + w.tips - w.vehicleFee;

  return (
    <View style={[S.page, bottomPad]}>
      <View style={st.tabs} accessibilityRole="tablist">
        {[['today', 'Today'], ['week', 'This week']].map(([key, label]) => (
          <Pressable key={key} onPress={() => setTab(key)} accessibilityRole="tab"
            accessibilityState={{ selected: tab === key }}
            style={[st.tab, tab === key && st.tabOn]}>
            <Text style={[st.tabText, tab === key && st.tabTextOn]}>{label}</Text>
          </Pressable>
        ))}
      </View>

      {tab === 'today' ? (
        <Card tone="forest">
          <View style={st.top}>
            <Text style={st.lbl}>EARNED TODAY</Text>
            <Pill text={`${t.orders} trips`} tone="onDark" />
          </View>
          <Text style={st.fig}>R{t.delivery + t.tips}</Text>
          <Divider onDark />
          <Row label="Delivery fees" value={`R${t.delivery}`} onDark />
          <Row label="Tips, all yours" value={`R${t.tips}`} onDark bold />
        </Card>
      ) : (
        <Card>
          <Row label="Trips completed" value={String(w.orders)} />
          <Row label="Delivery fees" value={`R${w.delivery}`} />
          <Row label="Tips" value={`R${w.tips}`} />
          <Row label="Vehicle and job access" value={`−R${w.vehicleFee}`} />
          <Divider />
          <Row label="Net to you" value={`R${net}`} bold />
          <Text style={[T.small, { marginTop: SP.xs }]}>
            The R{w.vehicleFee} covers your bike, its service and insurance. Tips are never touched.
          </Text>
        </Card>
      )}

      {pendingSync > 0 ? (
        <Card style={st.sync}>
          <Text style={T.h3}>
            {pendingSync} deliver{pendingSync > 1 ? 'ies' : 'y'} not yet uploaded
          </Text>
          <Text style={T.small}>Completed without signal. Payment clears once they sync.</Text>
          <Button title="Sync now" onPress={syncNow} style={{ marginTop: SP.sm }} />
        </Card>
      ) : null}

      <View style={{ flex: 1 }} />
      <Button title="Sign out" kind="ghost" onPress={signOut} />
    </View>
  );
}

const st = StyleSheet.create({
  tabs: { flexDirection: 'row', backgroundColor: C.wash, borderRadius: R.md, padding: 3, marginBottom: SP.md },
  tab: { flex: 1, minHeight: Z.secondary, borderRadius: R.sm, alignItems: 'center', justifyContent: 'center' },
  tabOn: { backgroundColor: C.white },
  tabText: { ...T.body, color: C.muted, fontWeight: '700' },
  tabTextOn: { color: C.ink },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  lbl: { ...T.label, color: 'rgba(255,255,255,0.6)' },
  fig: { ...T.money, color: C.white, marginTop: SP.xs },
  sync: { marginTop: SP.md, borderColor: C.amber, borderWidth: 1.5 },
});
