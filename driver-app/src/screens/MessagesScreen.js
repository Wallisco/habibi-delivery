import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, FlatList, StyleSheet, TextInput, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useApp } from '../state/store';
import { Button, Card, Label, useBottomPad } from '../components/UI';
import { C, T, R, SP, S, Z } from '../theme';

/**
 * Two-way messaging with the back office.
 *
 * A driver stuck at a restaurant or unable to find an address needs to reach a
 * human without leaving the app or calling a number. Ops sees the same thread
 * with the driver's live state and current job beside it.
 */
export default function MessagesScreen() {
  // The composer clears the phone's navigation buttons.
  const composerPad = useBottomPad(SP.sm);
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
      {err ? (
        <Card style={st.error}>
          <Text style={[T.small, { color: C.red }]}>{err}</Text>
        </Card>
      ) : null}

      {/* The thread is the list: it scrolls, the composer stays put. */}
      <FlatList
        ref={scroller}
        style={{ flex: 1 }}
        data={messages}
        keyExtractor={(m) => String(m.id)}
        contentContainerStyle={st.thread}
        onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: true })}
        ListEmptyComponent={
          <Card tone="wash" flat>
            <Text style={[T.h3, { color: C.green }]}>Nothing here yet</Text>
            <Text style={[T.small, { color: C.green, marginTop: SP.xs }]}>
              Message the office if a restaurant is holding you up, an address is wrong, or
              anything else needs a person.
            </Text>
          </Card>
        }
        renderItem={({ item: m }) => (
          <View style={[st.bubble, m.from === 'ops' ? st.fromOps : st.fromMe]}>
            <Text style={[T.body, m.from === 'driver' && { color: C.white }]}>{m.body}</Text>
            <Text style={[st.meta, m.from === 'driver' && { color: 'rgba(255,255,255,0.65)' }]}>
              {m.from === 'ops' ? (m.actor ?? 'Office') : 'You'} ·{' '}
              {new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </Text>
          </View>
        )}
      />

      <View style={[st.composer, composerPad]}>
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
          style={{ paddingHorizontal: SP.lg }} />
      </View>
    </KeyboardAvoidingView>
  );
}

const st = StyleSheet.create({
  error: { borderColor: C.red, borderWidth: 1.5, margin: SP.md, marginBottom: 0 },
  thread: { flexGrow: 1, justifyContent: 'flex-end', padding: SP.md },
  bubble: { maxWidth: '84%', paddingHorizontal: SP.md, paddingVertical: SP.sm, borderRadius: R.md, marginBottom: SP.sm },
  fromOps: { backgroundColor: C.white, borderWidth: 1, borderColor: C.line,
    alignSelf: 'flex-start', borderBottomLeftRadius: 5 },
  fromMe: { backgroundColor: C.forest, alignSelf: 'flex-end', borderBottomRightRadius: 5 },
  meta: { ...T.tiny, marginTop: 2 },
  composer: { flexDirection: 'row', gap: SP.sm, padding: SP.sm,
    borderTopWidth: 1, borderTopColor: C.line, backgroundColor: C.white, alignItems: 'flex-end' },
  input: { flex: 1, borderWidth: 1.5, borderColor: C.line, borderRadius: R.md,
    paddingHorizontal: SP.md, paddingVertical: SP.sm, fontSize: Z.body, color: C.ink,
    backgroundColor: C.mist, minHeight: Z.primary, maxHeight: 110 },
});
