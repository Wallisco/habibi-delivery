/**
 * The two phones every screen must fit (driver-app/CLAUDE.md), and what each
 * loses to system bars and the navigation header. Sizes are in points.
 *
 * 360×640: a small Android phone. 24 pt status bar, 56 pt native-stack header,
 *          and a 48 pt three-button navigation bar at the bottom. Expo draws
 *          the app edge to edge, so that bar sits over the screen.
 * 390×844: an iPhone 12–15. 47 pt top inset, 44 pt header, 34 pt home indicator.
 *
 * The bottom bar is part of the screen's height, but screens must keep their
 * content out of it (useBottomPad). The layout test gives each screen that
 * inset and fails anything a driver would read or tap that ends underneath it.
 */
export const DEVICES = [
  { name: '360x640', width: 360, height: 640, top: 24, bottom: 48, header: 56 },
  { name: '390x844', width: 390, height: 844, top: 47, bottom: 34, header: 44 },
];

/** Height a screen gets, down to the bottom edge (the navigation bar sits over its last `bottom` pt). */
export const screenHeight = (device, withHeader) =>
  device.height - device.top - (withHeader ? device.header : 0);

/** A modal covers the header too. */
export const modalHeight = (device) => device.height - device.top;

/** The insets a screen is given (what useSafeAreaInsets returns on that phone). */
export const insetsFor = (device) => ({ top: 0, bottom: device.bottom, left: 0, right: 0 });
