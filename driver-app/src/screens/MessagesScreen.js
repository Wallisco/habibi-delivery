import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TextInput, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useApp } from '../state/store';
import { Button, Card, Label } from '../components/UI';
import { C, T, R, SP, S } from '../theme';

/**
 * Two-way messaging with the back office.
 *
 * A driver stuck at a restaurant or unable to find an address needs to reach a
 * human without leaving the app or calling a number. Ops sees the same thread
 * with the driver's live state and current job beside it.
 */
export default function MessagesScreen() {
  const { fetchMessages, sendMessage, markMessagesRead, job } = useApp();
  const [messages, setMessages] = useState([]);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const scroller = useRef(null);

  const load = useCallback(async () => {
    try {
      const d = await fetchMessages();
      setMessages(d.messages ?? []);
      setErr(null);
      if (d.unread) markMessagesRead().catch(() => {});
    } catch (e) {
      setErr(e.message ?? 'Could not load messages.');
    }
  }, [fetchMessages, markMessagesRead]);

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  const send = async () => {
    const text = body.trim();
    if (!text) return;
    setBusy(true);
    try {
      await sendMessage(text, job?.id ?? null);
      setBody('');
      await load();
    } catch (e) {
      setErr(e.message ?? 'Could not send. Check your signal.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={S.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
      <ScrollView
        ref={scroller}
        contentContainerStyle={[S.content, { flexGrow: 1, justifyContent: 'flex-end' }]}
        onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: true })}>
        {err ? (
          <Card style={{ borderColor: C.red, borderWidth: 1.5, marginBottom: SP.md }}>
            <Text style={[T.small, { color: C.red }]}>{err}</Text>
          </Card>
        ) : null}

        {messages.length === 0 ? (
          <Card tone="wash" flat>
            <Text style={[T.h3, { color: C.green }]}>Nothing here yet</Text>
            <Text style={[T.small, { color: C.green, marginTop: 4 }]}>
              Message the office if a restaurant is holding you up, an address is wrong, or
              anything else needs a person.
            </Text>
          </Card>
        ) : (
          messages.map((m) => (
            <View key={m.id}
              style={[st.bubble, m.from === 'ops' ? st.fromOps : st.fromMe]}>
              <Text style={[T.body, m.from === 'driver' && { color: C.white }]}>{m.body}</Text>
              <Text style={[st.meta, m.from === 'driver' && { color: 'rgba(255,255,255,0.65)' }]}>
                {m.from === 'ops' ? (m.actor ?? 'Office') : 'You'} ·{' '}
                {new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </Text>
            </View>
          ))
        )}
      </ScrollView>

      <View style={st.composer}>
        <TextInput
          style={st.input}
          value={body}
          onChangeText={setBody}
          placeholder="Message the office…"
          placeholderTextColor={C.muted}
          multiline
          accessibilityLabel="Message to the office"
        />
        <Button title="Send" onPress={send} loading={busy} disabled={!body.trim()}
          style={{ paddingHorizontal: 22, minHeight: 50 }} />
      </View>
    </KeyboardAvoidingView>
  );
}

const st = StyleSheet.create({
  bubble: { maxWidth: '84%', padding: 13, borderRadius: 18, marginBottom: SP.sm },
  fromOps: { backgroundColor: C.white, borderWidth: 1, borderColor: C.line,
    alignSelf: 'flex-start', borderBottomLeftRadius: 5 },
  fromMe: { backgroundColor: C.forest, alignSelf: 'flex-end', borderBottomRightRadius: 5 },
  meta: { ...T.tiny, marginTop: 5 },
  composer: { flexDirection: 'row', gap: SP.sm, padding: SP.md,
    borderTopWidth: 1, borderTopColor: C.line, backgroundColor: C.white, alignItems: 'flex-end' },
  input: { flex: 1, borderWidth: 1.5, borderColor: C.line, borderRadius: R.md,
    paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: C.ink,
    backgroundColor: C.mist, maxHeight: 110 },
});
