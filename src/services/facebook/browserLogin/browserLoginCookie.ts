export interface BrowserCookie { name: string; value: string; domain: string }

type LoginCookieState = { state: 'waiting' } | { state: 'wrong_account' } | { state: 'ready'; cookie: string };

const isFacebookDomain = (domain: string): boolean => domain === 'facebook.com' || domain.endsWith('.facebook.com');

export function readLoginCookie(cookies: BrowserCookie[], expectedFacebookId: string): LoginCookieState {
  const byName = new Map<string, string>();
  for (const { name, value, domain } of cookies) {
    if (isFacebookDomain(domain) && !byName.has(name)) byName.set(name, value);
  }
  const userId = byName.get('c_user');
  if (!userId || !byName.get('xs')) return { state: 'waiting' };
  if (userId !== expectedFacebookId) return { state: 'wrong_account' };
  return { state: 'ready', cookie: [...byName].map(([name, value]) => `${name}=${value}`).join('; ') };
}
