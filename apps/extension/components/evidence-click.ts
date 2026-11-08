import type { MouseEvent } from 'react';

export function openEvidenceLink(event: MouseEvent, open: (url: string) => void) {
  if (event.button !== 0 && event.button !== 1) return;
  const anchor =
    event.target instanceof Element
      ? event.target.closest<HTMLAnchorElement>('a[data-source-url]')
      : null;
  if (!anchor) return;
  event.preventDefault();
  open(anchor.href);
}
