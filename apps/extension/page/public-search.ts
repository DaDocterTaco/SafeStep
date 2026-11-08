import { publicSearchQuery, wikipediaSearchProvenance } from '@safestep/contracts';

// Static Vector markup and its hydrated search combobox have the same public
// retrieval contract. The hydrated form adds a Wikimedia provenance field.
export function wikipediaForm() {
  if (location.origin !== 'https://en.wikipedia.org') return null;
  if(location.pathname==='/wiki/Special:Search' && !location.search && !location.hash){
    // Narrow fallback used when the responsive header's actual public link
    // opens Special:Search before its inline search widget has hydrated.
    const form=document.querySelector<HTMLFormElement>('main form#search');
    const field=form?.elements.namedItem('search'), title=form?.elements.namedItem('title');
    if(form && document.querySelectorAll('form#search').length===1 && form.method.toLowerCase()==='get' &&
      form.action===location.origin+'/w/index.php' && (!form.target||form.target==='_self') &&
      !form.hasAttribute('onsubmit') && !document.querySelector('base[target]:not([target="_self"])') &&
      field instanceof HTMLInputElement && field.type==='search' && field.form===form && !field.readOnly && !field.disabled &&
      title instanceof HTMLInputElement && title.type==='hidden' && title.value==='Special:Search' && title.form===form &&
      field.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) && field.getBoundingClientRect().width>0)
      return {form,field};
  }
  const form = document.querySelector<HTMLFormElement>('#p-search[role=search] form#searchform');
  if (
    !form ||
    document.querySelectorAll('form#searchform').length !== 1 ||
    form.method.toLowerCase() !== 'get' ||
    (form.target && form.target !== '_self') ||
    form.action !== location.origin + '/w/index.php' ||
    form.hasAttribute('onsubmit') ||
    document.querySelector('base[target]:not([target="_self"])') ||
    ![3, 4].includes(form.elements.length)
  )
    return null;
  const field = form.elements.namedItem('search'),
    title = form.elements.namedItem('title');
  if (
    !(field instanceof HTMLInputElement) ||
    field.type !== 'search' ||
    !(
      field.id === 'searchInput' ||
      (!field.id &&
        field.getAttribute('role') === 'combobox' &&
        field.getAttribute('aria-label') === 'Search Wikipedia')
    ) ||
    field.disabled ||
    field.readOnly ||
    field.form !== form ||
    !form.contains(field) ||
    !(title instanceof HTMLInputElement) ||
    title.type !== 'hidden' ||
    title.disabled ||
    title.value !== 'Special:Search' ||
    !form.contains(title)
  )
    return null;
  const provenance = form.elements.namedItem('wprov');
  if (
    form.elements.length === 4 &&
    (!(provenance instanceof HTMLInputElement) ||
      provenance.type !== 'hidden' ||
      provenance.form !== form ||
      !form.contains(provenance) ||
      !wikipediaSearchProvenance(provenance.value))
  )
    return null;
  const submit = Array.from(form.elements).find(
    (x) => x !== field && x !== title && x !== provenance,
  );
  if (
    !(submit instanceof HTMLButtonElement) ||
    submit.type !== 'submit' ||
    submit.name ||
    submit.disabled ||
    !form.contains(submit) ||
    ['formaction', 'formmethod', 'formenctype', 'formtarget'].some((k) => submit.hasAttribute(k))
  )
    return null;
  return { form, field };
}

export function wikipediaControl(e: HTMLElement) {
  const shape = wikipediaForm();
  if (!shape) return null;
  const visible =
    shape.field.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
    shape.field.getBoundingClientRect().width > 0;
  if (e === shape.field && visible)
    return {
      label: 'Search Wikipedia',
      role: 'search' as const,
      action: 'submit_public_search' as const,
      path: null,
    };
  if (
    !visible &&
    e instanceof HTMLAnchorElement &&
    e.matches('#p-search > a.search-toggle') &&
    e.href === location.origin + '/wiki/Special:Search' &&
    !e.hasAttribute('onclick') &&
    !e.hasAttribute('target')
  )
    return {
      label: 'Open Wikipedia search',
      role: 'button' as const,
      action: 'toggle_known_navigation' as const,
      path: '/wiki/Special:Search',
    };
  return null;
}

export function submitWikipediaSearch(e: HTMLElement, query: string) {
  const shape = wikipediaForm();
  if (!shape || e !== shape.field || !wikipediaControl(e) || publicSearchQuery(query) !== query)
    throw Error('The approved public search form or query changed.');
  shape.field.value = query;
  // Derive this GET from the actual, revalidated form. Never serialize optional
  // tracking fields, private form contents, or a planner-supplied URL.
  const destination = new URL(shape.form.action);
  destination.searchParams.set(shape.field.name, query);
  destination.searchParams.set('title', 'Special:Search');
  location.assign(destination.href);
}
