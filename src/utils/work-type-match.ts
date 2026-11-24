/**
 * Work types (BillingCodes useType 1) by what a person SAYS, not by id.
 *
 * Voice and chat users name a work type loosely — "priority remote", "remote
 * priority work", "onsite" — while the tenant's label might be "Remote Support -
 * Priority". Billing depends on the work type, so only a SURE match is used:
 *   1. a numeric id;
 *   2. an alias set by the operator (AUTOTASK_WORK_TYPE_ALIASES);
 *   3. the exact label, case-insensitive;
 *   4. the same words in any order, filler like "work" / "type" ignored
 *      ("support remote" → "Remote Support"), when exactly one label has them.
 * Anything looser is NEVER assumed — it comes back for the person to confirm:
 *   - `confirm`: one label holds every spoken word ("priority remote" → "Remote
 *     Support - Priority") — the suggestion, plus the other similar work types;
 *   - `ambiguous`: several labels fit — those are the choices;
 *   - `unknown`: nothing fits — the similar ones (a shared word), else all.
 * The caller re-runs with the exact label (or the id) once the person has said
 * which. Inactive work types never match by name; one that would have is reported.
 */

export interface WorkTypeRef { id: number; name: string; active: boolean }

export type WorkTypeMatch =
  | { ok: true; id: number; name: string; via: 'id' | 'alias' | 'exact' | 'words' }
  | {
      ok: false;
      reason: 'confirm' | 'unknown' | 'ambiguous' | 'inactive';
      requested: string;
      /** confirm: the likely work type — ask before using it. */
      suggested?: { id: number; name: string };
      /** confirm / ambiguous / unknown: the similar work types, closest first (suggested included); or every active one when none is similar. */
      choices: Array<{ id: number; name: string }>;
      /** True when `choices` are similar to what was said (not just the whole list). */
      similar: boolean;
      /** An alias that points at a work type this tenant doesn't have (operator config error). */
      badAlias?: string;
    };

/** Words that carry no meaning in a work-type name as spoken. */
const FILLER = new Set(['work', 'type', 'worktype', 'the', 'a', 'an', 'of', 'for', 'as', 'time', 'billing', 'code', 'and', '&']);

/** Spoken variants folded onto one spelling, applied to both sides. */
const PHRASES: Array<[RegExp, string]> = [
  [/\bon[\s-]*site\b/g, 'onsite'],
  [/\boff[\s-]*site\b/g, 'offsite'],
  [/\bafter[\s-]*hours?\b/g, 'afterhour'],
  [/\bin[\s-]*shop\b/g, 'inshop'],
  [/\bremotely\b/g, 'remote'],
  // Labels say "Remote~Priority Service" where people say "priority remote support" (seen live 2026-11-23).
  [/\bservices?\b/g, 'support'],
];

/** At most this many similar work types are offered (a list read out by voice must stay short). */
const MAX_SIMILAR = 8;

export function workTypeWords(s: string): string[] {
  let t = String(s).toLowerCase();
  for (const [re, to] of PHRASES) t = t.replace(re, to);
  return t
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !FILLER.has(w))
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

const key = (s: string): string => workTypeWords(s).join(' ');
const sameSet = (a: string[], b: string[]): boolean => {
  const A = new Set(a), B = new Set(b);
  return A.size === B.size && [...A].every((w) => B.has(w));
};

/**
 * Operator aliases: JSON `{"remote priority": "Remote Support - Priority", "rp": 102}`
 * or `remote priority=Remote Support - Priority; rp=102`. Keys compare by words
 * (order and filler ignored); values are a work-type label or id.
 */
export function parseWorkTypeAliases(raw: string | string[] | undefined | null): Map<string, string> {
  const out = new Map<string, string>();
  const text = (Array.isArray(raw) ? raw.join('\n') : String(raw ?? '')).trim();
  if (!text) return out;
  const add = (k: unknown, v: unknown): void => {
    const kk = [...workTypeWords(String(k ?? ''))].sort().join(' ');
    const vv = String(v ?? '').trim();
    if (kk && vv) out.set(kk, vv);
  };
  if (text.startsWith('{')) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(text) as Record<string, unknown>)) add(k, v);
      return out;
    } catch { /* fall through to the k=v form */ }
  }
  for (const part of text.split(/[;\n]/)) {
    const i = part.indexOf('=');
    if (i > 0) add(part.slice(0, i), part.slice(i + 1));
  }
  return out;
}

