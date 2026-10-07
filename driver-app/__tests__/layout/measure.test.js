// Checks the layout measurer itself, so the screen test cannot pass by
// measuring nothing.
import React from 'react';
import { View, Text, ScrollView, FlatList, Modal, RefreshControl } from 'react-native';
import { act, create } from 'react-test-renderer';
import { initYoga, measureScreen, textSize } from './measure';
import { T } from '../../src/theme';

const PHONE = { width: 360, height: 640 };

beforeAll(initYoga);

async function measure(element, size = PHONE) {
  let r;
  await act(async () => { r = create(element); });
  const res = measureScreen(r.toJSON(), size);
  act(() => r.unmount());
  return res.findings;
}

const rows = (n) => Array.from({ length: n }, (_, i) => (
  <View key={i} style={{ height: 60 }}><Text>Row {i}</Text></View>
));

test('a 700 pt column is cut off on a 640 pt screen', async () => {
  const f = await measure(<View><View style={{ height: 700 }} /></View>);
  expect(f).toHaveLength(1);
  expect(f[0]).toMatchObject({ kind: 'cut off', overflow: 60 });
});

test('a flex: 1 column fits', async () => {
  expect(await measure(<View style={{ flex: 1 }}><View style={{ flex: 1 }} /></View>)).toEqual([]);
});

test('a ScrollView with more than a screen of content is reported', async () => {
  const f = await measure(<ScrollView style={{ flex: 1 }}>{rows(20)}</ScrollView>);
  expect(f).toHaveLength(1);
  expect(f[0]).toMatchObject({ kind: 'scrolls', overflow: 20 * 60 - 640 });
});

test('a ScrollView with pull-to-refresh is still measured', async () => {
  const f = await measure(
    <ScrollView style={{ flex: 1 }} refreshControl={<RefreshControl refreshing={false} />}>
      {rows(20)}
    </ScrollView>,
  );
  expect(f).toEqual([expect.objectContaining({ kind: 'scrolls', overflow: 20 * 60 - 640 })]);
});

test('a ScrollView that fits is fine', async () => {
  expect(await measure(<ScrollView style={{ flex: 1 }}>{rows(5)}</ScrollView>)).toEqual([]);
});

test('padding and fixed bars count against the ScrollView frame', async () => {
  const f = await measure(
    <View style={{ flex: 1 }}>
      <View style={{ height: 100 }} />
      <ScrollView contentContainerStyle={{ padding: 20 }}>{rows(9)}</ScrollView>
    </View>,
  );
  // 9 × 60 + 40 padding = 580 of content in a 540 pt frame.
  expect(f).toEqual([expect.objectContaining({ kind: 'scrolls', overflow: 40 })]);
});

test('a FlatList is a list body and may scroll', async () => {
  const data = Array.from({ length: 50 }, (_, i) => ({ id: String(i) }));
  const f = await measure(
    <View style={{ flex: 1 }}>
      <Text style={T.h2}>Your trips</Text>
      <FlatList style={{ flex: 1 }} data={data} keyExtractor={(d) => d.id}
        renderItem={() => <View style={{ height: 60 }} />} />
    </View>,
  );
  expect(f).toEqual([]);
});

test('a visible modal is measured over the whole screen; a hidden one is ignored', async () => {
  const sheet = (visible) => (
    <View style={{ flex: 1 }}>
      <Modal visible={visible} transparent>
        <View style={{ flex: 1, justifyContent: 'flex-end' }}>
          <View style={{ height: 700 }} />
        </View>
      </Modal>
    </View>
  );
  expect(await measure(sheet(false))).toEqual([]);
  const f = await measure(sheet(true));
  expect(f).toEqual([expect.objectContaining({ where: 'modal' })]);
});

test('text wraps onto more lines on a narrower screen', () => {
  const s = 'We hold jobs back until the kitchen is nearly done, so you are not standing around waiting for food.';
  const narrow = textSize(s, T.body, 360 - 2 * 22 - 2 * 22);
  const wide = textSize(s, T.body, 600);
  const line = T.body.lineHeight;
  expect(narrow.height).toBeGreaterThan(wide.height);
  expect(narrow.height).toBeGreaterThanOrEqual(3 * line);
  expect(textSize('Go online', T.body).height).toBe(line);
});

test('numberOfLines caps the height', () => {
  const s = 'a long line of text '.repeat(20);
  expect(textSize(s, T.body, 200, 2).height).toBe(2 * T.body.lineHeight);
});
