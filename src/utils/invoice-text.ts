// Customer-facing charge text (name / description print on the invoice).
//
// Why (2026-11-05): a material charge went onto a ticket with the description
// "Supply house pickup - <part>; no serial number. Cost $30.23, 30% markup." —
// purchasing notes, our cost and our markup, on the customer's invoice. Cost and
// price are their own fields; the text must describe the product only. This
// flags the internal wording so a write can refuse it (the caller can override
// when a match is a false alarm).

const RULES: Array<[RegExp, string]> = [
  [/\bmark[\s-]?up\b/i, 'markup'],
  [/\bmargin\b/i, 'margin'],
  [/\b(?:our|unit|purchase|vendor|supplier|wholesale)?\s*cost\b\s*(?:[:=]|of|is|was|@)?\s*\$?\s*\d/i, 'a cost figure'],
  [/\$\s*\d[\d,]*(?:\.\d+)?\s*(?:cost|landed)\b/i, 'a cost figure'],
  [/\b\d+(?:\.\d+)?\s*%\s*(?:over|above|on top|up)\b/i, 'a markup percentage'],
  [/\bsupply\s+house\b|\bsupplier\b|\bdistributor\b|\bpurchased\s+(?:from|at)\b|\bbought\s+(?:from|at)\b/i, 'supplier / purchasing details'],
  [/\bpick[\s-]?up\b|\bpicked\s+up\b|\bwill[\s-]?call\b/i, 'pickup instructions'],
  [/\bno\s+serial\b|\bserial\s*(?:number|no\.?|#)?\s*(?:needed|required|missing|to\s+collect|tbd|n\/?a)\b|\bcollect\s+(?:the\s+)?serial\b/i, 'serial-number notes'],
  [/\b(?:internal|do\s+not\s+(?:bill|show|invoice))\b/i, 'an internal note'],
  [/\b(?:po|purchase\s+order)\s*#?\s*\d/i, 'a purchase-order reference'],
];

/** The kinds of internal information found in a charge's customer-facing text ([] = looks customer-safe). */
export function findInternalText(text: string | null | undefined): string[] {
  if (!text) return [];
  const found = new Set<string>();
  for (const [re, label] of RULES) if (re.test(text)) found.add(label);
  return [...found];
}

/** One message for name + description, or null when both look customer-safe. */
export function internalTextProblem(fields: { name?: unknown; description?: unknown }): string | null {
  const parts: string[] = [];
  for (const key of ['name', 'description'] as const) {
    const v = fields[key];
    if (typeof v !== 'string') continue;
    const hits = findInternalText(v);
    if (hits.length) parts.push(`${key} contains ${hits.join(', ')}`);
  }
  return parts.length
    ? `The charge ${parts.join('; ')} — that text prints on the customer's invoice. Describe the product only (manufacturer, model / part number, what it is); cost and price go in unitCost / unitPrice, purchasing notes in an internal ticket note. Pass allowInternalText:true only if this is a false alarm.`
    : null;
}
