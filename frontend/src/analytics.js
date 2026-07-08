/**
 * analytics — Cloudflare Web Analytics (privacy-first, cookieless, no consent banner needed).
 *
 * Injects the beacon only when a token is provided at build time via VITE_CF_BEACON — a no-op otherwise, so
 * dev builds and token-less builds send nothing. The token is a PUBLIC beacon id (safe to commit / expose).
 *
 * Two ways to turn analytics on:
 *   1. Zero-code: enable "Web Analytics" on the Cloudflare Pages project — it auto-injects on every domain,
 *      no rebuild needed. (In that case leave VITE_CF_BEACON unset so you don't double-count.)
 *   2. In-code / portable: set VITE_CF_BEACON=<your beacon token> at build time and this injects it.
 */
export function initAnalytics() {
  const token = import.meta.env.VITE_CF_BEACON;
  if (!token || typeof document === 'undefined') return;
  const s = document.createElement('script');
  s.defer = true;
  s.src = 'https://static.cloudflareinsights.com/beacon.min.js';
  s.setAttribute('data-cf-beacon', JSON.stringify({ token }));
  document.head.appendChild(s);
}
