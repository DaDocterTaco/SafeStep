import {
  activeThreat,
  ExplainHealth,
  THREAT_POLICY_VERSION,
  ThreatReply,
  type ThreatRequest,
} from '@safestep/contracts';
import { boundedResponseText } from './bounded-response';

export type ThreatDecision = { reply?: ThreatReply; message?: string };
type Reader = {
  subject: ThreatRequest;
  signal: AbortSignal;
  allowed: () => Promise<boolean>;
  finish: (result: ThreatDecision) => void;
};
type Lookup = {
  key: string;
  token: string;
  subject: ThreatRequest;
  priority: boolean;
  started: boolean;
  readers: Set<Reader>;
  abort: AbortController;
};
const service = 'http://127.0.0.1:4317';
const unavailable = 'Google Web Risk is unavailable. Current coverage is unknown.';
const expired = 'The local pairing expired. Reconnect the service in Settings.';

// Every threat caller uses the same paired transport. Reader bindings stay in
// the worker; only the validated public URL, scope and purpose leave it.
export class ThreatLookups {
  private jobs = new Map<string, Lookup>();
  private positive = new Map<string, ThreatReply>();
  private active = 0;
  private epoch = 0;
  hasPositive(url: string) {
    const receipt = this.positive.get(THREAT_POLICY_VERSION + ':' + url);
    return !!receipt && activeThreat(receipt);
  }

  reset() {
    this.epoch++;
    this.positive.clear();
    for (const job of this.jobs.values()) {
      job.abort.abort();
      for (const reader of job.readers) reader.finish({ message: 'Website protection changed.' });
    }
    this.jobs.clear();
  }

  async check(
    subject: ThreatRequest,
    signal: AbortSignal,
    allowed: Reader['allowed'],
  ): Promise<ThreatDecision> {
    const epoch = this.epoch;
    if (signal.aborted || !(await allowed())) return { message: 'The protection context changed.' };
    const token = (await chrome.storage.session.get('local-ai-session'))['local-ai-session'];
    if (typeof token !== 'string' || !/^ss3_[\w-]{43}$/.test(token)) {
      return { message: 'Google Web Risk is unavailable. Pair the local service in Settings.' };
    }
    if (epoch !== this.epoch || signal.aborted || !(await allowed()))
      return { message: 'The protection context changed.' };
    // Pairing changes clear memory. The token is held only by the paired
    // request and never used as a key in persisted data or diagnostic output.
    const key = THREAT_POLICY_VERSION + ':' + subject.url;
    let job = this.jobs.get(key);
    if (job && job.token !== token) {
      this.reset();
      job = undefined;
    }
    if (!job) {
      if (this.jobs.size >= 12)
        return { message: 'The threat lookup queue is full. Take over or try again later.' };
      job = {
        key,
        token,
        subject,
        priority: false,
        started: false,
        readers: new Set(),
        abort: new AbortController(),
      };
      this.jobs.set(key, job);
    }
    const pending = job;
    pending.priority ||= subject.purpose === 'target';
    return new Promise((resolve) => {
      const leave = () => {
        reader.finish({ message: 'The threat check was cancelled.' });
        if (!pending.readers.size) {
          pending.abort.abort();
          if (this.jobs.get(key) === pending) this.jobs.delete(key);
        }
      };
      const reader: Reader = {
        subject,
        signal,
        allowed,
        finish: (value) => {
          signal.removeEventListener('abort', leave);
          pending.readers.delete(reader);
          resolve(value);
        },
      };
      pending.readers.add(reader);
      signal.addEventListener('abort', leave, { once: true });
      if (signal.aborted) leave();
      else this.pump();
    });
  }

  private pump() {
    while (this.active < 2) {
      const waiting = [...this.jobs.values()].filter((job) => !job.started);
      const next = waiting.find((job) => job.priority) ?? waiting[0];
      if (!next) return;
      next.started = true;
      this.active++;
      void this.run(next).finally(() => {
        if (this.jobs.get(next.key) === next) this.jobs.delete(next.key);
        this.active--;
        this.pump();
      });
    }
  }

  private async validReaders(job: Lookup) {
    for (const reader of [...job.readers]) {
      if (reader.signal.aborted || !(await reader.allowed().catch(() => false))) {
        reader.finish({ message: 'The protected page or destination changed.' });
      }
    }
    return job.readers.size > 0 && !job.abort.signal.aborted && this.jobs.get(job.key) === job;
  }

  private async run(job: Lookup) {
    let outcome: ThreatDecision = { message: unavailable };
    try {
      if (!(await this.validReaders(job))) return;
      const cached = this.positive.get(job.key);
      const reuse = cached && activeThreat(cached);
      if (cached && !reuse) this.positive.delete(job.key);
      const response = await fetch(service + (reuse ? '/v1/explain/connect' : '/v1/threat/check'), {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + job.token, 'Content-Type': 'application/json' },
        ...(reuse ? {} : { body: JSON.stringify(job.subject) }),
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.any([job.abort.signal, AbortSignal.timeout(5500)]),
      });
      if (response.status === 401 || response.status === 403) {
        this.positive.clear();
        outcome = { message: expired };
        return;
      }
      if (response.status === 429) {
        outcome = { message: 'Google Web Risk lookup limit reached. Current coverage is limited.' };
        return;
      }
      if (!response.ok) return;
      const data = JSON.parse(
        await boundedResponseText(response, 16384, 'Invalid Web Risk response.'),
      );
      if (reuse && !ExplainHealth.parse(data).connected) {
        outcome = { message: expired };
        return;
      }
      const reply = reuse ? cached : ThreatReply.parse(data);
      if (
        reply.url !== job.subject.url ||
        (!reuse && (reply.scope !== job.subject.scope || reply.purpose !== job.subject.purpose))
      )
        return;
      if (!(await this.validReaders(job))) return;
      if (reply.status === 'match') {
        if (!activeThreat(reply)) return;
        if (this.positive.size >= 128) this.positive.delete(this.positive.keys().next().value!);
        this.positive.set(job.key, reply);
      }
      outcome = { reply };
    } catch {
      /* No affirmative result on timeout, abort, malformed data or provider outage. */
    } finally {
      if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
      for (const reader of [...job.readers]) {
        const result = outcome.reply
          ? { reply: { ...outcome.reply, ...reader.subject, purpose: reader.subject.purpose } }
          : outcome;
        reader.finish(result);
      }
    }
  }
}
