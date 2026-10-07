/**
 * Simulated drivers, for staging only.
 *
 * Keychat integrates against staging (habibi-staging.quikr.co.za) before any
 * real driver is involved. Every order they create there is picked up by a
 * simulated driver who goes through the real driver endpoints, so the
 * webhooks, tracking page and statement they see are the production ones:
 *
 *   accepted → assigned → collected (tracking link) → code_issued → delivered
 *
 * in about 2–3 minutes. Test hooks, anywhere in `externalId`:
 *   SIMFAIL  collected, then closed as failed (delivery.failed)
 *   SIMSLOW  every step takes 3× longer
 *
 * And one more hook, NOSIM: simulated drivers leave that order alone, so a
 * real phone on staging gets the offer.
 *
 * Like the app, a simulated driver holds a sign-in token and checks
 * /v1/driver/current as it goes: a job the office cancelled, closed, reassigned
 * or cleared is dropped, and an office sign-out (401) stops the driver.
 *
 * The simulator never runs unless DISPATCH_ENV=staging (see server.js), and
 * its drivers are ordinary accounts named "Test driver" with SIM- phones.
 */
import { SUPPLY } from './supply.js';
import { ONBOARDING, REQUIRED_DOCS } from './accounts.js';

/** Seconds after the previous step. ~2.5 min end to end, plus dispatch. */
export const STEPS = { accept: 8, collect: 50, approach: 60, complete: 25 };
const MAX_DRIVERS = 25;
const TERMINAL = ['DELIVERED', 'FAILED', 'CANCELLED'];
const isNoSim = (job) => /NOSIM/i.test(job?.externalId ?? '');

const offset = (p, metres) => ({
  lat: (p.lat ?? p.latitude) + metres / 111320,
  lng: (p.lng ?? p.longitude) + metres / (111320 * Math.cos(((p.lat ?? p.latitude) * Math.PI) / 180)),
});
const lerp = (a, b, f) => ({
  lat: (a.lat ?? a.latitude) + ((b.lat ?? b.latitude) - (a.lat ?? a.latitude)) * f,
  lng: (a.lng ?? a.longitude) + ((b.lng ?? b.longitude) - (a.lng ?? a.longitude)) * f,
});

