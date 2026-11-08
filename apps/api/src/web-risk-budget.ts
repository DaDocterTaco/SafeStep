import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const webRiskDirectory = join(homedir(), '.safestep', 'web-risk');
const dayMs = 86400000;
const monthOf = (time: number) => {
  const at = new Date(time);
  return at.getUTCFullYear() * 12 + at.getUTCMonth();
};
type Limits = {
  profile: string;
  minuteCap: number;
  dayCap: number;
  monthCap: number;
  concurrency: number;
  lastClock: number;
  blockedUntil: number;
};
const ddl = `
  CREATE TABLE meter(id INTEGER PRIMARY KEY CHECK(id=1), profile TEXT NOT NULL,
    minuteCap INTEGER NOT NULL, dayCap INTEGER NOT NULL, monthCap INTEGER NOT NULL,
    concurrency INTEGER NOT NULL, lastClock INTEGER NOT NULL, blockedUntil INTEGER NOT NULL) STRICT;
  CREATE TABLE admissions(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, day INTEGER NOT NULL, month INTEGER NOT NULL,
    units INTEGER NOT NULL CHECK(units>0), kind TEXT NOT NULL, lease INTEGER NOT NULL) STRICT;
  CREATE INDEX admissions_time ON admissions(at);
  CREATE INDEX admissions_month ON admissions(month,day);
  CREATE TABLE positives(subject TEXT PRIMARY KEY, checked INTEGER NOT NULL, expires INTEGER NOT NULL, categories TEXT NOT NULL) STRICT;
  PRAGMA user_version=2;`;

function withDB<T>(directory: string, fn: (db: DatabaseSync) => T) {
  const file = join(directory, 'limits.sqlite');
  if (!lstatSync(directory).isDirectory() || !lstatSync(file).isFile())
    throw Error('Web Risk budget unavailable.');
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout=2500; PRAGMA synchronous=FULL;');
    return fn(db);
  } finally {
    db.close();
  }
}
function transaction<T>(db: DatabaseSync, fn: () => T) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = fn();
    db.exec('COMMIT');
    return value;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
