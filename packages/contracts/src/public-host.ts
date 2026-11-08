import { z } from 'zod';

export const publicHost = z.string().max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/)
  .refine(s => !/(?:^|\.)(localhost|local|internal|test|invalid|example|onion|arpa|home|lan|corp)$/.test(s));
