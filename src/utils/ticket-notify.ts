// E-mailing a ticket note to the customer (ticket contact + additional contacts).
//
// The Autotask API can't send e-mail, and a note posted through the API e-mails no one.
// The tenant sets up a trigger once: a ticket UDF (e.g. "Nexus-Notify", values Send / Sent)
// and a workflow rule that fires on "Note Added" when the note is published to
// All Autotask Users AND the UDF = Send, e-mails the note to the Ticket Contact and the
// additional contacts, and sets the UDF to Sent so it fires once. Verified live
// (2026-11-20): every armed ticket got exactly one mail, to the ticket contact and every
// additional contact on it.
//
// autotask_notify_ticket (and create_ticket_note with notify:true) arm the UDF, then post
// the note. Any MCP client can do it — ChatGPT, Copilot, Claude, Nexus — and tag people
// by contact id or e-mail address; tagged people are added to the ticket first so the
// same e-mail reaches them.

export interface NotifyConfig {
  /** The ticket UDF the workflow rule watches. */
  udf: string;
  /** The value that arms it. */
  value: string;
  /** TicketNotes.publish value the rule's condition matches (All Autotask Users). */
  publish: number;
  /** TicketNotes.noteType used when the caller gives none. */
  noteType: number;
}

/** The trigger set-up from the environment; null when this server has none. */
export function notifyConfig(env: NodeJS.ProcessEnv = process.env): NotifyConfig | null {
  const udf = (env.AUTOTASK_NOTIFY_UDF ?? '').trim();
  if (!udf) return null;
  const num = (v: string | undefined, d: number) => {
    const n = Number((v ?? '').trim());
    return (v ?? '').trim() !== '' && Number.isInteger(n) ? n : d;
  };
  return {
    udf,
    value: (env.AUTOTASK_NOTIFY_VALUE ?? '').trim() || 'Send',
    publish: num(env.AUTOTASK_NOTIFY_PUBLISH, 1),
    noteType: num(env.AUTOTASK_NOTIFY_NOTE_TYPE, 1),
  };
}

export const NOTIFY_NOT_CONFIGURED =
  'E-mailing a note needs the notification trigger set up once: a ticket UDF (List: Send, Sent) and an Autotask workflow ' +
  'rule ("Note Added", Note Publish To = All Autotask Users AND the UDF = Send → e-mail Ticket Contact + Additional Contacts, ' +
  'set the UDF to Sent). Then set AUTOTASK_NOTIFY_UDF to the UDF name on this server (docs/NOTIFICATIONS.md). Nothing written.';

export type NotifyTag = { contactID: number } | { email: string };

/** Tags as given ("pat@example.com", 123, "123") → contact ids or e-mail addresses; bad ones listed. */
export function parseNotifyTags(raw: unknown): { tags: NotifyTag[]; invalid: string[] } {
  const list = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
  const tags: NotifyTag[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const s = String(item ?? '').trim();
    if (!s) continue;
    let tag: NotifyTag | null = null;
    if (/^\d+$/.test(s) && Number(s) > 0) tag = { contactID: Number(s) };
    else if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s)) tag = { email: s.toLowerCase() };
    else {
      const m = /<([^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)>/.exec(s); // "Pat Example <pat@example.com>"
      if (m) tag = { email: m[1]!.toLowerCase() };
    }
    if (!tag) { invalid.push(s); continue; }
    const k = 'contactID' in tag ? `c${tag.contactID}` : `e${tag.email}`;
    if (!seen.has(k)) { seen.add(k); tags.push(tag); }
  }
  return { tags, invalid };
}
