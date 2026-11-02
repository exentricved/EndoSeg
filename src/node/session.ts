// The cases this app run holds open-case locks on. Pure Node so it is unit tested.
//
// - One case is "open" (shown) at a time; opening another closes the first.
// - A write in progress (intake, export, save) keeps its case's lock until it
//   finishes, even if the user goes back to Cases meanwhile, so nobody else can
//   open the case halfway through.
// - open/close/heartbeat run one at a time, in the order they were asked for,
//   so a heartbeat can't recreate a lock that was just released and a quick
//   close-then-open can't leave a stray lock behind.

import { acquireLock, heartbeat, releaseLock, holderLabel, HEARTBEAT_MS, type AcquireResult, type LockInfo, type Me } from "./caselock.js";

/** A write was refused because someone else has the case open. */
export class CaseLockedError extends Error {
  constructor(readonly holder: LockInfo) {
    super(`${holderLabel(holder)} has this case open, so it can't be changed here.`);
    this.name = "CaseLockedError";
  }
}

interface Entry {
  dir: string;
  lock: LockInfo;
  /** Shown in the app right now (not just kept for a running write). */
  open: boolean;
  /** Writes in progress. */
  ops: number;
}

export interface CaseSessionOptions {
  /** Called when another computer takes over a case we hold. */
  onLost: (ref: string) => void;
  now?: () => number;
  heartbeatMs?: number;
}

export class CaseSession {
  private readonly entries = new Map<string, Entry>();
  private chain: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(
    readonly me: Me,
    private readonly opts: CaseSessionOptions,
  ) {
    this.now = opts.now ?? Date.now;
  }

  /** Run `fn` after everything queued before it. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.chain.then(fn, fn);
    this.chain = r.catch(() => undefined);
    return r;
  }

  /** True while we hold the lock on `ref` (open, or kept for a running write). */
  holds(ref: string): boolean {
    return this.entries.has(ref);
  }

  /** Open `ref` (taking its lock), closing whatever else was open. */
  open(ref: string, dir: string, force = false): Promise<AcquireResult> {
    return this.serial(async () => {
      await this.closeAll(ref);
      const r = await acquireLock(dir, this.me, this.now(), force);
      if (r.ok) {
        const e = this.entries.get(ref);
        if (e) Object.assign(e, { dir, lock: r.lock, open: true });
        else this.entries.set(ref, { dir, lock: r.lock, open: true, ops: 0 });
        this.startTimer();
      }
      return r;
    });
  }

  /** Close the open case. Its lock is released once no write is running on it. */
  close(): Promise<void> {
    return this.serial(() => this.closeAll(null));
  }

  /** Release every lock (quitting). */
  releaseAll(): Promise<void> {
    return this.serial(async () => {
      for (const [ref, e] of [...this.entries]) await this.drop(ref, e);
    });
  }

  /**
   * Run a write on `ref`. If the case isn't held (a delete from the case list,
   * or a save arriving just after Back) its lock is taken for the write, or
   * CaseLockedError is thrown if someone else has it. The lock is kept until
   * the write finishes, even if the case is closed meanwhile. Queued behind any
   * open in progress, so a write sent right after opening finds the lock.
   */
  async run<T>(ref: string, dir: string, fn: () => Promise<T>): Promise<T> {
    const e = await this.serial(async () => {
      let cur = this.entries.get(ref);
      if (!cur) {
        const r = await acquireLock(dir, this.me, this.now());
        if (!r.ok) throw new CaseLockedError(r.holder);
        cur = { dir, lock: r.lock, open: false, ops: 0 };
        this.entries.set(ref, cur);
        this.startTimer();
      }
      cur.ops++;
      return cur;
    });
    try {
      return await fn();
    } finally {
      e.ops--;
      if (!e.open && e.ops === 0) {
        void this.serial(async () => {
          if (this.entries.get(ref) === e && !e.open && e.ops === 0) await this.drop(ref, e);
        });
      }
    }
  }

  /** Resolves once everything queued so far has run (tests). */
  settled(): Promise<void> {
    return this.serial(async () => undefined);
  }

  /** Refresh every held lock. Public so tests can drive it without timers. */
  beat(): Promise<void> {
    return this.serial(async () => {
      for (const [ref, e] of [...this.entries]) {
        try {
          const next = await heartbeat(e.dir, e.lock, this.now());
          if (this.entries.get(ref) !== e) continue;
          if (next) e.lock = next;
          else {
            this.entries.delete(ref);
            this.opts.onLost(ref);
          }
        } catch {
          // NAS blip: keep the case and try again on the next beat.
        }
      }
      this.stopTimerIfIdle();
    });
  }

  private async closeAll(keep: string | null): Promise<void> {
    for (const [ref, e] of [...this.entries]) {
      if (ref === keep) continue;
      e.open = false;
      if (e.ops === 0) await this.drop(ref, e);
    }
  }

  private async drop(ref: string, e: Entry): Promise<void> {
    this.entries.delete(ref);
    await releaseLock(e.dir, this.me.sessionId);
    this.stopTimerIfIdle();
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.beat(), this.opts.heartbeatMs ?? HEARTBEAT_MS);
    this.timer.unref?.();
  }

  private stopTimerIfIdle(): void {
    if (this.entries.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
