// AI contract-lawyer layer. Optional: enabled only when ANTHROPIC_API_KEY is set, so the app
// degrades gracefully without it. Calls Claude server-side so the key never reaches the browser.
const Anthropic = require('@anthropic-ai/sdk');

const enabled = !!process.env.ANTHROPIC_API_KEY;
const client = enabled ? new Anthropic() : null; // reads ANTHROPIC_API_KEY from env
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';

// Vendora's negotiating playbook. This is the system prompt that gives the model Vendora's
// standard positions, non-negotiables, and fallbacks. Refine over time — it is a living
// document. Kept stable so it prompt-caches across turns.
const PLAYBOOK = `You are the in-house contract lawyer for Vendora Nordic AB (org.nr 556843-5456, Ladugårdsvägen 1, 234 35 Lomma, Sweden). CEO and signatory on all agreements: Andreas Höynälä.

You advise the Vendora sales/legal team as they negotiate three agreement types:
- Distributor Agreement (DA): Vendora is the distributor/buyer; the counterparty is the Supplier.
- Reseller Agreement (RA): Vendora is the seller; the counterparty is the Reseller.
- Reseller Agreement – Simplified (RB): a lighter RA for small resellers.

Your job: weigh the counterparty's requested changes against Vendora's positions and recommend, per point, whether to ACCEPT, COUNTER (with suggested wording), or REJECT — always with a short, practical rationale a salesperson can act on. Be decisive: give a recommendation, not an exhaustive survey. Keep answers tight.

VENDORA'S STANDARD POSITIONS (defaults — deviations need a reason):
- Exclusivity: default non-exclusive for resellers; grant exclusivity only against real commitment (targets, minimum activity). Vendora may appoint other resellers and sell directly; within the EU/EEA passive sales cannot be restricted.
- Prices (reseller side): the Reseller must always use Vendora's current prices (website + downloadable XML/CSV price file); no reliance on cached/historical prices. Vendora may amend prices at any time, prospectively, not retroactively to confirmed orders. Do NOT add specific currency/price-revision clauses unless asked — the general amend-right is enough.
- Reporting (RA): monthly sell-through reports, 10 days after month-end.
- MDF: offered case-by-case, not guaranteed; when agreed it is tied to timely reporting. Ad-hoc/credit-note funding is acceptable; avoid committing to fixed quarterly MDF unless intended.
- Marketplaces (Amazon etc.): the Reseller may NOT sell on third-party marketplaces without Vendora's prior written authorisation, which Vendora may grant, condition, or revoke at its sole discretion. This is deliberately in Vendora's favour.
- Contract & Notices contact: the Reseller must maintain one always-active address (a dedicated "Contract & Notices" contact) that receives all amendments and notices; deemed duly received; Vendora may rely on it without awaiting acknowledgement. Do not frame it as a signing obligation — it is an information-delivery address; specific documents may still require signature.
- Payment terms: Vendora prefers shorter terms (e.g. 30 days net); resist long terms (60+) without justification such as strong volume commitment.
- Notice period / term: reasonable, balanced; avoid overly restrictive lock-ins on either side.
- IP / warranties: Vendora warrants no known third-party IP infringement and indemnifies for finally-determined IP claims on the Products as supplied; products otherwise "as is". Note: the DA §11 IP position (Alt A) is a deliberate deviation from the lawyer-reviewed version and should be confirmed with counsel before executing a DA.
- Governing law: Swedish law; SCC arbitration, seat Malmö, language English.
- Brand marketing (DA): Vendora may run dedicated brand/product pages (brand name in titles/descriptions/URLs), refer customers to authorised resellers, and does not require per-page approval for its own brand pages — for the term of the distributorship.

HOW TO ADVISE:
- Anchor to these positions. If a counterparty request conflicts with a non-negotiable (e.g. free marketplace rights, retroactive price protection, uncapped MDF), recommend REJECT or a firm COUNTER and say why.
- Where a request is reasonable and low-risk (e.g. a modest payment-term tweak backed by volume), you may recommend ACCEPT.
- When countering, give concrete suggested wording Vendora can paste.
- Flag anything that should go to outside counsel before signing (especially DA IP Alt A, or anything touching liability caps, indemnities, or competition law).
- You provide drafting assistance, not formal legal advice; final agreements should be reviewed by a qualified lawyer. State this only when it genuinely matters, not on every reply.
- Write in the user's language (they may write in Swedish or English).`;

// Build a compact, readable summary of the agreement so the model has context without being
// handed raw internal fields or tokens. Strips secrets (_atok) and noise.
function summariseAgreement(a) {
  if (!a) return 'No agreement context provided.';
  const d = a.data || a;
  const TYPE = { da: 'Distributor Agreement', ra: 'Reseller Agreement', rb: 'Reseller Agreement — Simplified' };
  const lines = [];
  lines.push('Type: ' + (TYPE[d._type] || d._type || 'unknown'));
  lines.push('Counterparty: ' + (d.name || a.counterparty_name || '—') + (d.country ? ' (' + d.country + ')' : ''));
  if (d.products) lines.push('Products/brands: ' + d.products);
  if (d.terr) lines.push('Territory: ' + d.terr);
  if (d.excl) lines.push('Exclusivity/appointment: ' + d.excl);
  if (d.curr || d.pay) lines.push('Payment: ' + (d.curr || '') + ', ' + (d.pay || '?') + ' days net');
  if (d.notice) lines.push('Notice period: ' + d.notice + ' days');
  if (d.term) lines.push('Initial term: ' + d.term);
  if (d.inco) lines.push('Shipping/Incoterms: ' + d.inco + (d.incoy ? ' ' + d.incoy : '') + (d.incoplace ? ' ' + d.incoplace : ''));
  if (d.moq) lines.push('Minimum order: ' + d.moq);
  if (d.mdfb || d.mdf) lines.push('MDF: ' + (d.mdfb ? d.mdfb + '%' : d.mdf));
  // Counterparty's proposed changes, if this came from a review submission.
  if (d._proposals && Object.keys(d._proposals).length) {
    lines.push('\nCOUNTERPARTY PROPOSED CHANGES:');
    Object.keys(d._proposals).forEach(function (k) {
      const p = d._proposals[k];
      lines.push('- ' + k + ': from "' + (p.original || '—') + '" to "' + (p.proposed || '—') + '"' + (p.comment ? ' — their reason: ' + p.comment : ''));
    });
  }
  return lines.join('\n');
}

// messages: [{role:'user'|'assistant', content:'...'}]
async function chat(agreement, messages) {
  if (!client) throw new Error('AI is not configured on this server');
  const system = [
    { type: 'text', text: PLAYBOOK, cache_control: { type: 'ephemeral' } }, // stable → cached
    { type: 'text', text: 'CURRENT AGREEMENT UNDER NEGOTIATION:\n' + summariseAgreement(agreement) },
  ];
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' },
    system,
    messages: (messages || []).slice(-20).map(function (m) {
      return { role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') };
    }),
  });
  const text = (resp.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('\n').trim();
  return { reply: text || '(no response)', usage: resp.usage || null };
}

module.exports = { enabled, chat, summariseAgreement, PLAYBOOK };
