import React, { useState } from 'react';
import { View, Text, TextInput, StyleSheet, KeyboardAvoidingView, Platform } from 'react-native';
import { useApp } from '../state/store';
import { Button } from '../components/UI';
import { C, T, R, SP } from '../theme';

export default function SignInScreen() {
  const { signIn } = useApp();
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const go = async () => {
    setBusy(true); setErr(null);
    try { await signIn(phone); }
    catch (e) { setErr(e.message ?? 'Could not sign you in. Check your signal and try again.'); }
    finally { setBusy(false); }
  };

  return (
    <KeyboardAvoidingView style={st.wrap} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={st.inner}>
        <View style={st.mark} />
        <Text style={st.brand}>Ready when{'\n'}you are.</Text>
        <Text style={st.lede}>Sign in with the number you registered with.</Text>

        <TextInput
          style={st.input}
          value={phone}
          onChangeText={setPhone}
          placeholder="082 000 0000"
          placeholderTextColor={C.muted}
          keyboardType="phone-pad"
          autoComplete="tel"
          accessibilityLabel="Phone number"
        />
        {err ? <Text style={st.err}>{err}</Text> : null}

        <Button title="Sign in" onPress={go} loading={busy}
          disabled={phone.replace(/\D/g, '').length < 9} style={{ marginTop: SP.md }} />

        <Text style={st.note}>
          Your ID, licence and vehicle details are verified before your first shift.
        </Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const st = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: C.white, justifyContent: 'center' },
  inner: { paddingHorizontal: 30 },
  mark: { width: 46, height: 46, borderRadius: 14, backgroundColor: C.live, marginBottom: SP.xl },
  brand: { ...T.hero, lineHeight: 44, marginBottom: SP.sm },
  lede: { ...T.small, fontSize: 15, marginBottom: SP.xl },
  input: {
    backgroundColor: C.mist, borderRadius: R.md, paddingHorizontal: 18, paddingVertical: 20,
    color: C.ink, fontSize: 20, fontWeight: '600', borderWidth: 1.5, borderColor: C.line,
  },
  err: { color: C.red, marginTop: SP.sm, fontSize: 13, lineHeight: 18 },
  note: { ...T.tiny, marginTop: SP.lg, lineHeight: 17 },
});