export class Simulator {
  /**
   * @param app       the Fastify app (driver calls go through app.inject)
   * @param engine    { supply, jobs, accounts, pendingOffers, driverTokens }
   * @param closeJob  (job, { outcome, reason, actor }) — the back office close
   * @param speed     1 in staging; tests pass a large number to compress time
   */
  constructor({ app, engine, closeJob, speed = 1, log = null }) {
    this.app = app;
    this.e = engine;
    this.closeJob = closeJob;
    this.speed = speed;
    this.log = log;
    this.runs = new Map();   // driverId -> { jobId, step, dueAt, collectedAt, slow, fail }
    this.offerSeen = new Map(); // driverId -> ms the offer was first seen
    this.tokens = new Map();    // driverId -> sign-in token
    this.timer = null;
    this.busy = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.step().catch((err) => this.log?.error?.(err, 'simulator step failed')); }, 1000);
  }
  stop() { clearInterval(this.timer); this.timer = null; }

  ms(seconds, slow) { return (seconds * 1000 * (slow ? 3 : 1)) / this.speed; }

  simDrivers() { return this.e.accounts.all().filter((a) => String(a.phone).startsWith('SIM-')); }

  /**
   * Make sure a free simulated driver is standing near this order's store.
   * `exclude`: an order the office put back in the pool goes to someone other
   * than the driver it was taken from.
   */
  onJob(job, { exclude = null } = {}) {
    if (isNoSim(job)) return null;
    const free = this.simDrivers().find((a) => {
      const d = this.e.supply.get(a.driverId);
      return a.driverId !== exclude && !this.runs.has(a.driverId) && !d?.activeJobId;
    });
    let acct = free;
    if (!acct) {
      const n = this.simDrivers().length + 1;
      if (n > MAX_DRIVERS) return null;
      acct = this.e.accounts.register({ phone: `SIM-${String(n).padStart(3, '0')}`, firstName: 'Test driver', lastName: String(n), vehicleType: 'Motorbike' });
      // Straight to active: these are not people, and nothing real rides on them.
      for (const r of REQUIRED_DOCS) acct.documents[r.key] = { status: 'VERIFIED', at: Date.now(), note: 'simulated' };
      acct.vehicleReg = `SIM ${n}`;
      this.e.accounts.setOnboarding(acct.driverId, ONBOARDING.ACTIVE, { actor: 'simulator' });
    }
    this.e.supply.upsert(acct.driverId, {
      state: SUPPLY.ZONE_COMMITTED, zone: job.zone ?? null, position: offset(job.pickup, 250),
      phone: acct.phone,
    });
    // Signed in, the way the app is (again, after an office sign-out).
    if (!this.tokens.has(acct.driverId)) this.tokens.set(acct.driverId, this.e.driverTokens.issue(acct.driverId));
    return acct.driverId;
  }

  async call(method, url, payload, headers) {
    const res = await this.app.inject({ method, url, payload, headers });
    if (res.statusCode >= 400) this.log?.warn?.({ url, status: res.statusCode, body: res.body }, 'simulator call refused');
    return res;
  }

  /** One pass: answer offers, move drivers, run due steps. */
  async step(now = Date.now()) {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const acct of this.simDrivers()) {
        const id = acct.driverId;
        const d = this.e.supply.get(id);
        if (!d) continue;
        const run = this.runs.get(id);

        if (!run) {
          // Idle: stay fresh for dispatch, and take any offer after a pause.
          if (d.state !== SUPPLY.OFFLINE && d.position) this.e.supply.upsert(id, { position: d.position });
          const offer = this.e.pendingOffers.get(id);
          if (!offer || offer.expiresAt <= now) { this.offerSeen.delete(id); continue; }
          const first = this.offerSeen.get(id) ?? now;
          this.offerSeen.set(id, first);
          const job = this.e.jobs.get(offer.jobId);
          if (isNoSim(job)) {
            // Pass it on at once, so it reaches the real phone it is meant for.
            this.offerSeen.delete(id);
            await this.call('POST', `/v1/jobs/${offer.jobId}/decline`, { driverId: id });
            continue;
          }
          const slow = /SIMSLOW/i.test(job?.externalId ?? '');
          if (now - first < this.ms(STEPS.accept, slow)) continue;
          this.offerSeen.delete(id);
          const res = await this.call('POST', `/v1/jobs/${offer.jobId}/accept`, { driverId: id });
          if (res.statusCode >= 400) continue;
          const jobIds = (res.json().jobs ?? []).map((j) => j.id ?? j.jobId).filter(Boolean);
          this.runs.set(id, {
            jobIds: jobIds.length ? jobIds : [offer.jobId], i: 0, step: 'collect',
            dueAt: now + this.ms(STEPS.collect, slow), slow,
            fail: /SIMFAIL/i.test(job?.externalId ?? ''), legStart: now,
          });
          continue;
        }

        // Ask dispatch what this driver still carries, as the app does.
        const token = this.tokens.get(id);
        const cur = await this.call('GET', `/v1/driver/current?jobs=${run.jobIds.slice(run.i).join(',')}`,
          undefined, token ? { authorization: `Bearer ${token}` } : {});
        if (cur.statusCode === 401) {
          // Signed out by the office: stop where we are, like a phone at sign-in.
          this.runs.delete(id);
          this.tokens.delete(id);
          this.log?.info?.({ driverId: id }, 'simulated driver signed out by the office');
          continue;
        }
        if (cur.statusCode === 200) {
          const gone = new Set(cur.json().ended.filter((e) => e.reason !== 'DELIVERED').map((e) => e.jobId));
          if (gone.has(run.jobIds[run.i])) {
            this.log?.info?.({ driverId: id, jobId: run.jobIds[run.i] }, 'simulated driver dropped a job the office ended');
            this.next(id, run, now);
            continue;
          }
        }

        const job = this.e.jobs.get(run.jobIds[run.i]);
        if (!job || TERMINAL.includes(job.status)) { this.next(id, run, now); continue; }

        // Ride towards the store, then the customer, so the tracking map moves.
        const target = run.step === 'collect' ? job.pickup : job.dropoff;
        const from = run.step === 'collect' ? (d.position ?? job.pickup) : (run.from ?? job.pickup);
        const span = Math.max(1, run.dueAt - run.legStart);
        const f = Math.min(1, Math.max(0, (now - run.legStart) / span));
        this.e.supply.upsert(id, { position: run.step === 'collect' ? lerp(from, target, Math.min(1, f + 0.05)) : lerp(from, target, f) });

        if (now < run.dueAt) continue;

        if (run.step === 'collect') {
          await this.call('POST', `/v1/jobs/${job.id}/collect`);
          if (run.fail) {
            run.step = 'fail'; run.dueAt = now + this.ms(STEPS.approach, run.slow);
          } else {
            run.step = 'approach'; run.dueAt = now + this.ms(STEPS.approach, run.slow);
          }
          run.from = { lat: job.pickup.lat ?? job.pickup.latitude, lng: job.pickup.lng ?? job.pickup.longitude };
          run.legStart = now;
        } else if (run.step === 'fail') {
          this.closeJob(job, { outcome: 'FAILED', reason: 'Simulated: customer unreachable', actor: 'simulator' });
          this.next(id, run, now);
        } else if (run.step === 'approach') {
          this.e.supply.upsert(id, { position: offset(job.dropoff, 20) });
          await this.call('POST', `/v1/jobs/${job.id}/approach`);
          run.step = 'complete'; run.dueAt = now + this.ms(STEPS.complete, run.slow); run.legStart = now;
        } else if (run.step === 'complete') {
          const at = { lat: job.dropoff.lat ?? job.dropoff.latitude, lng: job.dropoff.lng ?? job.dropoff.longitude };
          await this.call('POST', '/v1/jobs/complete', {
            jobId: job.id, grade: 'A', position: at, gpsTrail: [at], code: 'simulated',
          });
          this.next(id, run, now);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  /** Next order on the same run, or back to idle. */
  next(id, run, now) {
    run.i += 1;
    if (run.i < run.jobIds.length) {
      const job = this.e.jobs.get(run.jobIds[run.i]);
      // Stacked orders were collected together at the first store.
      run.step = job?.collectedAt ? 'approach' : 'collect';
      run.dueAt = now + this.ms(run.step === 'collect' ? STEPS.collect : STEPS.approach, run.slow);
      run.legStart = now;
      return;
    }
    this.runs.delete(id);
    const d = this.e.supply.get(id);
    if (d) this.e.supply.upsert(id, { state: SUPPLY.ZONE_COMMITTED, activeJobId: null, activeBatchId: null });
  }
}
