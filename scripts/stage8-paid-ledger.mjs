// Preload for the explicit, model-enabled Stage 8 verification session only.
// Local app builds and the keyless server do not import this module.
import { randomUUID, createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  fsyncSync,
  writeFileSync,
  closeSync,
  readFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const model = 'gemini-3.5-flash-lite';
const endpoint =
  'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
const merchantEndpoint = 'https://data.wa.gov/resource/fvrz-yz45.json';
const directory = fileURLToPath(new URL('../.test-artifacts/stage8-paid-budget/', import.meta.url));
const halfMicroPerDollar = 2_000_000,
  budget = 4 * halfMicroPerDollar,
  floor = 200_000,
  tokenRate = 5;
const sessionMs = 30 * 60000,
  requestLimit = 96 * 1024,
  responseLimit = 512 * 1024;
const supportedSDK = '3.0.0';
const version = 1;
function requireCondition(ok, message) {
  if (!ok) throw Error(message);
}
const readJSON = (p) => JSON.parse(readFileSync(p, 'utf8'));

// An explicit, durable marker distinguishes uninitialized funding from loss of
// an existing journal. The production preload never creates either file.
function regular(file) {
  return existsSync(file) && lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink();
}
const schema = `
 CREATE TABLE configuration (id TEXT PRIMARY KEY, format INTEGER NOT NULL, model TEXT NOT NULL,
   budget INTEGER NOT NULL, rate INTEGER NOT NULL, floor INTEGER NOT NULL) STRICT;
 CREATE TABLE sessions (id INTEGER PRIMARY KEY, opened INTEGER NOT NULL, expires INTEGER NOT NULL) STRICT;
 CREATE TABLE attempts (id INTEGER PRIMARY KEY, session INTEGER NOT NULL REFERENCES sessions(id),
   at INTEGER NOT NULL, model TEXT NOT NULL, operation TEXT NOT NULL, reserved INTEGER NOT NULL,
   state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','unknown','settled','overbound')),
   ended INTEGER, http INTEGER, total INTEGER, prompt INTEGER, output INTEGER, thoughts INTEGER, charged INTEGER,
   category TEXT NOT NULL DEFAULT 'pending') STRICT;
 CREATE INDEX attempt_window ON attempts(at);
`;
export class PaidLedger {
  constructor(dir, initialize = false, callerRole = 'owner') {
    requireCondition(callerRole === 'owner' || callerRole === 'builder', 'Unknown Gemini caller role.');
    Object.defineProperties(this, {
      callerRole: { value: callerRole },
      sessionLimit: { value: callerRole === 'builder' ? 22 : 30 },
    });
    if (initialize) mkdirSync(dir, { recursive: true, mode: 0o700 });
    requireCondition(
      existsSync(dir) && lstatSync(dir).isDirectory() && !lstatSync(dir).isSymbolicLink(),
      'Paid ledger directory unavailable.',
    );
    const marker = path.join(dir, 'authorization.json'),
      db = path.join(dir, 'ledger.sqlite');
    let fresh = false;
    if (initialize && !existsSync(marker) && !existsSync(db)) {
      const fd = openSync(marker, 'wx', 0o600);
      try {
        writeFileSync(
          fd,
          JSON.stringify({ id: randomUUID(), format: version, model, budget, floor, tokenRate }) +
            '\n',
        );
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      fresh = true;
    }
    requireCondition(
      regular(marker) && (fresh || regular(db)),
      'Paid authorization or existing journal missing; generation disabled.',
    );
    const m = readJSON(marker);
    requireCondition(
      typeof m.id === 'string' &&
        /^[\da-f-]{36}$/i.test(m.id) &&
        m.model === model &&
        m.budget === budget &&
        m.floor === floor &&
        m.tokenRate === tokenRate &&
        m.format === version,
      'Paid authorization does not match policy.',
    );
    this.db = new DatabaseSync(db);
    try {
      this.db.exec(
        'PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;',
      );
      if (fresh)
        this.transaction(() => {
          this.db.exec(schema);
          this.db
            .prepare('INSERT INTO configuration VALUES (?,?,?,?,?,?)')
            .run(m.id, version, model, budget, tokenRate, floor);
          const now = Date.now();
          this.db
            .prepare('INSERT INTO sessions(opened,expires) VALUES (?,?)')
            .run(now, now + sessionMs);
        });
      const c = this.db.prepare('SELECT * FROM configuration').get();
      requireCondition(
        c?.id === m.id &&
          c.format === version &&
          c.model === model &&
          c.budget === budget &&
          c.rate === tokenRate &&
          c.floor === floor,
        'Paid journal identity or policy mismatch.',
      );
      // Upgrade an already-active journal in place. Older servers may still
      // settle a receipt using the original column list during this transition.
      this.transaction(() => {
        this.db.exec(`CREATE TABLE IF NOT EXISTS bounded_sessions (
          session INTEGER PRIMARY KEY REFERENCES sessions(id), grant_id TEXT UNIQUE NOT NULL,
          max_calls INTEGER NOT NULL, max_exposure INTEGER NOT NULL) STRICT;
          CREATE TRIGGER IF NOT EXISTS enforce_bounded_session BEFORE INSERT ON attempts
          WHEN EXISTS (SELECT 1 FROM bounded_sessions b JOIN sessions s ON s.id=b.session
            WHERE b.session=NEW.session AND (NEW.at<s.opened OR NEW.at>=s.expires OR
              NEW.operation NOT IN ('assist_intent','assist_step') OR
              (SELECT count(*) FROM attempts WHERE session=b.session)>=b.max_calls OR
              NEW.reserved+(SELECT coalesce(sum(coalesce(charged,reserved)),0) FROM attempts WHERE session=b.session)>b.max_exposure))
          BEGIN SELECT RAISE(ABORT,'Bounded WinSCP session allowance unavailable'); END;`);
        if (
          !this.db
            .prepare('PRAGMA table_info(attempts)')
            .all()
            .some((c) => c.name === 'category')
        )
          this.db.exec(
            "ALTER TABLE attempts ADD COLUMN category TEXT NOT NULL DEFAULT 'prior_receipt'",
          );
      });
      const session = this.db.prepare('SELECT id FROM sessions ORDER BY id DESC LIMIT 1').get();
      requireCondition(session, 'Paid session missing.');
      this.session = session.id;
    } catch (e) {
      this.close();
      throw e;
    }
  }
  close() {
    this.db.close();
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  newSession() {
    return this.transaction(() => {
      const now = Date.now(),
        last = this.db.prepare('SELECT expires FROM sessions ORDER BY id DESC LIMIT 1').get();
      requireCondition(last.expires <= now, 'Current paid session has not expired.');
      this.session = Number(
        this.db
          .prepare('INSERT INTO sessions(opened,expires) VALUES (?,?)')
          .run(now, now + sessionMs).lastInsertRowid,
      );
      return this.session;
    });
  }
  newWinSCPSession() {
    return this.transaction(() => {
      const now = Date.now(), expires = Date.parse('2026-11-08T14:10:00Z');
      const last = this.db.prepare('SELECT expires FROM sessions ORDER BY id DESC LIMIT 1').get();
      const exposure = this.db.prepare('SELECT coalesce(sum(coalesce(charged,reserved)),0) AS used FROM attempts').get().used;
      requireCondition(now >= Date.parse('2026-11-08T13:40:11Z') && now < expires && last.expires <= now &&
        exposure + floor <= budget, 'The approved WinSCP window or remaining funds are unavailable.');
      const id = Number(this.db.prepare('INSERT INTO sessions(opened,expires) VALUES (?,?)').run(now,expires).lastInsertRowid);
      this.db.prepare('INSERT INTO bounded_sessions VALUES (?,?,?,?)').run(id,'winscp-text-test-1',8,200000);
      this.session = id;
      return id;
    });
  }
  bounded() {
    return this.db.prepare('SELECT grant_id FROM bounded_sessions WHERE session=?').get(this.session);
  }
  reserve(operation, amount) {
    requireCondition(
      Number.isSafeInteger(amount) && amount >= floor && amount <= budget,
      'Invalid paid reservation.',
    );
    return this.transaction(() => {
      const now = Date.now();
      const last = this.db
        .prepare('SELECT id,opened,expires FROM sessions ORDER BY id DESC LIMIT 1')
        .get();
      requireCondition(
        last.id === this.session && last.opened <= now && now < last.expires,
        'Paid session expired or replaced.',
      );
      const totals = this.db
        .prepare(
          `SELECT COALESCE(SUM(COALESCE(charged,reserved)),0) AS used,
        COALESCE(SUM(CASE WHEN state='overbound' THEN 1 ELSE 0 END),0) AS exceeded,
        COALESCE(SUM(CASE WHEN at>? THEN 1 ELSE 0 END),0) AS recent,
        COALESCE(SUM(CASE WHEN session=? THEN 1 ELSE 0 END),0) AS calls,
        COALESCE(MAX(at),0) AS previous FROM attempts`,
        )
        .get(now - 60000, this.session);
      requireCondition(
        !totals.exceeded && totals.used + amount <= budget,
        'Paid verification budget exhausted.',
      );
      requireCondition(
        totals.previous <= now && totals.recent < 6 && totals.calls < this.sessionLimit,
        'Paid verification session or minute limit reached.',
      );
      return Number(
        this.db
          .prepare('INSERT INTO attempts(session,at,model,operation,reserved) VALUES(?,?,?,?,?)')
          .run(this.session, now, model, operation, amount).lastInsertRowid,
      );
    });
  }
  finish(id, http, tokens = null, category = 'usage_missing') {
    this.transaction(() => {
      const attempt = this.db.prepare('SELECT reserved,state FROM attempts WHERE id=?').get(id);
      requireCondition(
        attempt?.state === 'pending',
        'Invalid settlement or duplicate paid receipt.',
      );
      const cost = tokens ? tokens.total * tokenRate : null;
      const state = cost === null ? 'unknown' : cost > attempt.reserved ? 'overbound' : 'settled';
      this.db
        .prepare(
          'UPDATE attempts SET state=?,ended=?,http=?,total=?,prompt=?,output=?,thoughts=?,charged=?,category=? WHERE id=?',
        )
        .run(
          state,
          Date.now(),
          http,
          tokens?.total ?? null,
          tokens?.prompt ?? null,
          tokens?.output ?? null,
          tokens?.thoughts ?? null,
          cost,
          state === 'overbound'
            ? 'above_reserved_bound'
            : state === 'settled'
              ? 'settled'
              : category,
          id,
        );
    });
  }
  status() {
    const rows = this.db
      .prepare(
        `SELECT state,COUNT(*) AS count,SUM(COALESCE(charged,reserved)) AS exposure
      FROM attempts GROUP BY state`,
      )
      .all();
    const exposure = rows.reduce((sum, r) => sum + r.exposure, 0);
    return {
      format: version,
      model,
      capUSD: 4,
      callerRole: this.callerRole,
      effectiveSessionLimit: this.sessionLimit,
      exposureUSD: exposure / halfMicroPerDollar,
      remainingUSD: Math.max(0, budget - exposure) / halfMicroPerDollar,
      session: this.session,
      states: rows.map((r) => ({
        state: r.state,
        attempts: r.count,
        USD: r.exposure / halfMicroPerDollar,
      })),
      sessions: this.db
        .prepare(
          `SELECT s.id,s.opened,s.expires,COUNT(a.id) AS attempts FROM sessions s
        LEFT JOIN attempts a ON a.session=s.id GROUP BY s.id ORDER BY s.id`,
        )
        .all(),
    };
  }
  report() {
    return {
      ...this.status(),
      attempts: this.db
        .prepare(
          'SELECT id,session,at,ended,model,operation,state,http,category,total,prompt,output,thoughts,reserved,charged FROM attempts ORDER BY id',
        )
        .all(),
    };
  }
}

function record(o) {
  return o !== null && typeof o === 'object' && !Array.isArray(o);
}
function only(o, names) {
  return record(o) && Object.keys(o).every((k) => names.includes(k));
}
function textContent(c) {
  return (
    only(c, ['role', 'parts']) &&
    (!c.role || c.role === 'user') &&
    Array.isArray(c.parts) &&
    c.parts.length === 1 &&
    only(c.parts[0], ['text']) &&
    typeof c.parts[0].text === 'string'
  );
}
function operation(c) {
  const body = JSON.parse(c.parts[0].text);
  if (!record(body)) return null;
  if (body.operation === 'classify_cleanup' && only(body,['operation','candidates']) &&
      Array.isArray(body.candidates) && body.candidates.length > 0 && body.candidates.length <= 30 &&
      body.candidates.every(row => only(row,['id','reason','signal']) &&
        typeof row.id === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(row.id) &&
        ['advertisement','promotion','promo_pair'].includes(row.reason) &&
        ['labelled_advertisement','labelled_sponsored','labelled_promotion','recognized_banner','recognized_popup_pair'].includes(row.signal)) &&
      new Set(body.candidates.map(row=>row.id)).size === body.candidates.length) return 'cleanup_classify';
  if (
    typeof body.request === 'string' &&
    Array.isArray(body.available) &&
    Array.isArray(body.recent)
  )
    return 'chat_route';
  if (Array.isArray(body.sourceWords) && typeof body.goal === 'string') return 'assist_intent';
  if (Array.isArray(body.eligible) && record(body.page) && record(body.intent))
    return 'assist_step';
  if (record(body.confirmed) && Array.isArray(body.explicitRequirements)) return 'compare_intent';
  if (Array.isArray(body.facts)) return 'compare_explain';
  if (['seller', 'product'].includes(body.subject) && Array.isArray(body.evidence))
    return body.subject + '_explain';
  if (record(body.check) && ['website', 'download'].includes(body.check.kind))
    return body.check.kind + '_explain';
  return null;
}
function requestCost(text) {
  const bytes = Buffer.byteLength(text);
  requireCondition(bytes > 0 && bytes <= requestLimit, 'Unsupported paid request size.');
  let b, op;
  try {
    b = JSON.parse(text);
    requireCondition(
      only(b, ['contents', 'systemInstruction', 'generationConfig']) &&
        Array.isArray(b.contents) &&
        b.contents.length === 1 &&
        textContent(b.contents[0]) &&
        textContent(b.systemInstruction),
      'Unsupported generation payload.',
    );
    const g = b.generationConfig;
    requireCondition(
      only(g, ['maxOutputTokens', 'responseMimeType', 'responseJsonSchema', 'thinkingConfig']) &&
        g.responseMimeType === 'application/json' &&
        record(g.responseJsonSchema) &&
        (!('thinkingConfig' in g) ||
          (only(g.thinkingConfig, ['thinkingLevel']) &&
            g.thinkingConfig.thinkingLevel === 'LOW')) &&
        Number.isInteger(g.maxOutputTokens) &&
        g.maxOutputTokens > 0 &&
        g.maxOutputTokens <= 1000,
      'Unsupported model/tool/output configuration.',
    );
    op = operation(b.contents[0]);
    requireCondition(op, 'Unrecognized SafeStep generation.');
  } catch {
    throw Error('Unsupported paid request or generation options.');
  }
  // Text-only, one candidate, no cache/tools/media. Conservatively allow one
  // token per serialized UTF-8 byte plus framing headroom. maxOutputTokens
  // bounds the combined thoughts + visible output; preserve the SDK payload.
  return {
    operation: op,
    amount: Math.max(floor, (bytes + 8192 + b.generationConfig.maxOutputTokens) * tokenRate),
  };
}
function usage(body) {
  const m = body?.usageMetadata;
  if (
    !record(m) ||
    !Number.isSafeInteger(m.totalTokenCount) ||
    m.totalTokenCount < 1 ||
    m.totalTokenCount > 1_000_000_000
  )
    return null;
  const t = {
    total: m.totalTokenCount,
    prompt: m.promptTokenCount ?? null,
    output: m.candidatesTokenCount ?? null,
    thoughts: m.thoughtsTokenCount ?? null,
  };
  if (
    [t.prompt, t.output, t.thoughts, m.cachedContentTokenCount ?? null].some(
      (n) => n !== null && (!Number.isSafeInteger(n) || n < 0 || n > t.total),
    ) ||
    (t.prompt ?? 0) + (t.output ?? 0) + (t.thoughts ?? 0) > t.total ||
    !record(body) ||
    body.error
  )
    return null;
  return t;
}
async function readBounded(stream, limit) {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader(),
    chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => {});
        throw Error('Paid HTTP message exceeds its bound.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}
export function budgetedFetch(ledger, transport, pinnedGeminiKey) {
  return async (input, options) => {
    const request = new Request(input, options),
      url = new URL(request.url);
    if (request.url !== endpoint) {
      const local =
        url.protocol === 'http:' &&
        (/^127\.0\.0\.[1-9]$/.test(url.hostname) ||
          url.hostname === 'localhost' ||
          url.hostname === '[::1]');
      const merchant =
        url.origin + url.pathname === merchantEndpoint &&
        request.method === 'GET' &&
        !request.headers.has('authorization');
      requireCondition(
        !url.username &&
          !url.password &&
          (local || merchant) &&
          !request.headers.has('x-goog-api-key'),
        'External destination not approved by the paid ledger.',
      );
      return transport(request, { redirect: 'error' });
    }
    requireCondition(
      request.method === 'POST' &&
        (!pinnedGeminiKey || request.headers.get('x-goog-api-key') === pinnedGeminiKey) &&
        !request.headers.has('authorization') && !request.headers.has('cookie') &&
        request.headers.get('content-type')?.split(';')[0].trim() === 'application/json',
      'Unsupported paid HTTP method or media type.',
    );
    const body = await readBounded(request.body, requestLimit);
    const a = requestCost(new TextDecoder('utf-8', { fatal: true }).decode(body));
    if (ledger.bounded?.()) {
      const message = JSON.parse(JSON.parse(new TextDecoder().decode(body)).contents[0].parts[0].text);
      requireCondition(['assist_intent','assist_step'].includes(a.operation) &&
        JSON.stringify(message).toLowerCase().includes('winscp'), 'Only the approved WinSCP navigation operation is eligible.');
    }
    request.signal.throwIfAborted();
    const id = ledger.reserve(a.operation, a.amount);
    let response, bytes;
    try {
      response = await transport(request.url, {
        method: 'POST',
        headers: request.headers,
        body,
        signal: request.signal,
        redirect: 'error',
        credentials: 'omit',
      });
      bytes = await readBounded(response.body, responseLimit);
    } catch {
      ledger.finish(
        id,
        response?.status ?? null,
        null,
        request.signal.aborted ? 'aborted' : response ? 'interrupted_response' : 'transport_error',
      );
      throw Error('Paid generation ended without a verifiable usage receipt.');
    }
    let counts = null,
      category = 'invalid_or_missing_usage';
    const isJSON =
      response.headers.get('content-type')?.split(';')[0].trim() === 'application/json';
    let json;
    if (isJSON)
      try {
        json = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        /* Keep the full reservation. */
      }
    if (response.ok && isJSON) counts = usage(json);
    if (!response.ok) {
      const allowed = [
        'RESOURCE_EXHAUSTED',
        'PERMISSION_DENIED',
        'UNAVAILABLE',
        'INVALID_ARGUMENT',
        'DEADLINE_EXCEEDED',
        'INTERNAL',
        'NOT_FOUND',
        'UNAUTHENTICATED',
        'FAILED_PRECONDITION',
        'CANCELLED',
      ];
      category = allowed.includes(json?.error?.status) ? json.error.status : 'upstream_http_error';
    } else if (!isJSON) category = 'unsupported_response_format';
    ledger.finish(id, response.status, counts, category);
    requireCondition(!response.ok || isJSON, 'Unsupported paid response format.');
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    return new Response([204, 205, 304].includes(response.status) ? null : bytes, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}
const self = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  const command = process.argv[2];
  requireCondition(
    ['init', 'status', 'report', 'new-session', 'winscp-session'].includes(command),
    'Use init, status, report or new-session.',
  );
  const ledger = new PaidLedger(directory, command === 'init');
  try {
    if (command === 'new-session') ledger.newSession();
    if (command === 'winscp-session') ledger.newWinSCPSession();
    console.log(JSON.stringify(command === 'report' ? ledger.report() : ledger.status(), null, 2));
  } finally {
    ledger.close();
  }
} else if (
  process.execArgv.some((arg, i) => {
    const name =
      arg === '--import'
        ? process.execArgv[i + 1]
        : arg.startsWith('--import=')
          ? arg.slice(9)
          : undefined;
    return name && (name === pathToFileURL(self).href || path.resolve(name) === self);
  })
) {
  const require = createRequire(import.meta.url);
  const sdkDir = path.dirname(require.resolve('@google/genai'));
  const sdk = readJSON(path.resolve(sdkDir, '../../package.json'));
  requireCondition(sdk.version === supportedSDK, 'Unaudited Google SDK; paid transport disabled.');
  const audited = 'd14e704f6595c05aa0b23e85d2ac5cf9bbf06b2c998eaa6ea2165df54facda07';
  requireCondition(
    createHash('sha256')
      .update(readFileSync(path.join(sdkDir, 'index.mjs')))
      .digest('hex') === audited,
    'Unaudited Google SDK implementation; paid transport disabled.',
  );
  requireCondition(process.env.GEMINI_MODEL === model, 'Unapproved model for the paid session.');
  requireCondition(process.env.GEMINI_API_KEY?.trim(), 'A server-side Gemini credential is required.');
  const ledger = new PaidLedger(directory, false, process.env.SAFESTEP_GEMINI_CALLER_ROLE ?? 'owner');
  const nativeTransport=globalThis.fetch.bind(globalThis);
  // Raw fetch still rejects Web Risk. A separate, single-use source admission
  // inside the compiled connector can use this transport for uris.search only.
  const {installGuardedWebRiskTransport}=await import('../apps/api/dist/web-risk.js');
  installGuardedWebRiskTransport(nativeTransport,process.env);
  Object.defineProperty(globalThis, 'fetch', {
    value: budgetedFetch(ledger,nativeTransport,process.env.GEMINI_API_KEY.trim()),
    writable: false,
    configurable: false,
  });
  process.on('exit', () => ledger.close());
}
