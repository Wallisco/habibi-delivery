/**
 * Driver accounts.
 *
 * IDs and codes follow the conventions in the Mr D data we hold, so anyone who
 * has worked an incumbent back office reads ours without retraining:
 *
 *   Driver Admin ID   6-digit numeric        e.g. 129105, 134845, 7303
 *   Hub Code          3-letter               e.g. TYG (Tygervalley)
 *   Order Number      vertical prefix + 9    e.g. DFD323345084, GROC...
 *   Shift Slot        "16:00-22:00", "11:00-16:00", "Before 11:00"
 *   Vehicle Type      Motorbike, Car, Bicycle, Van
 *
 * ONBOARDING IS A STATE MACHINE, NOT A FLAG
 * A driver cannot be dispatched until they are ACTIVE, and they only reach
 * ACTIVE once every document is verified. Making that a sequence rather than a
 * boolean is what stops an unvetted person carrying someone's dinner, and it
 * gives ops a queue to work rather than a spreadsheet.
 */

export const ONBOARDING = {
  REGISTERED: 'REGISTERED',       // signed up, nothing verified
  DOCS_SUBMITTED: 'DOCS_SUBMITTED',
  DOCS_VERIFIED: 'DOCS_VERIFIED', // licence, ID, roadworthy, insurance
  VEHICLE_ASSIGNED: 'VEHICLE_ASSIGNED',
  ACTIVE: 'ACTIVE',               // may receive offers
  SUSPENDED: 'SUSPENDED',
  OFFBOARDED: 'OFFBOARDED',
};

export const ONBOARDING_ORDER = [
  ONBOARDING.REGISTERED, ONBOARDING.DOCS_SUBMITTED, ONBOARDING.DOCS_VERIFIED,
  ONBOARDING.VEHICLE_ASSIGNED, ONBOARDING.ACTIVE,
];

export const REQUIRED_DOCS = [
  { key: 'id_document', label: 'ID or passport' },
  { key: 'drivers_licence', label: "Driver's licence" },
  { key: 'roadworthy', label: 'Roadworthy certificate' },
  { key: 'insurance', label: 'Vehicle insurance' },
  { key: 'police_clearance', label: 'Police clearance' },
  { key: 'bank_confirmation', label: 'Bank account confirmation' },
];

export const SHIFT_SLOTS = ['Before 11:00', '11:00-16:00', '16:00-22:00'];
export const VEHICLE_TYPES = ['Motorbike', 'Car', 'Bicycle', 'Van'];

export const HUBS = [
  { code: 'TYG', name: 'Tygervalley', zone: 'Durbanville' },
  { code: 'MIL', name: 'Milnerton', zone: 'Milnerton' },
  { code: 'CBD', name: 'Cape Town CBD', zone: 'Cape Town' },
];

/** Vertical prefixes, matching Mr D's order numbering. */
export const VERTICAL_PREFIX = { FOOD: 'DFD', GROCERY: 'GROC', CONVENIENCE: 'CONV', PARCEL: 'LOOP' };

export function orderNumber(vertical = 'FOOD') {
  const prefix = VERTICAL_PREFIX[vertical] ?? 'DFD';
  // Nine digits, like theirs. Time-ordered so a support agent reading two
  // numbers can tell which came first.
  const n = String(Date.now()).slice(-9);
  return `${prefix}${n}`;
}

export class DriverAccounts {
  constructor(db = null) {
    this.db = db;
    this.byId = new Map();
    this.byPhone = new Map();
    this.nextId = 100000;
  }

  hydrate(rows) {
    for (const d of rows) {
      this.byId.set(d.driverId, d);
      if (d.phone) this.byPhone.set(d.phone, d.driverId);
      const n = Number(d.driverId);
      if (Number.isFinite(n) && n >= this.nextId) this.nextId = n + 1;
    }
    return rows.length;
  }

  /** Six-digit numeric, as in the Mr D exports. */
  allocateId() {
    return String(this.nextId++);
  }

