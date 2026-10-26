// Which AI clients may connect (Settings → Security → AI clients allowed to connect). The administrator chooses —
// nothing is forced on. A client is recognised by where its sign-in returns to (the redirect URI it registered),
// which the client can't fake: PSArelay only ever sends the sign-in result to that address.

import { settingDef, settingValue } from '../admin/settings.js';

export type AiClientKind = 'chatgpt' | 'claude' | 'copilot' | 'grok' | 'desktop' | 'other';
/** The display name of a kind (from the setting's labels). */
export const clientLabel = (k: AiClientKind): string => settingDef('security.aiClients')?.choiceLabels?.[k] ?? k;

const HOSTS: Array<[AiClientKind, RegExp]> = [
  ['chatgpt', /(^|\.)(chatgpt\.com|openai\.com)$/],
  ['claude', /(^|\.)(claude\.ai|claude\.com|anthropic\.com)$/],
  ['copilot', /^teams\.microsoft\.com$/],
  ['grok', /(^|\.)(grok\.com|x\.ai)$/],
];

/** The kind of client a redirect URI belongs to. */
export function clientKindOf(redirectUri: string): AiClientKind {
  let u: URL;
  try { u = new URL(redirectUri); } catch { return 'other'; }
  const host = u.hostname.toLowerCase();
  if (u.protocol === 'http:' && (host === '127.0.0.1' || host === 'localhost' || host === '[::1]')) return 'desktop';
  if (u.protocol !== 'https:') return 'other';
  return HOSTS.find(([, re]) => re.test(host))?.[0] ?? 'other';
}

/** The allowed kinds (the setting; every kind when unset). */
export function allowedClientKinds(): AiClientKind[] {
  return settingValue<AiClientKind[]>('security.aiClients');
}

/** The first redirect URI whose client is switched off, or null when all of them may connect. */
export function blockedRedirect(redirectUris: string[], allowed: AiClientKind[] = allowedClientKinds()): { uri: string; kind: AiClientKind } | null {
  for (const uri of redirectUris) { const kind = clientKindOf(uri); if (!allowed.includes(kind)) return { uri, kind }; }
  return null;
}
