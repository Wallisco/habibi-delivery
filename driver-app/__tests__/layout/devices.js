/**
 * The two phones every screen must fit (driver-app/CLAUDE.md), and what each
 * loses to system bars and the navigation header. Sizes are in points.
 *
 * 360×640: a small Android phone. 24 pt status bar, 56 pt native-stack header.
 * 390×844: an iPhone 12–15. 47 pt top inset, 34 pt home indicator, 44 pt header.
 *
 * The home-indicator strip is counted as unusable: a button under it is not
 * one a driver can comfortably tap.
 */
export const DEVICES = [
  { name: '360x640', width: 360, height: 640, top: 24, bottom: 0, header: 56 },
  { name: '390x844', width: 390, height: 844, top: 47, bottom: 34, header: 44 },
];

/** Height a screen gets for its own content. */
export const screenHeight = (device, withHeader) =>
  device.height - device.top - device.bottom - (withHeader ? device.header : 0);

/** A modal covers the header too. */
export const modalHeight = (device) => device.height - device.top - device.bottom;
