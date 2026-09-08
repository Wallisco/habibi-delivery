/**
 * Design tokens.
 *
 * Built for a driver holding a phone at 18:00 in traffic, one-handed, often in
 * a helmet. Everything here serves glanceability first: high contrast, large
 * hit areas, and one dominant surface that tells you your state without
 * reading a word.
 *
 * The motif is a single hero surface at the top of every screen. Deep green
 * when you are earning, white when you are not. That colour change is the
 * primary status signal in the whole app.
 */

export const C = {
  forest: '#084A2C',   // hero surface when online
  green: '#0F7A46',    // primary actions, headings
  live: '#22C069',     // earning-now accent, money, progress
  wash: '#EAF6EF',     // tinted panels
  mist: '#F7FAF8',     // app background: a white with green in it

  ink: '#0C1A12',      // text, near-black with a green undertone
  muted: '#647268',
  line: '#DDE7E1',
  white: '#FFFFFF',

  amber: '#B8791A',    // waiting, caution
  red: '#C0442F',      // blocked, failed, countdown
};

export const R = { sm: 10, md: 16, lg: 22, pill: 999 };
export const SP = { xs: 6, sm: 10, md: 16, lg: 22, xl: 30 };

export const T = {
  money: { fontSize: 52, fontWeight: '800', letterSpacing: -1.8, color: C.ink },
  hero: { fontSize: 40, fontWeight: '800', letterSpacing: -1.2, color: C.ink },
  h1: { fontSize: 27, fontWeight: '800', letterSpacing: -0.6, color: C.ink },
  h2: { fontSize: 20, fontWeight: '700', letterSpacing: -0.3, color: C.ink },
  h3: { fontSize: 16, fontWeight: '700', color: C.ink },
  body: { fontSize: 15, color: C.ink, lineHeight: 21 },
  small: { fontSize: 13.5, color: C.muted, lineHeight: 19 },
  tiny: { fontSize: 11.5, color: C.muted, letterSpacing: 0.2 },
  label: { fontSize: 12, fontWeight: '700', color: C.muted, letterSpacing: 0.6 },
};

export const SHADOW = {
  card: {
    shadowColor: '#0C1A12', shadowOpacity: 0.05, shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 }, elevation: 2,
  },
  lift: {
    shadowColor: '#0C1A12', shadowOpacity: 0.12, shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 }, elevation: 6,
  },
};

export const S = {
  screen: { flex: 1, backgroundColor: C.mist },
  content: { padding: SP.lg, paddingBottom: 48 },
};
