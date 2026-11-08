import assert from 'node:assert/strict';
import { test } from 'node:test';
import { protectionAddress } from '../apps/extension/sites/protection';
import { Preferences, ProtectionCommand, MerchantRequest } from '@safestep/contracts';

test('Amazon US identity uses the parsed registrable domain, secure origin and user-supplied expectation', () => {
  for (const address of [
    'https://amazon.com',
    'https://www.amazon.com',
    'https://smile.amazon.com/item',
    'https://WWW.AMAZON.COM./',
  ]) {
    const v = protectionAddress(address, true);
    assert.equal(v.identity, 'amazon_us');
    assert(!v.caution);
  }
  for (const address of [
    'https://amazon.com.attacker.com/safe',
    'https://amazon-com.example',
    'https://amazon.com@other.example/',
  ]) {
    const v = protectionAddress(address, true);
    assert.equal(v.identity, 'deceptive');
    assert(v.caution);
    assert(!v.address.includes('@'));
  }
  for (const address of [
    'https://amazon.io',
    'https://amazon.co.uk',
    'https://images-na.ssl-images-amazon.com',
    'https://xn--amzon-3ve.example',
    'https://elsewhere.org/amazon.com',
  ]) {
    const v = protectionAddress(address, true);
    assert.equal(v.identity, 'mismatch');
    assert(!v.caution);
  }
  for (const address of [
    'http://www.amazon.com',
    'https://www.amazon.com:8443/',
    'https://u:secret@amazon.com/',
  ]) {
    const v = protectionAddress(address, true);
    assert.notEqual(v.identity, 'amazon_us');
    assert(v.caution);
  }
  assert.equal(protectionAddress('https://example.org/path/amazon.com').identity, 'observed');
});
test('Automatic protection omits credentials, private network addresses, authenticated routes and URL tokens from outside checks', () => {
  for (const url of [
    'https://localhost',
    'http://127.0.0.1:4000',
    'http://[::1]/',
    'http://10.0.0.1',
    'http://0x7f000001',
    'https://printer.local',
    'https://www.wayfair.com/account',
    'https://www.wayfair.com/%61ccount/orders',
    'https://www.wayfair.com/terms?token=hidden',
    'https://www.wayfair.com/#access_token=x',
    'https://user:p@www.wayfair.com/',
    'https://mail.example.org/',
  ]) {
    assert(protectionAddress(url).privateRoute, url);
  }
  assert(!protectionAddress('https://www.wayfair.com/terms').privateRoute);
  for (const tail of [
    '?page=account',
    '?page=1&page=2',
    '?title=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    '?lang=private',
    '?title=%2574oken%253Dsecret',
    '/#%2561ccount',
    '/%2570rivate',
    '/documents/%252540user',
    '/terms#oauth%252Fcallback',
    '/?title=Patient%20account',
  ]) {
    assert(protectionAddress('https://www.wayfair.com' + tail).privateRoute, tail);
  }
  for (const tail of ['?page=2', '?title=Phishing', '?lang=en-US', '/terms#History']) {
    assert(!protectionAddress('https://www.wayfair.com' + tail).privateRoute, tail);
  }
  assert(!MerchantRequest.safeParse({ domain: 'www.wayfair.com', path: '/private' }).success);
  assert(!MerchantRequest.safeParse({ domain: 'https://www.wayfair.com/terms' }).success);
  assert(Preferences.safeParse({ sites: [], largeText: false }).success);
  assert(
    !ProtectionCommand.safeParse({
      op: 'configure',
      scope: 'all',
      site: null,
      outside: true,
      budget: 21,
    }).success,
  );
});
