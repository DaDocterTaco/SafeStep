export function resellStorefrontAccount(u: URL) {
  if (u.protocol !== 'https:' || u.port || u.username || u.password) return null;
  const tenant = /^([a-z0-9][a-z0-9-]{0,62})\.resell\.store$/.exec(u.hostname)?.[1];
  return tenant && !['api', 'www', 'docs', 'files', 'app', 'support'].includes(tenant)
    ? tenant
    : null;
}

export function resellStorefrontRoute(u: URL) {
  const account = resellStorefrontAccount(u);
  return account && /^\/(?:[a-z0-9-]{1,160}\/?|)$/.test(u.pathname) ? account : null;
}

export function mozillaReviewScope(u: URL) {
  if (
    u.origin !== 'https://addons.mozilla.org' ||
    u.username ||
    u.password ||
    u.hash ||
    !/^\/[a-zA-Z-]+\/firefox\/addon\/[a-z0-9_-]+\/reviews\/$/.test(u.pathname)
  )
    return false;
  for (const [key, value] of u.searchParams)
    if (
      u.searchParams.getAll(key).length !== 1 ||
      !(key === 'score' ? /^[1-5]$/.test(value) : key === 'page' ? /^[1-3]$/.test(value) : false)
    )
      return false;
  return true;
}
