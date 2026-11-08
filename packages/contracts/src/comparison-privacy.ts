import { privateText, safeLabel } from './assist.js';
export function isPublicComparisonText(text: string) {
  return (
    !privateText(text) &&
    safeLabel(text) &&
    !/\b(?:token|cookie|session|user[_ -]?id|address)\s*[:=]\s*\S|\b\d{1,6}\s+(?:[a-z]+\s+){0,4}(?:street|avenue|road|lane|drive|boulevard)\b/i.test(
      text,
    )
  );
}
