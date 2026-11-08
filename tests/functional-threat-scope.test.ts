import assert from 'node:assert/strict';
import test from 'node:test';
import { ThreatRequest, ThreatReply, threatPageUrl, threatRootUrl } from '@safestep/contracts';

test('A disclosed HTTPS homepage never substitutes for a requested public path', () => {
  const docs='https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/filter';
  assert.equal(threatPageUrl(docs),docs);
  assert.equal(threatRootUrl(docs),'https://developer.mozilla.org/');
  assert.equal(threatPageUrl('https://shop.public.org/new/widget'),null);
  assert.equal(threatPageUrl('http://testsafebrowsing.appspot.com/s/malware.html'),'http://testsafebrowsing.appspot.com/s/malware.html');
  assert.equal(ThreatRequest.safeParse({scope:'root',url:docs}).success,false);
  for (const raw of ['https://login.public.org/','https://user@public.org/',
    'https://docs.python.org/3/tutorial/account','https://docs.python.org/3/tutorial/errors.html?token=xyz',
    'https://example.org/path#section','https://example.org/%2561ccount',
    'https://example.org/checkout','https://public.org/8c3a9e08653fc1e9','https://127.0.0.1/',
    'https://example.org/%2e%2e/account','https://public.org/a/../public',
    'https://example.org:4321/','https://example.org/data%2fauth/']) {
    assert.equal(threatRootUrl(raw),null,raw); assert.equal(threatPageUrl(raw),null,raw);
  }
  assert.equal(ThreatRequest.safeParse({scope:'page',url:docs,token:'secret'}).success,false);
});
test('Receipts separate misses from unavailable and require positive categories and provider expiry', () => {
  const receipt={scope:'root',url:'https://example.org/',source:'Google Web Risk Lookup',
    checkedAt:'2026-11-08T08:40:00.000Z',expiresAt:null,status:'no_match',categories:[],reason:null};
  assert(ThreatReply.safeParse(receipt).success);
  assert(!ThreatReply.safeParse({...receipt,status:'match'}).success);
  assert(!ThreatReply.safeParse({...receipt,status:'unavailable'}).success);
  assert(!ThreatReply.safeParse({...receipt,categories:['MALWARE']}).success);
  assert(!ThreatReply.safeParse({...receipt,status:'match',categories:['MALWARE'],expiresAt:'2026-11-08T08:39:59.000Z'}).success);
  assert(ThreatReply.safeParse({...receipt,status:'match',categories:['MALWARE'],expiresAt:'2026-11-08T08:41:00.000Z'}).success);
});
