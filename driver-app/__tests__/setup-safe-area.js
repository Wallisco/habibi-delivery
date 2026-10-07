// Safe-area insets in tests. Screens pad their bottom by the phone's navigation
// bar (useBottomPad); the layout test sets global.__safeAreaInsets per phone so
// that padding is measured, and everything else gets zero.
jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const zero = { top: 0, bottom: 0, left: 0, right: 0 };
  const insets = () => global.__safeAreaInsets ?? zero;
  const frame = { x: 0, y: 0, width: 390, height: 844 };
  return {
    SafeAreaProvider: ({ children }) => children,
    SafeAreaView: ({ children }) => children,
    useSafeAreaInsets: () => insets(),
    useSafeAreaFrame: () => frame,
    SafeAreaInsetsContext: React.createContext(zero),
    SafeAreaFrameContext: React.createContext(frame),
    initialWindowMetrics: { insets: zero, frame },
  };
});
