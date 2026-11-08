import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  THREAT_POLICY_VERSION,
  ThreatReply,
  ThreatRequest,
  threatCategories,
  type Health,
} from '@safestep/contracts';
import {
  webRiskDirectory,
  reserveWebRisk,
  finishWebRisk,
  blockWebRisk,
  webRiskLimits,
  readWebRiskMatch,
  storeWebRiskMatch,
} from './web-risk-budget.js';
export {
  initializeWebRiskBudget,
  migrateWebRiskBudget,
  webRiskDirectory,
} from './web-risk-budget.js';

const endpoint = 'https://webrisk.googleapis.com/v1/uris:search';
const categories = threatCategories;
type Admission = { directory: string; key: string; url: string; id: number };
const pendingAdmissions = new WeakSet<Admission>();
let combined:
  { transport: typeof fetch; directory: string; key: string; authorized: boolean } | undefined;
export const guardedRuntimeActive = () => !!combined;
// The preload installs this private capability before sealing global fetch.
// There is no raw Web Risk exception in global fetch, and this module exports
// neither the captured transport nor a method for sending arbitrary requests.
export function installGuardedWebRiskTransport(
  transport: typeof fetch,
  env: NodeJS.ProcessEnv,
  directory = webRiskDirectory,
) {
  if (combined) throw Error('Protected Web Risk transport already installed.');
  const key = env.WEB_RISK_API_KEY?.trim() ?? '';
  combined = Object.freeze({
    transport,
    directory,
    key,
    authorized:
      env.SAFESTEP_WEB_RISK_AUTHORIZED === 'true' && !!key && key !== env.GEMINI_API_KEY?.trim(),
  });
}
async function dispatchLookup(
  admission: Admission,
  transport: typeof fetch,
  url: URL,
  options: RequestInit,
) {
  if (!pendingAdmissions.delete(admission))
    throw Error('A reserved Web Risk admission is required.');
  const headers = new Headers(options.headers);
  if (
    url.origin + url.pathname !== endpoint ||
    url.username ||
    url.password ||
    url.hash ||
    JSON.stringify([...url.searchParams.keys()]) !==
      JSON.stringify(['uri', ...categories.map(() => 'threatTypes')]) ||
    url.searchParams.get('uri') !== admission.url ||
    JSON.stringify(url.searchParams.getAll('threatTypes')) !== JSON.stringify(categories) ||
    options.method !== 'GET' ||
    options.body ||
    options.redirect !== 'error' ||
    options.credentials !== 'omit' ||
    options.cache !== 'no-store' ||
    JSON.stringify([...headers.keys()].sort()) !== JSON.stringify(['accept', 'x-goog-api-key']) ||
    headers.get('accept') !== 'application/json' ||
    headers.get('x-goog-api-key') !== admission.key
  )
    throw Error('Unapproved Web Risk dispatch.');
  if (combined) {
    if (
      !combined.authorized ||
      combined.directory !== admission.directory ||
      combined.key !== admission.key
    )
      throw Error('Web Risk operator authorization mismatch.');
    transport = combined.transport;
  }
  return transport(url, options);
}
const providerResponse = z.union([
  z.strictObject({}),
  z.strictObject({
    threat: z.strictObject({
      threatTypes: z
        .array(z.enum(categories))
        .min(1)
        .max(categories.length)
        .refine((items) => new Set(items).size === items.length),
      expireTime: z.iso.datetime(),
    }),
  }),
]);
async function readSource(response: Response) {
  if (
    response.status !== 200 ||
    !response.body ||
    !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') ||
    Number(response.headers.get('content-length')) > 8192
  )
    throw Error('Source response unavailable.');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > 8192) throw Error('Source response too large.');
      chunks.push(Buffer.from(item.value));
    }
    return providerResponse.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function backoff(raw: string | null, now: number) {
  const until = raw && /^\d{1,9}$/.test(raw) ? now + Number(raw) * 1000 : Date.parse(raw ?? '');
  return Math.max(now + 60000, Number.isFinite(until) ? until : 0);
}