export function matchWorkType(types: WorkTypeRef[], requested: string | number, aliases: Map<string, string> = new Map()): WorkTypeMatch {
  const raw = String(requested ?? '').trim();
  const active = types.filter((t) => t.active);
  const all = active.map(({ id, name }) => ({ id, name }));
  const words = workTypeWords(raw);
  // Similar = shares at least one word; closest (most shared, then fewest extra words) first.
  const similarTo = (first?: { id: number }): Array<{ id: number; name: string }> => {
    const scored = active
      .map((t) => { const w = workTypeWords(t.name); const shared = words.filter((x) => w.includes(x)).length; return { id: t.id, name: t.name, shared, extra: w.length - shared }; })
      .filter((t) => t.shared > 0)
      .sort((a, b) => b.shared - a.shared || a.extra - b.extra || a.name.localeCompare(b.name));
    if (first) scored.sort((a, b) => Number(b.id === first.id) - Number(a.id === first.id));
    return scored.slice(0, MAX_SIMILAR).map(({ id, name }) => ({ id, name }));
  };
  const fail = (reason: 'confirm' | 'unknown' | 'ambiguous' | 'inactive', extra: { choices?: Array<{ id: number; name: string }>; suggested?: { id: number; name: string }; badAlias?: string } = {}): WorkTypeMatch => {
    const near = extra.choices ?? similarTo(extra.suggested);
    return {
      ok: false, reason, requested: raw,
      ...(extra.suggested ? { suggested: extra.suggested } : {}),
      choices: near.length ? near : all, similar: near.length > 0,
      ...(extra.badAlias ? { badAlias: extra.badAlias } : {}),
    };
  };

  if (/^\d+$/.test(raw)) {
    const hit = types.find((t) => t.id === Number(raw));
    if (!hit) return fail('unknown', { choices: [] });
    return hit.active ? { ok: true, id: hit.id, name: hit.name, via: 'id' } : fail('inactive', { choices: [] });
  }
  if (!words.length) return fail('unknown', { choices: [] });

  // 2. Operator alias — its target must be a real active work type (by id or exact label).
  const target = aliases.get([...words].sort().join(' '));
  if (target != null) {
    const t = /^\d+$/.test(target)
      ? active.find((w) => w.id === Number(target))
      : active.find((w) => w.name.trim().toLowerCase() === target.toLowerCase()) ?? active.find((w) => key(w.name) === key(target));
    if (t) return { ok: true, id: t.id, name: t.name, via: 'alias' };
    return fail('unknown', { badAlias: target });
  }

  // 3. Exact label.
  const exact = active.filter((t) => t.name.trim().toLowerCase() === raw.toLowerCase());
  if (exact.length === 1) return { ok: true, id: exact[0]!.id, name: exact[0]!.name, via: 'exact' };

  // 4. Same words, any order.
  const same = active.filter((t) => sameSet(workTypeWords(t.name), words));
  if (same.length === 1) return { ok: true, id: same[0]!.id, name: same[0]!.name, via: 'words' };
  if (same.length > 1) return fail('ambiguous', { choices: same.map(({ id, name }) => ({ id, name })) });

  // Looser than that is never assumed: a single label holding every word is a suggestion to confirm.
  const partial = active.filter((t) => { const w = new Set(workTypeWords(t.name)); return words.every((x) => w.has(x)); });
  if (partial.length === 1) return fail('confirm', { suggested: { id: partial[0]!.id, name: partial[0]!.name } });
  if (partial.length > 1) return fail('ambiguous', { choices: similarTo().filter((c) => partial.some((p) => p.id === c.id)) });

  // Would an inactive one have matched? Say so rather than "unknown".
  const inactiveHit = types.some((t) => !t.active && (t.name.trim().toLowerCase() === raw.toLowerCase() || sameSet(workTypeWords(t.name), words)));
  return fail(inactiveHit ? 'inactive' : 'unknown');
}