  register({ phone, firstName = '', lastName = '', hubCode = 'TYG',
    vehicleType = 'Motorbike', shiftSlot = '16:00-22:00' }) {
    const existing = this.byPhone.get(phone);
    if (existing) return this.byId.get(existing);

    const hub = HUBS.find((h) => h.code === hubCode) ?? HUBS[0];
    const account = {
      driverId: this.allocateId(),
      phone,
      firstName,
      lastName,
      hubCode: hub.code,
      zone: hub.zone,
      vehicleType,
      vehicleReg: null,
      shiftSlot,
      onboarding: ONBOARDING.REGISTERED,
      documents: Object.fromEntries(
        REQUIRED_DOCS.map((d) => [d.key, { status: 'MISSING', at: null, note: null }])),
      rating: 5.0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      notes: [],
    };
    this.byId.set(account.driverId, account);
    this.byPhone.set(phone, account.driverId);
    this.db?.saveAccount(account);
    return account;
  }

  get(driverId) { return this.byId.get(String(driverId)); }
  all() { return [...this.byId.values()]; }

  /** Dispatch may only offer to a driver who has cleared onboarding. */
  isDispatchable(driverId) {
    return this.get(driverId)?.onboarding === ONBOARDING.ACTIVE;
  }

  update(driverId, patch, actor = 'ops') {
    const a = this.get(driverId);
    if (!a) return null;
    const allowed = ['firstName', 'lastName', 'hubCode', 'vehicleType', 'vehicleReg',
      'shiftSlot', 'zone'];
    for (const k of allowed) if (k in patch) a[k] = patch[k];
    a.updatedAt = Date.now();
    a.notes.push({ at: Date.now(), actor, text: `Updated ${Object.keys(patch).join(', ')}` });
    this.db?.saveAccount(a);
    return a;
  }

  setDocument(driverId, docKey, status, { note = null, actor = 'ops' } = {}) {
    const a = this.get(driverId);
    if (!a || !a.documents[docKey]) return null;
    a.documents[docKey] = { status, at: Date.now(), note };
    a.updatedAt = Date.now();
    a.notes.push({ at: Date.now(), actor, text: `${docKey} → ${status}` });

    // Advance automatically once every document is verified. Ops should not
    // have to remember to flip a second switch after approving the last one.
    const all = Object.values(a.documents);
    if (all.every((d) => d.status === 'VERIFIED')
      && a.onboarding === ONBOARDING.DOCS_SUBMITTED) {
      a.onboarding = ONBOARDING.DOCS_VERIFIED;
    } else if (all.some((d) => d.status !== 'MISSING')
      && a.onboarding === ONBOARDING.REGISTERED) {
      a.onboarding = ONBOARDING.DOCS_SUBMITTED;
    }
    this.db?.saveAccount(a);
    return a;
  }

  setOnboarding(driverId, state, { actor = 'ops', reason = null } = {}) {
    const a = this.get(driverId);
    if (!a || !Object.values(ONBOARDING).includes(state)) return null;

    // Activation is the one transition with a hard precondition. Everything
    // else an operator can do by hand, but nobody should be able to click a
    // driver live with an unverified licence.
    if (state === ONBOARDING.ACTIVE) {
      const missing = Object.entries(a.documents)
        .filter(([, d]) => d.status !== 'VERIFIED')
        .map(([k]) => k);
      if (missing.length) {
        return { error: `Cannot activate: ${missing.join(', ')} not verified` };
      }
      if (!a.vehicleReg) return { error: 'Cannot activate: no vehicle registered' };
    }

    a.onboarding = state;
    a.updatedAt = Date.now();
    a.notes.push({ at: Date.now(), actor, text: `Onboarding → ${state}${reason ? `: ${reason}` : ''}` });
    this.db?.saveAccount(a);
    return a;
  }

  addNote(driverId, text, actor = 'ops') {
    const a = this.get(driverId);
    if (!a) return null;
    a.notes.push({ at: Date.now(), actor, text });
    this.db?.saveAccount(a);
    return a;
  }

  /** The onboarding work queue, oldest first. */
  pipeline() {
    return this.all()
      .filter((a) => ![ONBOARDING.ACTIVE, ONBOARDING.OFFBOARDED].includes(a.onboarding))
      .map((a) => ({
        driverId: a.driverId,
        name: `${a.firstName} ${a.lastName}`.trim() || a.phone,
        phone: a.phone,
        hubCode: a.hubCode,
        onboarding: a.onboarding,
        docsVerified: Object.values(a.documents).filter((d) => d.status === 'VERIFIED').length,
        docsTotal: REQUIRED_DOCS.length,
        waitingDays: Number(((Date.now() - a.createdAt) / 86400000).toFixed(1)),
      }))
      .sort((a, b) => b.waitingDays - a.waitingDays);
  }
}
