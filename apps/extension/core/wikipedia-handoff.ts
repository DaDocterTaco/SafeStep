import { publicPath, wikipediaSearchUrl } from '@safestep/contracts';

/** These intermediate addresses may only be *waited out* after a verified
 * click. Neither is eligible for inspection, transmission or navigation. */
export function pendingWikipediaArticle(
  url: URL, expected: string, query: string, publicProvenance: ReadonlySet<string>,
): 'leaving-results' | 'decorated-article' | null {
  if (url.origin !== 'https://en.wikipedia.org' || url.username || url.password || url.hash ||
      !expected.startsWith('/wiki/') || publicPath(new URL(expected, url.origin), 'wikipedia') !== expected)
    return null;
  const keys = [...url.searchParams.keys()];
  if (url.pathname === '/w/index.php' && keys.filter(key => key === 'searchToken').length === 1) {
    // Do not look at, log or send the searchToken. Verify only the other fields
    // of the previously bound search and wait for the actual selected article.
    const originalSearch = new URL(url.href);
    originalSearch.searchParams.delete('searchToken');
    return wikipediaSearchUrl(originalSearch, query) ? 'leaving-results' : null;
  }
  return url.pathname === expected && keys.length === 1 && keys[0] === 'wprov' &&
    publicProvenance.has(url.searchParams.get('wprov') ?? '')
    ? 'decorated-article' : null;
}
