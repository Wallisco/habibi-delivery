// Every screen must fit a 360×640 and a 390×844 phone without scrolling; only
// list bodies may scroll (driver-app/CLAUDE.md). See measure.js for how.
import React from 'react';
import { act, create } from 'react-test-renderer';
import { initYoga, measureScreen } from './measure';
import { DEVICES, screenHeight, modalHeight } from './devices';
import { CASES } from './fixtures';
import { KNOWN_FAILURES } from './known-failures';

jest.mock('../../src/state/store', () => ({ useApp: () => global.__layoutApp }));

// The map is a WebView; here it is a plain view of the same size.
jest.mock('react-native-webview', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { WebView: ({ style }) => React.createElement(View, { style }) };
});

const navigation = { navigate: () => {}, goBack: () => {}, setOptions: () => {}, addListener: () => () => {} };
const key = (c, d) => `${c.screen}/${c.state}@${d.name}`;
const ROWS = CASES.flatMap((c) => DEVICES.map((d) => [key(c, d), c, d]));
const stillFailing = [];

beforeAll(initYoga);
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

afterAll(() => {
  if (!stillFailing.length) return;
  console.log(`Known layout failures (${stillFailing.length}), to fix in Step 2:\n${
    stillFailing.map((s) => `  ${s}`).join('\n')}`);
});

test.each(ROWS)('%s fits without scrolling', async (name, c, device) => {
  global.__layoutApp = c.app();
  const Screen = c.component();
  let r;
  await act(async () => {
    r = create(<Screen navigation={navigation} route={{ params: c.params ?? {} }} />);
  });
  const { findings } = measureScreen(r.toJSON(), {
    width: device.width,
    height: screenHeight(device, c.header),
    modalHeight: modalHeight(device),
  });
  act(() => r.unmount());

  const listed = KNOWN_FAILURES.includes(name);
  const what = findings.map((f) => `${f.where}: ${f.detail}`).join('; ');

  if (findings.length && listed) {
    stillFailing.push(`${name}  ${what}`);
    return;
  }
  if (findings.length) {
    throw new Error(`${name} does not fit: ${what}`);
  }
  if (listed) {
    throw new Error(`${name} fits now. Remove it from __tests__/layout/known-failures.js.`);
  }
});

test('every known failure names a real screen, state and size', () => {
  const names = new Set(ROWS.map(([name]) => name));
  expect(KNOWN_FAILURES.filter((n) => !names.has(n))).toEqual([]);
});