// ── Regional work types ───────────────────────────────────────────────────
// Some MSPs keep a copy of their work types per state for tax ("CT - Priority" =
// labour taxable in that state). Which copy applies depends on the CLIENT'S
// state, never on what the tech says. A rule maps a region TAG — a word in the
// label, wherever it sits ("CT - Priority", "Remote Priority (CT)") — to the
// company State values it covers. Set live in the console ("Regional work
// types", one rule per line: CT=CT/Connecticut), env default
// AUTOTASK_WORK_TYPE_REGIONS (CT=CT,Connecticut; TX=TX — or JSON). Labels are
// re-read from Autotask, so renaming work types needs no change here.
// With a client state known:
//   - in a region: only that region's work types are matched (tag ignored,
//     "priority" → "CT - Priority"); a name that fits none of them may fall back
//     to an ordinary work type, but only for the person to confirm;
//   - elsewhere: other regions' work types are never offered.
// State unknown (no ticket / company has no state): a regional match is only a
// suggestion to confirm. Naming the tag ("CT priority"), an id or an alias is
// explicit and always honoured. No rules configured → nothing changes.

export interface WorkTypeRegion { prefix: string; words: string[]; places: string[] }

const words0 = (s: string): string[] => String(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Env / JSON / console text → one `key=value` line per rule (values joined with "/"). */
export function workTypeRuleLines(raw: string | undefined | null): string[] {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  if (text.startsWith('{')) {
    try {
      return Object.entries(JSON.parse(text) as Record<string, unknown>)
        .map(([k, v]) => `${String(k).trim()}=${Array.isArray(v) ? v.map((x) => String(x).trim()).join('/') : String(v ?? '').trim()}`)
        .filter((l) => !/^=|=$/.test(l));
    } catch { /* fall through to the k=v form */ }
  }
  return text.split(/[;\n]/).map((l) => l.trim()).filter(Boolean);
}

export function parseWorkTypeRegions(raw: string | string[] | undefined | null): WorkTypeRegion[] {
  const lines = Array.isArray(raw) ? raw : workTypeRuleLines(raw);
  const byTag = new Map<string, WorkTypeRegion>();
  for (const line of lines) {
    const i = line.indexOf('=');
    if (i < 1) continue;
    const prefix = line.slice(0, i).trim();
    const words = words0(prefix);
    const places = line.slice(i + 1).split(/[,/|]/).map((p) => p.trim().toLowerCase()).filter(Boolean);
    if (!words.length || !places.length) continue;
    const key = words.join(' ');
    const prev = byTag.get(key); // the same tag on two lines adds states
    if (prev) prev.places = [...new Set([...prev.places, ...places])];
    else byTag.set(key, { prefix, words, places: [...new Set(places)] });
  }
  return [...byTag.values()];
}

/** Why a console line is not a valid region rule, or null. */
export function regionLineProblem(line: string): string | null {
  const i = line.indexOf('=');
  if (i < 1 || i === line.length - 1) return `"${line}" must look like TAG=State/State (e.g. CT=CT/Connecticut)`;
  if (!words0(line.slice(0, i)).length) return `"${line}": the tag must contain a letter or digit`;
  return null;
}

/** Why a console line is not a valid alias, or null. */
export function aliasLineProblem(line: string): string | null {
  const i = line.indexOf('=');
  if (i < 1 || i === line.length - 1) return `"${line}" must look like spoken name=work type name or id (e.g. rush=Onsite Support - Priority)`;
  if (!workTypeWords(line.slice(0, i)).length) return `"${line}": the spoken name has no words that count (filler like "work" is ignored)`;
  return null;
}

/** The region whose tag is in this label ("CT - Priority", "Remote (CT)" → CT), or null. */
export function regionOf(name: string, regions: WorkTypeRegion[]): WorkTypeRegion | null {
  const w = words0(name);
  return regions.find((r) => r.words.every((x) => w.includes(x))) ?? null;
}

/** The label without its region tag ("CT - Priority" → "Priority", "Remote Priority (CT)" → "Remote Priority"). */
const stripRegion = (name: string, r: WorkTypeRegion): string => {
  let rest = String(name);
  for (const w of r.words) rest = rest.replace(new RegExp(`(^|[^a-z0-9])${w}(?=[^a-z0-9]|$)`, 'gi'), '$1');
  return rest.replace(/\(\s*\)|\[\s*\]/g, '').replace(/^[\s\-–—~:|/,]+|[\s\-–—~:|/,]+$/g, '').replace(/\s{2,}/g, ' ');
};

export type RegionalMatch = WorkTypeMatch & { regionNote?: string };

/**
 * matchWorkType with regional rules. `place` = the client's State (null = unknown,
 * undefined = not looked up / not applicable — treated as unknown).
 */
export function matchWorkTypeForClient(
  types: WorkTypeRef[], requested: string | number, aliases: Map<string, string>, regions: WorkTypeRegion[], place: string | null | undefined,
): RegionalMatch {
  const raw = String(requested ?? '').trim();
  if (!regions.length) return matchWorkType(types, raw, aliases);
  const spokenRaw = raw.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const explicit = /^\d+$/.test(raw) || aliases.has([...workTypeWords(raw)].sort().join(' '))
    || regions.some((r) => r.words.every((x) => spokenRaw.includes(x)));
  if (explicit) return matchWorkType(types, raw, aliases);

  const pl = place != null && String(place).trim() ? String(place).trim().toLowerCase() : null;
  const label = place != null ? String(place).trim() : '';
  const ref = (t: { id: number; name: string }) => ({ id: t.id, name: t.name });
  const regionalOf = new Map(types.map((t) => [t.id, regionOf(t.name, regions)]));

  if (pl == null) {
    // State unknown: everything is matchable, but a regional work type is never used without asking.
    const m = matchWorkType(types, raw, aliases);
    if (m.ok && regionalOf.get(m.id)) {
      const near = matchWorkType(types.filter((t) => !regionalOf.get(t.id) || t.id === m.id), raw, new Map());
      const choices = [ref(m), ...((near.ok ? [] : near.choices).filter((c) => c.id !== m.id))].slice(0, MAX_SIMILAR);
      return { ok: false, reason: 'confirm', requested: raw, suggested: ref(m), choices, similar: true,
        regionNote: `"${m.name}" is a regional work type and the client's state is not known — check it applies to this client.` };
    }
    if (!m.ok && m.suggested && regionalOf.get(m.suggested.id)) {
      return { ...m, regionNote: `"${m.suggested.name}" is a regional work type and the client's state is not known — check it applies to this client.` };
    }
    return m;
  }

  const mine = regions.filter((r) => r.places.includes(pl));
  // Out of every region: other regions' work types are simply not offered.
  if (!mine.length) return matchWorkType(types.filter((t) => !regionalOf.get(t.id)), raw, aliases);

  // In a region: match its work types with the prefix ignored.
  const inRegion = types.filter((t) => { const r = regionalOf.get(t.id); return r != null && mine.includes(r); });
  const realName = new Map(inRegion.map((t) => [t.id, t.name]));
  const back = (c: { id: number; name: string }) => ({ id: c.id, name: realName.get(c.id) ?? c.name });
  const regionList = inRegion.filter((t) => t.active).map(ref);
  const withRest = (first: Array<{ id: number; name: string }>) =>
    [...first, ...regionList.filter((t) => !first.some((f) => f.id === t.id))].slice(0, MAX_SIMILAR);
  const note = `This client is in ${label}, so only ${mine.map((r) => r.prefix).join(' / ')} work types apply.`;
  const stripped = inRegion.map((t) => ({ ...t, name: stripRegion(t.name, regionalOf.get(t.id)!) }));
  const m = matchWorkType(stripped, raw, new Map());
  if (m.ok) return { ...m, name: realName.get(m.id) ?? m.name };
  if (m.reason === 'confirm') return { ...m, suggested: back(m.suggested!), choices: withRest(m.choices.map(back)), regionNote: note };
  if (m.reason === 'ambiguous') return { ...m, choices: m.choices.map(back), regionNote: note };
  if (m.reason === 'unknown' && m.similar) {
    const near = m.choices.map(back);
    return near.length === 1
      ? { ok: false, reason: 'confirm', requested: raw, suggested: near[0]!, choices: withRest(near), similar: true, regionNote: note }
      : { ok: false, reason: 'ambiguous', requested: raw, choices: near, similar: true, regionNote: note };
  }
  // Nothing regional fits ("travel"): an ordinary work type, but only for the person to confirm.
  const other = matchWorkType(types.filter((t) => !regionalOf.get(t.id)), raw, aliases);
  const outside = `This client is in ${label}; none of its ${mine.map((r) => r.prefix).join(' / ')} work types fits "${raw}".`;
  if (other.ok) {
    return { ok: false, reason: 'confirm', requested: raw, suggested: ref(other), choices: [ref(other), ...regionList].slice(0, MAX_SIMILAR), similar: true,
      regionNote: `${outside} "${other.name}" is not a ${mine.map((r) => r.prefix).join(' / ')} work type — confirm it is right for this client.` };
  }
  return { ...other, choices: withRest(other.reason === 'confirm' && other.suggested ? other.choices : []), regionNote: outside };
}
