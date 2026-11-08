import type { RecordState } from './state';

export type Destination = {
  kind: 'navigation' | 'download' | 'offer' | 'source';
  url: string;
  documentId: string;
};
export type DestinationPreflight = (
  state: RecordState,
  tab: chrome.tabs.Tab,
  target: Destination,
  signal: AbortSignal,
) => Promise<{ allow: boolean; reason?: string }>;