type Work = { controller: AbortController; readers: number; promise: Promise<ThreatReply> };
export class WebRiskService {
  private active = new Map<string, Work>();
  private running = 0;
  private readonly queue: { priority: boolean; start: () => void }[] = [];
  private lastVerifiedAt: string | null = null;
  private readonly key: string;
  private readonly enabled: boolean;
  constructor(
    env: NodeJS.ProcessEnv = {},
    private directory = webRiskDirectory,
    private transport: typeof fetch = fetch,
    private clock = Date.now,
    private deadline = 3500,
  ) {
    this.key = env.WEB_RISK_API_KEY?.trim() ?? '';
    this.enabled =
      env.SAFESTEP_WEB_RISK_AUTHORIZED === 'true' && this.key !== env.GEMINI_API_KEY?.trim();
  }
  diagnostics() {
    let limits: null | ReturnType<typeof webRiskLimits> = null;
    if (this.enabled && this.key)
      try {
        limits = webRiskLimits(this.directory);
      } catch {
        /* missing or damaged */
      }
    return {
      source: 'Google Web Risk Lookup',
      policyVersion: THREAT_POLICY_VERSION,
      keyPresent: !!this.key,
      operatorAuthorized: this.enabled,
      configured: !!limits,
      profile: limits?.profile ?? null,
      minuteCap: limits?.minuteCap ?? null,
      dayCap: limits?.dayCap ?? null,
      monthCap: limits?.monthCap ?? null,
      concurrency: limits?.concurrency ?? null,
      verifiedUpstreamAt: this.lastVerifiedAt,
    };
  }
  readiness(): Health['providers'][number] {
    const ready = this.diagnostics().configured;
    return {
      provider: 'url_threat',
      credentialPresent: !!this.key,
      status: !this.key ? 'not_configured' : ready ? 'ready' : 'connector_unavailable',
    };
  }
  private receipt(
    input: ThreatRequest,
    status: ThreatReply['status'],
    reason: ThreatReply['reason'],
  ): ThreatReply {
    return {
      ...input,
      source: 'Google Web Risk Lookup',
      status,
      reason,
      categories: [],
      checkedAt: new Date(this.clock()).toISOString(),
      expiresAt: null,
    };
  }
  async check(raw: ThreatRequest, client: AbortSignal): Promise<ThreatReply> {
    const input = ThreatRequest.parse(raw);
    client.throwIfAborted();
    if (!this.key) return this.receipt(input, 'unavailable', 'not_configured');
    if (!this.enabled) return this.receipt(input, 'unavailable', 'disabled');
    if (
      combined &&
      (!combined.authorized || combined.key !== this.key || combined.directory !== this.directory)
    )
      return this.receipt(input, 'unavailable', 'disabled');
    const key = createHash('sha256')
      .update([THREAT_POLICY_VERSION, ...categories, this.key, input.url].join('\0'))
      .digest('hex');
    try {
      const now = this.clock(),
        cached = readWebRiskMatch(this.directory, key, now);
      if (cached)
        return ThreatReply.parse({
          ...this.receipt(input, 'match', null),
          checkedAt: new Date(cached.checked).toISOString(),
          expiresAt: new Date(cached.expires).toISOString(),
          categories: JSON.parse(cached.categories),
        });
    } catch {
      return this.receipt(input, 'unavailable', 'source');
    }
    let work = this.active.get(key);
    if (!work || work.controller.signal.aborted) {
      const controller = new AbortController();
      const promise = this.schedule(input, controller.signal);
      work = { controller, promise, readers: 0 };
      this.active.set(key, work);
      const finished = () => {
        if (this.active.get(key)?.promise === promise) this.active.delete(key);
      };
      void promise.then(finished, finished);
    }
    const current = work;
    current.readers++;
    let aborted!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      aborted = () => reject(client.reason);
    });
    client.addEventListener('abort', aborted, { once: true });
    try {
      client.throwIfAborted();
      const result = await Promise.race([current.promise, cancelled]);
      if (result.status === 'match') {
        if (!result.expiresAt || Date.parse(result.expiresAt) <= this.clock())
          return this.receipt(input, 'unavailable', 'source');
        try {
          storeWebRiskMatch(
            this.directory,
            key,
            Date.parse(result.checkedAt),
            Date.parse(result.expiresAt),
            result.categories,
          );
        } catch {
          return this.receipt(input, 'unavailable', 'source');
        }
      }
      const { purpose: _purpose, ...sourceFacts } = result;
      return { ...sourceFacts, ...input };
    } finally {
      client.removeEventListener('abort', aborted);
      if (--current.readers === 0 && client.aborted) current.controller.abort();
    }
  }
  private schedule(input: ThreatRequest, client: AbortSignal): Promise<ThreatReply> {
    if (this.queue.length >= 16)
      return Promise.resolve(this.receipt(input, 'rate_limited', 'quota'));
    const signal = AbortSignal.any([client, AbortSignal.timeout(this.deadline)]);
    return new Promise((resolve) => {
      const entry = {
        priority: input.purpose === 'target',
        start: () => {
          signal.removeEventListener('abort', cancel);
          if (signal.aborted) {
            resolve(this.receipt(input, 'unavailable', 'timeout'));
            return;
          }
          this.running++;
          void this.collect(input, signal)
            .then(resolve, () => resolve(this.receipt(input, 'unavailable', 'source')))
            .finally(() => {
              this.running--;
              this.queue.shift()?.start();
            });
        },
      };
      const cancel = () => {
        const i = this.queue.indexOf(entry);
        if (i >= 0) this.queue.splice(i, 1);
        resolve(this.receipt(input, 'unavailable', 'timeout'));
      };
      if (this.running < 2) entry.start();
      else {
        const i = entry.priority ? this.queue.findIndex((w) => !w.priority) : -1;
        if (i < 0) this.queue.push(entry);
        else this.queue.splice(i, 0, entry);
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
      }
    });
  }
  private async collect(input: ThreatRequest, client: AbortSignal): Promise<ThreatReply> {
    const timeout = AbortSignal.timeout(this.deadline);
    const signal = AbortSignal.any([client, timeout]);
    const fallback = () =>
      this.receipt(
        input,
        'unavailable',
        timeout.aborted || client.reason?.name === 'TimeoutError' ? 'timeout' : 'source',
      );
    let onAbort!: () => void;
    const stopped = new Promise<ThreatReply>((resolve) => {
      onAbort = () => resolve(fallback());
    });
    signal.addEventListener('abort', onAbort, { once: true });
    let admitted: number | null = null;
    try {
      signal.throwIfAborted();
      admitted = reserveWebRisk(this.directory, this.clock(), this.deadline + 1000);
      if (admitted === null) return this.receipt(input, 'rate_limited', 'quota');
      const admission = { directory: this.directory, key: this.key, url: input.url, id: admitted };
      pendingAdmissions.add(admission);
      return await Promise.race([this.lookup(input, signal, admission), stopped]);
    } catch {
      return fallback();
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (admitted !== null) finishWebRisk(this.directory, admitted);
    }
  }
  private async lookup(
    input: ThreatRequest,
    signal: AbortSignal,
    admission: Admission,
  ): Promise<ThreatReply> {
    const url = new URL(endpoint);
    url.searchParams.set('uri', input.url);
    for (const category of categories) url.searchParams.append('threatTypes', category);
    const response = await dispatchLookup(admission, this.transport, url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'x-goog-api-key': this.key },
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal,
    });
    try {
      signal.throwIfAborted();
      if (response.redirected || (response.url && response.url !== url.href))
        throw Error('Unexpected source endpoint.');
      if (response.status === 429) {
        const until = backoff(response.headers.get('retry-after'), this.clock());
        blockWebRisk(this.directory, until);
        return this.receipt(input, 'rate_limited', 'quota');
      }
      const data = await readSource(response);
      signal.throwIfAborted();
      if (!('threat' in data)) {
        if (this.transport === globalThis.fetch && this.directory === webRiskDirectory)
          this.lastVerifiedAt = new Date(this.clock()).toISOString();
        return this.receipt(input, 'no_match', null);
      }
      const expiry = Date.parse(data.threat.expireTime);
      if (!Number.isFinite(expiry) || expiry <= this.clock()) throw Error('Expired match.');
      const result = ThreatReply.parse({
        ...this.receipt(input, 'match', null),
        categories: data.threat.threatTypes,
        expiresAt: new Date(expiry).toISOString(),
      });
      if (this.transport === globalThis.fetch && this.directory === webRiskDirectory)
        this.lastVerifiedAt = result.checkedAt;
      return result;
    } finally {
      if (response.body && !response.body.locked) void response.body.cancel().catch(() => {});
    }
  }
}
