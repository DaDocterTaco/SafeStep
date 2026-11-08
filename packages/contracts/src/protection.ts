import { z } from 'zod';
import { ThreatReply, threatPageUrl, threatRootUrl } from './threat.js';

export const ProtectionScope = z.enum(['off', 'selected', 'all']);
const siteOrigin = z
  .string()
  .max(260)
  .refine((value) => {
    try {
      const u = new URL(value);
      return ['http:', 'https:'].includes(u.protocol) && u.origin === value;
    } catch {
      return false;
    }
  });
export const ProtectionPreferences = z.strictObject({
  scope: ProtectionScope,
  sites: z.array(siteOrigin).max(64),
  outside: z.boolean(),
  threatRoot: z.boolean().optional(),
  automaticUrlConsent: z.literal(2).optional(),
  budget: z.number().int().min(0).max(20),
});
export type ProtectionPreferences = z.infer<typeof ProtectionPreferences>;
export const protectionOff = (): ProtectionPreferences => ({
  scope: 'off',
  sites: [],
  outside: false,
  budget: 0,
});
export const ProtectionCommand = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('configure'),
    scope: ProtectionScope,
    site: siteOrigin.nullable(),
    outside: z.boolean(),
    threatRoot: z.boolean().optional(),
    automaticUrlConsent: z.literal(2).optional(),
    budget: z.number().int().min(0).max(20),
  }),
  z.strictObject({ op: z.literal('removeSite'), site: siteOrigin }),
  z.strictObject({ op: z.enum(['recheck', 'dismiss','leave']), revision: z.uuid() }),
  z.strictObject({ op: z.literal('allowLimitedTarget'), revision:z.uuid(), ticket:z.uuid() }),
  z.strictObject({ op: z.literal('threat'), revision: z.uuid(), scope: z.enum(['root', 'page']) }),
]);
export type ProtectionCommand = z.infer<typeof ProtectionCommand>;
const citation = z.strictObject({
  label: z.string().min(1).max(200),
  url: z
    .url()
    .max(2048)
    .refine((v) => {
      const u = new URL(v);
      return u.protocol === 'https:' && !u.username && !u.password;
    }),
});
export const ProtectionView = z.strictObject({
  doc: z.string().min(1).max(120),
  origin: siteOrigin,
  routeToken: z.string().regex(/^[a-f0-9]{32}$/),
  host: z.string().max(253),
  expectedHost:z.string().max(253).optional(),
  revision: z.uuid(),
  identity: z.enum(['observed', 'amazon_us', 'mismatch', 'deceptive', 'unusual']),
  address: z.string().min(1).max(350),
  checkedAt: z.iso.datetime(),
  status: z.enum([
    'checking',
    'local',
    'private',
    'reports',
    'limited',
    'no_match',
    'unavailable',
    'quota',
  ]),
  outside: z.string().min(1).max(1100),
  threat: ThreatReply.optional(),
  threatWarnings: z.array(ThreatReply).max(2).refine(a => a.every(r=>r.status==='match') && new Set(a.map(r=>r.scope)).size===a.length).optional(),
  threatNotice: z.string().min(1).max(420).optional(),
  destination: z.strictObject({
    kind: z.enum(['navigation','download','offer','source']),
    message: z.string().min(1).max(850),
    result: ThreatReply.optional(),
    limitedTicket:z.uuid().optional(),
  }).optional(),
  threatPage: z.string().max(500).refine(s => threatPageUrl(s) === s).optional(),
  threatHome: z.string().max(500).refine(s => threatRootUrl(s) === s).optional(),
  sources: z.array(citation).max(15),
  details: z.array(z.string().max(600)).max(18),
  caution: z.boolean(),
  dismissed: z.boolean(),
  expiresAt: z.iso.datetime().nullable(),
});
export type ProtectionView = z.infer<typeof ProtectionView>;
