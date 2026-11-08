import { z } from 'zod';
import { parse } from 'tldts';
import {
  MerchantPractice,
  MerchantReply,
  merchantDataset,
  merchantEndpoint,
  merchantProvider,
  merchantRecordUrl,
  type MerchantRequest,
} from '@safestep/contracts';

const day = 86400000;
const maxRows = 12;
const sourceRow = z.strictObject({
  businessname: z.string().min(1).max(253),
  businessid: z.string().regex(/^\d{1,15}$/),
  openeddate: z.string().regex(/^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?$/),
  complaintid: z.string().regex(/^\d{1,15}$/),
  practicename: MerchantPractice,
  status: z.string().min(1).max(45),
});
type RecordEntry = MerchantReply['records'][number];
type Work = {
  domain: string;
  controller: AbortController;
  done: Promise<MerchantReply>;
  readers: number;
};

function base(domain: string, now: number): MerchantReply {
  return {
    domain,
    status: 'unavailable',
    severity: 'information',
    provider: merchantProvider,
    checkedAt: new Date(now).toISOString(),
    expiresAt: new Date(now).toISOString(),
    source: merchantDataset,
    businessId: null,
    windowStart: new Date(now - 365 * day).toISOString().slice(0, 10),
    rowsInspected: 0,
    distinctComplaints: 0,
    records: [],
    summary: 'Outside merchant check unavailable.',
    limitations: [
      'Coverage is limited to named businesses in this Washington State consumer complaint dataset.',
    ],
  };
}
function canonicalBusiness(domain: string) {
  const parsed = parse(domain, { allowPrivateDomains: true });
  return parsed.isIcann &&
    parsed.domain &&
    (domain === parsed.domain || domain === 'www.' + parsed.domain)
    ? parsed.domain
    : null;
}
function sourceQuery(domain: string, since: string) {
  const url = new URL(merchantEndpoint);
  url.searchParams.set(
    '$select',
    'businessname,businessid,openeddate,complaintid,practicename,status',
  );
  // Only validated ASCII DNS labels are interpolated. Never send a path, query, user input or a consumer identity.
  const clauses = [
    "upper(businessname)='" + domain.toUpperCase() + "'",
    "openeddate >= '" + since + "T00:00:00'",
    'practicename in (' + MerchantPractice.options.map((p) => "'" + p + "'").join(',') + ')',
  ];
  url.searchParams.set('$where', clauses.join(' AND '));
  url.searchParams.set('$order', 'openeddate DESC, complaintid DESC');
  url.searchParams.set('$limit', String(maxRows));
  return url;
}
async function readRows(response: Response) {
  if (
    !response.ok ||
    !/^application\/json\b/i.test(response.headers.get('content-type') ?? '') ||
    !response.body
  )
    throw new Error('Source unavailable');
  const reader = response.body.getReader(),
    chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const read = await reader.read();
      if (read.done) break;
      bytes += read.value.byteLength;
      if (bytes > 32768) throw new Error('Source reply too large');
      chunks.push(Buffer.from(read.value));
    }
    return z
      .array(sourceRow)
      .max(maxRows)
      .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function collect(
  domain: string,
  now: number,
  signal: AbortSignal,
  request: typeof fetch,
): Promise<MerchantReply> {
  const result = base(domain, now),
    canonical = canonicalBusiness(domain);
  if (!canonical)
    return {
      ...result,
      status: 'limited',
      summary: 'No exact public merchant domain is available for this data source.',
    };
  try {
    const response = await request(sourceQuery(canonical, result.windowStart), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      signal,
    });
    if (response.status === 429)
      return {
        ...result,
        status: 'rate_limited',
        summary: 'The Washington data source reached its request limit.',
      };
    const rows = await readRows(response);
    result.rowsInspected = rows.length;
    if (
      rows.some(
        (x) =>
          x.businessname.toLowerCase() !== canonical ||
          x.openeddate.slice(0, 10) < result.windowStart ||
          x.openeddate.slice(0, 10) > result.checkedAt.slice(0, 10) ||
          !z.iso.date().safeParse(x.openeddate.slice(0, 10)).success,
      )
    )
      throw new Error('Mismatched source response');
    result.expiresAt = new Date(now + 5 * 60_000).toISOString();
    if (!rows.length)
      return {
        ...result,
        status: 'no_match',
        summary: 'No matching complaint records in the inspected source and period.',
      };
    if (new Set(rows.map((x) => x.businessid)).size !== 1)
      return {
        ...result,
        status: 'limited',
        summary:
          'The state records name multiple responding businesses for this domain. Their reports cannot be combined.',
      };
    result.businessId = rows[0]!.businessid;
    const records = new Map<string, RecordEntry>();
    for (const row of rows) {
      const date = row.openeddate.slice(0, 10);
      const state =
        row.status === 'Closed' || row.status === 'Open' || row.status === 'New'
          ? row.status
          : 'Other';
      const previous = records.get(row.complaintid);
      if (previous) {
        if (previous.caseStatus !== state || previous.date !== date)
          previous.caseStatus = 'Conflicting';
        if (!previous.practices.includes(row.practicename))
          previous.practices.push(row.practicename);
      } else
        records.set(row.complaintid, {
          id: row.complaintid,
          date,
          practices: [row.practicename],
          caseStatus: state,
          url: merchantRecordUrl(row.businessid, row.complaintid),
        });
    }
    result.records = [...records.values()];
    result.distinctComplaints = records.size;
    result.limitations.push(
      'These are consumer allegations categorized by the state. An open or closed case does not establish fault, a refund, or current merchant behavior.',
      'The sample has no sales denominator and does not identify the individual shoppers or any third-party seller.',
    );
    if (rows.length === maxRows)
      result.limitations.push('Reached the 12-row sample limit. More records may exist.');
    if (result.records.some((x) => x.caseStatus === 'Conflicting'))
      return {
        ...result,
        status: 'limited',
        summary:
          'The source returned conflicting dates or statuses for the same complaint. Review the limited evidence.',
      };
    const recent = result.records.filter((r) => now - Date.parse(r.date) < 90 * day);
    if (new Set(recent.map((r) => r.date)).size >= 2)
      return {
        ...result,
        status: 'reports',
        severity: 'caution',
        summary:
          'Washington State records multiple recent complaints naming ' +
          canonical +
          ' about fulfillment or refunds. Review the dated allegations before buying.',
      };
    return {
      ...result,
      status: 'limited',
      summary: recent.length
        ? 'Limited complaint evidence for this merchant in the inspected period.'
        : 'Only older complaint records were found in this sample.',
    };
  } catch {
    if (signal.aborted) signal.throwIfAborted();
    return {
      ...base(domain, now),
      summary:
        'The state source did not return verifiable current evidence. Outside coverage is unavailable.',
    };
  }
}
export class MerchantService {
  private cache = new Map<string, MerchantReply>();
  private active: Work | null = null;
  private times: number[] = [];
  private attempts = 0;
  constructor(
    private request: typeof fetch = fetch,
    private clock = Date.now,
  ) {}
  async check(input: MerchantRequest, client: AbortSignal): Promise<MerchantReply> {
    client.throwIfAborted();
    const now = this.clock(),
      domain = canonicalBusiness(input.domain);
    const reply = base(input.domain, now);
    if (!domain)
      return {
        ...reply,
        status: 'limited',
        summary:
          'The state source supports public merchant domains only. This hostname was not sent.',
      };
    const cached = this.cache.get(domain);
    if (cached && Date.parse(cached.expiresAt) > now) return { ...cached, domain: input.domain };
    let work = this.active;
    if (work && (work.domain !== domain || work.controller.signal.aborted))
      return {
        ...reply,
        status: 'rate_limited',
        summary: 'Another merchant check is running. A new check can be requested later.',
      };
    if (!work) {
      this.times = this.times.filter((t) => now - t < 60_000);
      if (this.times.length >= 2 || this.attempts >= 20)
        return {
          ...reply,
          status: 'rate_limited',
          summary: 'The paired session’s merchant lookup budget has been reached.',
        };
      this.times.push(now);
      this.attempts++;
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(4500)]);
      const done = collect(domain, now, signal, this.request)
        .catch(() => ({ ...reply, summary: 'The merchant lookup timed out or was cancelled.' }))
        .then((raw) => {
          const result = MerchantReply.parse(raw);
          if (!signal.aborted && Date.parse(result.expiresAt) > this.clock())
            this.cache.set(domain, result);
          return result;
        });
      work = { domain, controller, done, readers: 0 };
      this.active = work;
      void done.then(
        () => {
          if (this.active?.done === done) this.active = null;
        },
        () => {
          if (this.active?.done === done) this.active = null;
        },
      );
    }
    const current = work;
    current.readers++;
    let reject: (e: unknown) => void = () => {};
    const cancelled = new Promise<never>((_, no) => {
      reject = no;
    });
    const abort = () => reject(client.reason);
    client.addEventListener('abort', abort, { once: true });
    try {
      client.throwIfAborted();
      return { ...(await Promise.race([current.done, cancelled])), domain: input.domain };
    } finally {
      client.removeEventListener('abort', abort);
      if (--current.readers === 0 && client.aborted) current.controller.abort();
    }
  }
}
