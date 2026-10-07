import React from 'react';
import { Text, View, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { C, T, R, SP, SHADOW, Z } from '../theme';

/**
 * Thumb-sized, not oversized: 48 pt for the one primary action on a screen,
 * 40 for everything else (ghost), and never a tap target under 44.
 */
export function Button({ title, subtitle, onPress, kind = 'primary', disabled, loading, style, textColor }) {
  const bg =
    disabled ? C.line :
    kind === 'primary' ? C.green :
    kind === 'live' ? C.live :
    kind === 'dark' ? C.forest :
    kind === 'danger' ? C.red : 'transparent';
  const fg = textColor ?? (kind === 'ghost' ? C.green : C.white);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      onPress={disabled || loading ? undefined : onPress}
      hitSlop={kind === 'ghost' ? 2 : 0}
      style={({ pressed }) => [
        st.btn,
        kind === 'ghost' && st.btnSecondary,
        kind !== 'ghost' && SHADOW.card,
        {
          backgroundColor: bg,
          transform: [{ scale: pressed ? 0.985 : 1 }],
          borderWidth: kind === 'ghost' ? 1.5 : 0,
          borderColor: C.line,
        },
        style,
      ]}>
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <>
          <Text style={[st.btnText, { color: fg }]}>{title}</Text>
          {subtitle ? <Text style={[st.btnSub, { color: fg }]}>{subtitle}</Text> : null}
        </>
      )}
    </Pressable>
  );
}

/** tone: plain | wash | forest | live */
export function Card({ children, style, tone = 'plain', flat }) {
  const bg =
    tone === 'forest' ? C.forest :
    tone === 'wash' ? C.wash :
    tone === 'live' ? C.live : C.white;
  const border = tone === 'plain' ? C.line : 'transparent';
  return (
    <View style={[st.card, !flat && SHADOW.card,
      { backgroundColor: bg, borderColor: border, borderWidth: tone === 'plain' ? 1 : 0 }, style]}>
      {children}
    </View>
  );
}

export function Row({ label, value, bold, onDark }) {
  return (
    <View style={st.row}>
      <Text style={[T.body, { color: onDark ? 'rgba(255,255,255,0.72)' : C.muted }]}>{label}</Text>
      <Text style={[T.body, bold && { fontWeight: '800' }, onDark && { color: C.white }]}>
        {value}
      </Text>
    </View>
  );
}

export function Pill({ text, tone = 'wash' }) {
  const map = {
    wash: [C.wash, C.green],
    live: [C.live, C.white],
    forest: [C.forest, C.white],
    red: [C.red, C.white],
    amber: ['#FDF3E2', C.amber],
    onDark: ['rgba(255,255,255,0.14)', C.white],
  };
  const [bg, fg] = map[tone] || map.wash;
  return (
    <View style={[st.pill, { backgroundColor: bg }]}>
      <Text style={[st.pillText, { color: fg }]}>{text}</Text>
    </View>
  );
}

/** A pulsing dot for the online state. Static here; animate with Reanimated. */
export function LiveDot({ color = C.live, size = 10 }) {
  return (
    <View style={{ width: size * 2.2, height: size * 2.2, borderRadius: size * 1.1,
      backgroundColor: `${color}33`, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />
    </View>
  );
}

export function Divider({ onDark }) {
  return <View style={[st.divider,
    { backgroundColor: onDark ? 'rgba(255,255,255,0.14)' : C.line }]} />;
}

/** Section heading. No accent rules — the type carries it. */
export function Label({ children, style }) {
  return <Text style={[T.label, { marginBottom: SP.sm }, style]}>{children}</Text>;
}

const st = StyleSheet.create({
  btn: {
    borderRadius: R.md, paddingVertical: 8, paddingHorizontal: 18,
    alignItems: 'center', justifyContent: 'center', minHeight: Z.primary,
  },
  // Secondary is 40 pt to the eye; hitSlop keeps the tap target at 44.
  btnSecondary: { minHeight: Z.secondary, paddingVertical: 6 },
  btnText: { fontSize: Z.buttonText, fontWeight: '700', letterSpacing: -0.2 },
  btnSub: { fontSize: 12, marginTop: 1, opacity: 0.85 },
  card: { borderRadius: R.md, padding: SP.md },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 5 },
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: R.pill, alignSelf: 'flex-start' },
  pillText: { fontSize: 12, fontWeight: '800', letterSpacing: 0.2 },
  divider: { height: 1, marginVertical: SP.sm },
});