function limits(db: DatabaseSync): Limits {
  const version = db.prepare('PRAGMA user_version').get()?.user_version;
  if (version !== 2) throw Error('Web Risk budget needs explicit migration or repair.');
  const row = db
    .prepare(
      'SELECT profile,minuteCap,dayCap,monthCap,concurrency,lastClock,blockedUntil FROM meter WHERE id=1',
    )
    .get() as Limits | undefined;
  if (
    !row ||
    row.concurrency !== 2 ||
    !Number.isSafeInteger(row.lastClock) ||
    row.lastClock < 0 ||
    !Number.isSafeInteger(row.blockedUntil) ||
    row.blockedUntil < 0 ||
    !(
      (row.profile === 'preflight' &&
        Number.isSafeInteger(row.dayCap) &&
        row.dayCap >= 1 &&
        row.dayCap <= 20 &&
        row.minuteCap === Math.min(row.dayCap, 20) &&
        row.monthCap === row.dayCap * 31) ||
      (row.profile === 'automatic' &&
        row.minuteCap === 20 &&
        row.dayCap === 250 &&
        row.monthCap === 5000)
    )
  )
    throw Error('Invalid Web Risk budget configuration.');
  return row;
}
function insertProfile(db: DatabaseSync, daily: number, backoff: number, now: number) {
  db.prepare('INSERT INTO meter VALUES(1,?,?,?,?,?,?,?)').run(
    'preflight',
    Math.min(daily, 20),
    daily,
    daily * 31,
    2,
    now,
    backoff,
  );
}
export function initializeWebRiskBudget(directory = webRiskDirectory, daily = 12) {
  if (!Number.isSafeInteger(daily) || daily < 1 || daily > 20)
    throw Error('Choose a daily Web Risk limit from 1 to 20.');
  mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, 'limits.sqlite'), '', { flag: 'wx', mode: 0o600 });
  withDB(directory, (db) =>
    transaction(db, () => {
      db.exec(ddl);
      insertProfile(db, daily, 0, 0);
    }),
  );
}
// Run only by explicit owner command. No path in the running API selects a new profile.
export function migrateWebRiskBudget(
  directory = webRiskDirectory,
  automatic = false,
  now = Date.now(),
) {
  return withDB(directory, (db) =>
    transaction(db, () => {
      if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok')
        throw Error('Damaged Web Risk journal.');
      const version = db.prepare('PRAGMA user_version').get()?.user_version;
      if (version === 0) {
        const old = db.prepare('SELECT cap,day,used,blockedUntil FROM limits WHERE id=1').get() as
          { cap: number; day: number; used: number; blockedUntil: number } | undefined;
        if (
          !old ||
          !Number.isSafeInteger(old.cap) ||
          old.cap < 1 ||
          old.cap > 20 ||
          !Number.isSafeInteger(old.used) ||
          old.used < 0 ||
          old.used > old.cap ||
          !Number.isSafeInteger(old.day) ||
          old.day < 0 ||
          old.day > Math.floor(now / dayMs) ||
          !Number.isSafeInteger(old.blockedUntil) ||
          old.blockedUntil < 0
        )
          throw Error('Invalid or future legacy budget.');
        // Retire old writers rather than permit use of two journals.
        db.exec('ALTER TABLE limits RENAME TO legacy_limits;' + ddl);
        insertProfile(db, old.cap, old.blockedUntil, now);
        if (old.used) {
          const oldTime = old.day * dayMs;
          const add = db.prepare(
            'INSERT INTO admissions(at,day,month,units,kind,lease) VALUES(?,?,?,?,?,0)',
          );
          add.run(
            old.day === Math.floor(now / dayMs) ? now : oldTime,
            old.day,
            monthOf(oldTime),
            old.used,
            'legacy-observed',
          );
          // Version 1 retained only the last UTC day. Reserve the maximum possible
          // usage on earlier days of that month instead of assuming it was zero.
          const prior = (new Date(oldTime).getUTCDate() - 1) * old.cap;
          if (prior)
            add.run(oldTime - 1, old.day - 1, monthOf(oldTime), prior, 'legacy-month-upper-bound');
        }
      }
      const l = limits(db);
      if (now < l.lastClock) throw Error('Web Risk journal clock moved backwards.');
      if (automatic && l.profile !== 'automatic')
        db.prepare(
          'UPDATE meter SET profile=?,minuteCap=20,dayCap=250,monthCap=5000,concurrency=2,lastClock=? WHERE id=1',
        ).run('automatic', now);
      return limits(db);
    }),
  );
}
export function webRiskLimits(directory: string) {
  return withDB(directory, limits);
}
export function reserveWebRisk(directory: string, now: number, leaseMs: number): number | null {
  return withDB(directory, (db) =>
    transaction(db, () => {
      const l = limits(db);
      if (now < l.lastClock || now < l.blockedUntil) return null;
      db.prepare('UPDATE meter SET lastClock=? WHERE id=1').run(now);
      const day = Math.floor(now / dayMs),
        month = monthOf(now);
      const n = db
        .prepare(
          `SELECT
      (SELECT coalesce(sum(units),0) FROM admissions WHERE at>?) AS recent,
      (SELECT coalesce(sum(units),0) FROM admissions WHERE day=?) AS daily,
      (SELECT coalesce(sum(units),0) FROM admissions WHERE month=?) AS monthly,
      (SELECT count(*) FROM admissions WHERE lease>?) AS active`,
        )
        .get(now - 60000, day, month, now)!;
      if (
        Number(n.recent) >= l.minuteCap ||
        Number(n.daily) >= l.dayCap ||
        Number(n.monthly) >= l.monthCap ||
        Number(n.active) >= l.concurrency
      )
        return null;
      return Number(
        db
          .prepare('INSERT INTO admissions(at,day,month,units,kind,lease) VALUES(?,?,?,1,?,?)')
          .run(now, day, month, 'lookup', now + leaseMs).lastInsertRowid,
      );
    }),
  );
}
export function finishWebRisk(directory: string, id: number) {
  withDB(directory, (db) => {
    db.prepare('UPDATE admissions SET lease=0 WHERE id=?').run(id);
  });
}
export function blockWebRisk(directory: string, until: number) {
  withDB(directory, (db) => {
    db.prepare('UPDATE meter SET blockedUntil=max(blockedUntil,?) WHERE id=1').run(until);
  });
}
export function readWebRiskMatch(directory: string, subject: string, now: number) {
  return withDB(directory, (db) => {
    const l = limits(db);
    if (now < l.lastClock) return undefined;
    db.prepare('DELETE FROM positives WHERE expires<=?').run(now);
    return db
      .prepare(
        'SELECT checked,expires,categories FROM positives WHERE subject=? AND expires>? AND checked<=?',
      )
      .get(subject, now, now) as
      { checked: number; expires: number; categories: string } | undefined;
  });
}
export function storeWebRiskMatch(
  directory: string,
  subject: string,
  checked: number,
  expires: number,
  categories: string[],
) {
  withDB(directory, (db) => {
    db.prepare('INSERT OR REPLACE INTO positives VALUES(?,?,?,?)').run(
      subject,
      checked,
      expires,
      JSON.stringify(categories),
    );
  });
}
