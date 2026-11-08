import {
  ShoppingData,
  SellerAccount,
  publicExcerpt,
  type ShoppingKind,
  type ReviewBinding,
} from '@safestep/contracts';
import { protectionAddress } from '../sites/protection';
import {
  blankShop,
  conclude,
  failShop,
  metric,
  readMozilla,
  readResell,
  shopRecord,
  shoppingRoute,
  limitShop,
  type ReserveShopSet,
} from '../sites/shopping';
import { visible } from './reader';
import { operable } from './review-reader';

const excluded =
  'form,input,textarea,select,option,[contenteditable],iframe,script,style,template,[hidden],[inert],[aria-hidden=true],.buyer,aside,[aria-label="Sponsored" i]';
function region(root: HTMLElement, limit = 2000) {
  const elements: HTMLElement[] = [];
  let visited = 0;
  // Count rejected siblings too, and skip their entire private or hidden subtrees.
  const stack: Element[] = [];
  let cur: Element | null = root.firstElementChild;
  while (cur && visited++ < limit) {
    const e = cur,
      sibling = e.nextElementSibling;
    if (
      e instanceof HTMLElement &&
      !e.matches(excluded) &&
      e.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })
    ) {
      elements.push(e as HTMLElement);
      if (e.firstElementChild) {
        if (sibling) stack.push(sibling);
        cur = e.firstElementChild;
        continue;
      }
    }
    cur = sibling ?? stack.pop() ?? null;
  }
  return { elements, limited: !!cur };
}
function safeText(el: HTMLElement | undefined) {
  if (!el) return '';
  let str = '';
  const w = document.createTreeWalker(el, NodeFilter.SHOW_ALL, {
    acceptNode(n) {
      if (n instanceof Element && n.matches(excluded)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = w.nextNode(), i = 0; n && i < 90 && str.length < 420; n = w.nextNode(), i++)
    if (n.nodeType === Node.TEXT_NODE && !n.parentElement?.closest(excluded))
      str += (n.nodeValue ?? '').slice(0, 420 - str.length) + ' ';
  return publicExcerpt(str);
}
export function sourceTarget(d: ShoppingData) {
  if (!d.more) return null;
  const area =
    d.context.market === 'practice'
      ? document.getElementById('shop-listing')
      : (document.querySelector<HTMLElement>('main') ?? document.body);
  if (!area) return null;
  const scan = region(area);
  if (scan.limited) return null;
  const candidates = scan.elements.filter((el): el is HTMLAnchorElement => {
    if (!(el instanceof HTMLAnchorElement) || !visible(el) || !operable(el)) return false;
    try {
      const u = new URL(el.href);
      const desired = new URL(d.more!);
      return (
        !u.username &&
        !u.password &&
        u.origin + u.pathname === desired.origin + desired.pathname &&
        ['score', 'page'].every((k) => u.searchParams.get(k) === desired.searchParams.get(k))
      );
    } catch {
      return false;
    }
  });
  return candidates.length === 1 ? candidates[0]! : null;
}
function fixture(d: ShoppingData, records = true) {
  const m = document.getElementById('shop-listing'),
    s = document.getElementById(d.kind + '-section');
  if (!m || !s || !visible(m) || !visible(s))
    return failShop(d, 'source_unavailable', 'The practice source section is unavailable.');
  const a = m.dataset,
    c = d.context;
  c.seller = SellerAccount.safeParse(a.seller).data ?? null;
  c.display = a.display ?? null;
  c.store = a.store ?? null;
  c.listing = a.listing ?? null;
  c.catalog = a.catalog ?? null;
  c.format = a.format ?? null;
  c.isbn = a.isbn || null;
  c.year = a.year ?? null;
  c.variant = a.variant ?? null;
  c.condition = a.condition ?? null;
  c.since = a.since ?? null;
  c.title = a.title ?? null;
  d.source = location.origin + location.pathname;
  d.more = location.origin + '/shopping-lab/' + d.kind;
  const amazonPractice=location.pathname==='/shopping-lab/amazon-us';
  if(amazonPractice){
    d.more=null;
    const declared=a.marketplaceAddress&&URL.canParse(a.marketplaceAddress)?new URL(a.marketplaceAddress):null;
    if(a.region!=='US'||!a.offer||!a.asin||!/^[A-Z0-9]{10}$/.test(a.asin)||
       !/^[A-Za-z0-9_-]{1,100}$/.test(a.offer)||a.asin!==c.catalog||a.offer!==c.listing||!c.seller||
       !declared||declared.hostname!=='www.amazon.com'||protectionAddress(declared.href,true).identity!=='amazon_us'||
       declared.pathname!=='/dp/'+a.asin||declared.searchParams.get('smid')!==c.seller||
       s.dataset.region!=='US'||s.dataset.offer!==a.offer||s.dataset.asin!==a.asin||s.dataset.seller!==c.seller)
      return failShop(d,'identity_uncertain','The selected practice offer, ASIN and exact seller account could not all be matched.');
    c.practiceOffer={region:'US',marketplaceHost:'www.amazon.com',asin:a.asin,offer:a.offer,shipsFrom:a.shipper?.slice(0,160)||null,brand:a.brand?.slice(0,160)||null};
  }
  d.scope = s.dataset.scope ?? 'Unknown view';
  d.filter = s.dataset.sort ?? 'Unknown filter';
  const subject = d.kind === 'seller' ? c.seller : (c.catalog ?? c.listing);
  if (
    !subject ||
    subject !== s.dataset.subject ||
    (d.kind === 'product' && (s.dataset.isbn || null) !== c.isbn)
  )
    return failShop(
      d,
      'identity_uncertain',
      'The source subject or edition disagrees with the primary listing.',
    );
  if (s.dataset.state === 'denied' || s.dataset.state === 'loading')
    return failShop(
      d,
      s.dataset.state === 'denied' ? 'source_unavailable' : 'loading',
      'The public section has not supplied readable feedback.',
    );
  if (d.kind === 'seller' && d.scope !== 'Received as seller')
    return failShop(
      d,
      'limited_evidence',
      'This view does not contain feedback received as seller.',
    );
  if (!records) return d;
  const regs = region(s),
    entries = regs.elements.filter((e) => e.hasAttribute('data-record'));
  d.automatedFilter =
    s.dataset.automated === 'included'
      ? 'included'
      : s.dataset.automated === 'excluded'
        ? 'excluded'
        : 'unknown';
  d.limited = regs.limited || entries.length > 20;
  for (const el of regs.elements.filter((e) => e.dataset.metric).slice(0, 14)) {
    const at = el.dataset,
      unit = at.unit;
    if (unit !== 'stars' && unit !== 'percent' && unit !== 'count') continue;
    if (!at.value?.trim() || !/^\d+(\.\d+)?$/.test(at.value.trim())) continue;
    d.metrics.push(
      metric(
        at.metric!,
        Number(at.value),
        unit,
        at.period ?? 'Unknown period',
        at.scale ? Number(at.scale) : null,
        at.approx === 'true',
      ),
    );
  }
  d.badge = safeText(regs.elements.find((e) => e.dataset.badge)) || null;
  const sample=entries.slice(0,20);
  const kept=amazonPractice?sample.filter(e=>e.dataset.state==='current'&&e.dataset.subject===subject&&
    e.dataset.channel===(d.kind==='seller'?'seller_received_feedback':'catalog_product_review')):sample;
  d.records = kept.map((e, i) => {
    const t = e.dataset;
    return {
      ...shopRecord(d, i),
      platformId: t.id ?? null,
      listing: t.link ?? null,
      soldBy: SellerAccount.safeParse(t.soldby).data ?? null,
      version: t.version || null,
      text: safeText(
        regs.elements.find((x) => x.parentElement === e && x.hasAttribute('data-comment')),
      ),
      rating: t.rating ? Number(t.rating) : null,
      published: t.published ?? null,
      precision: t.precision === 'relative' ? 'relative' : 'date',
      automated: t.automated === 'true',
      verified: t.verified === 'true',
      condition: t.condition ?? null,
    };
  });
  d.note =
    d.kind === 'seller'
      ? 'Platform badges and verified-purchase labels describe source claims. Linked items show observed transactions only.'
      : 'Catalog feedback can span sellers and editions. It cannot establish the condition of this copy or its seller’s service.';
  if(amazonPractice) d.note=(d.kind==='seller'?'Practice seller service. Product reviews and fulfillment do not establish seller quality.':'Practice catalog reviews for this ASIN. Seller service is assessed separately.')+
    ' Excluded '+(sample.length-kept.length)+' entries with a different subject/channel or struck-through, removed or unknown status.'+
    (regs.elements.some(el=>el.dataset.unit==='count'&&el.dataset.metric&&!el.dataset.value?.trim())?' A count is unknown for one source period.':'');
  return conclude(d, s.dataset.state === 'zero' && !d.records.length);
}
export function pageSignature(kind: ShoppingKind) {
  const u = new URL(location.href),
    route = shoppingRoute(u);
  if (!route) return 'unsupported';
  if (route?.market === 'practice') {
    const d = fixture(blankShop({} as ReviewBinding, kind, 'practice'), false);
    return JSON.stringify([
      u.pathname,
      d.context,
      d.status,
      d.scope,
      d.metrics,
      d.records,
      d.filter,
      d.badge,
      d.limited,
      d.automatedFilter,
      d.more,
      sourceTarget(d)?.pathname,
    ]);
  }
  // The documented API binds this result to the canonical shop/listing or catalog
  // and its selected filter. A storefront can render its heading after the read starts.
  // A shown DOM link is revalidated separately by exact element and destination.
  return JSON.stringify([
    u.origin,
    u.pathname,
    route?.key,
    route?.market === 'mozilla' ? [u.searchParams.get('page'), u.searchParams.get('score')] : null,
  ]);
}
export async function readShopping(
  b: ReviewBinding,
  kind: ShoppingKind,
  signal: AbortSignal,
  reserve?: ReserveShopSet,
) {
  const u = new URL(location.href),
    route = shoppingRoute(u),
    d = blankShop(b, kind, route?.market ?? 'unsupported');
  if (!route)
    return failShop(
      d,
      'unsupported',
      'Use a Resell.store shop or listing for seller feedback, or a Mozilla Add-ons product page for product reviews.',
    );
  try {
    if (route.market === 'practice') {
      const wait = Number(document.getElementById(kind + '-section')?.dataset.delay ?? 0);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 700)));
      fixture(d, false);
      const subject =
        kind === 'seller' ? d.context.seller : (d.context.catalog ?? d.context.listing);
      if (d.status === 'limited_evidence' && subject && reserve && !(await reserve(subject)))
        return limitShop(d);
      fixture(d);
    } else if (route.market === 'mozilla') await readMozilla(d, route.key, signal, u, reserve);
    else await readResell(d, route.key, u, signal, reserve);
    signal.throwIfAborted();
    if (
      ['reviews_available', 'limited_evidence', 'no_reviews_in_view', 'explicit_zero'].includes(
        d.status,
      ) &&
      sourceTarget(d)
    )
      d.target = crypto.randomUUID();
    // Two independent cards must fit in the shared wire envelope even with multibyte text.
    while (new TextEncoder().encode(JSON.stringify(d)).length > 19000 && d.records.length) {
      d.records.pop();
      d.limited = true;
    }
    // Retain the exact public page, separate from a review API or catalogue link.
    if (ShoppingData.safeParse({...d, inspectedUrl:u.href}).success)
      d.inspectedUrl = u.href;
    return ShoppingData.parse(d);
  } catch {
    if (
      signal.aborted &&
      !(signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError')
    )
      signal.throwIfAborted();
    const out = blankShop(b, kind, route.market);
    return failShop(
      out,
      'source_unavailable',
      'This source did not return a complete, validated public response. Refresh to try again.',
    );
  }
}
