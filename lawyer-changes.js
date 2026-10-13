// Structured Contract Lawyer proposals: validate, apply, consistency-check, and emit
// tracked-change OOXML. Used by the server (AI tool output) and the browser panel.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LawyerChanges = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var OPS = ['replace', 'insert', 'delete'];
  var KINDS = ['clause', 'annex', 'field'];
  var ANNEX_IDS = ['1A', '1B', '2', '3', '4', '5'];

  // Cover-sheet / form fields the lawyer may write. Aliases are accepted and normalised.
  var FIELDS = {
    curr: { label: 'Invoice currency', form: 'curr' },
    pay: { label: 'Payment days', form: 'pay' },
    inco: { label: 'Shipping / Incoterm', form: 'inco' },
    incoplace: { label: 'Place of delivery', form: 'incoplace' },
    name: { label: 'Reseller name', form: 'name' },
    terr: { label: 'Territory', form: 'terr' },
    date: { label: 'Effective date', form: 'date' },
    sig_name: { label: 'Signatory', form: 'sig_name' },
    sig_title: { label: 'Signatory title', form: 'sig_title' },
    sig_email: { label: 'Signatory email', form: 'sig_email' },
    notice: { label: 'Notice period (days)', form: 'notice' },
    excl: { label: 'Exclusivity', form: 'excl' },
    credit: { label: 'Credit limit', form: 'credit' },
  };
  var FIELD_ALIAS = {
    currency: 'curr', curr: 'curr',
    'payment days': 'pay', payment_days: 'pay', paymentdays: 'pay', pay: 'pay',
    shipping: 'inco', incoterm: 'inco', incoterms: 'inco', inco: 'inco',
    incoplace: 'incoplace', 'place of delivery': 'incoplace',
    'reseller name': 'name', reseller: 'name', counterparty: 'name', name: 'name',
    territory: 'terr', terr: 'terr',
    'effective date': 'date', effectivedate: 'date', date: 'date',
    signatory: 'sig_name', 'reseller signatory': 'sig_name', sig_name: 'sig_name',
    sig_title: 'sig_title', sig_email: 'sig_email',
    notice: 'notice', 'notice period': 'notice',
    excl: 'excl', exclusivity: 'excl',
    credit: 'credit', 'credit limit': 'credit',
  };

  // Default wording the consistency check compares, and the text the lawyer is shown.
  // Placeholders {{curr}} / {{pay}} are filled from the agreement so the prompt matches the form.
  var CLAUSE_CATALOG = {
    ra: [
      { id: 'ra.s3.appointment', section: '3', label: 'Appointment (§3)', text: 'The Supplier hereby grants to the Reseller a {{excl}} right to market and sell the Products within the Territory during the term of this Agreement.' },
      { id: 'ra.no_subreselling', section: '3', label: 'No sub-reselling (§3)', text: 'The Reseller shall not appoint sub-resellers, sub-distributors, or sub-agents for the Products, nor grant any third party the right to sell or distribute the Products, without the prior written consent of the Supplier. Any such arrangement made without consent shall be null and void and shall constitute a material breach.' },
      { id: 'ra.marketplaces', section: '3', label: 'Third-party marketplaces (§3)', text: 'Third-party online marketplaces. The Reseller shall not list, advertise, or sell the Products on any third-party online marketplace (including but not limited to Amazon, eBay, Bol, Cdiscount, Allegro, or similar platforms) without the Supplier’s prior written authorisation, which the Supplier may grant, withhold, condition, or revoke at its sole discretion.' },
      { id: 'ra.s4.orders', section: '4', label: 'Orders (§4)', text: 'Orders shall be placed through the Supplier’s designated ordering channel and are subject to acceptance by the Supplier. The Supplier shall confirm or reject each order within two (2) business days of receipt; silence beyond this period constitutes acceptance.' },
      { id: 'ra.s4.prices', section: '4', label: 'Prices (§4)', text: 'Prices are as stated in the Supplier’s current price list or web portal. The Reseller shall not rely on any previously downloaded, cached, or historical price data. The Supplier reserves the right to amend Prices at any time; price changes apply to orders placed after the date the amended price list is published and shall not apply retroactively to orders already confirmed.' },
      { id: 'ra.s4.payment', section: '4', label: 'Payment (§4)', text: 'The Reseller shall pay for all ordered Products by bank transfer in {{curr}}, within {{pay}} days from the invoice date. In the event of late payment, the Supplier is entitled to charge statutory interest, reminder fees, and collection costs. The Supplier also has the right to withhold further deliveries until full payment has been received.' },
      { id: 'ra.s4.credit', section: '4', label: 'Credit limit (§4)', text: 'The Supplier shall determine, at its sole discretion, whether to extend credit to the Reseller and the credit limit applicable. The Credit Limit may be adjusted upon no less than seven (7) days’ written notice, or with immediate effect where the Supplier has reasonable grounds to suspect insolvency. Credit Limit: {{credit}}.' },
      { id: 'ra.s4.title', section: '4', label: 'Title retention (§4)', text: 'Title to all delivered Products shall remain vested in the Supplier until full payment of the purchase price has been received.' },
      { id: 'ra.s5.warranty', section: '5', label: 'Warranty representations (§5)', text: 'The Reseller shall not misrepresent the scope, duration, or terms of the Supplier’s standard warranty to end customers. Any additional guarantee is the Reseller’s own commercial commitment and shall be fulfilled entirely at the Reseller’s cost.' },
      { id: 'ra.s6.compliance', section: '6', label: 'Compliance (§6)', text: 'Each Party shall comply with all applicable laws, regulations, business ethics, and industry standards.' },
      { id: 'ra.s7.reporting', section: '7', label: 'Reporting (§7)', text: 'The Reseller shall provide the Supplier with sell-through reports on a monthly basis, no later than ten (10) calendar days after the end of each calendar month.' },
      { id: 'ra.s8.confidentiality', section: '8', label: 'Confidentiality (§8)', text: 'During the term of this Agreement, and for a period of three (3) years thereafter, the receiving Party undertakes not to disclose Confidential Information.' },
      { id: 'ra.liability_indirect', section: '10', label: 'Limitation of liability — indirect (§10)', text: 'Neither Party shall be liable for any indirect or consequential damages, including loss of profit, loss of revenue, or loss of anticipated savings, regardless of whether such damages were foreseeable.' },
      { id: 'ra.s10.cap', section: '10', label: 'Liability cap (§10)', text: 'The aggregate liability of either Party in any twelve (12) month period shall not exceed the total amount paid or payable by the Reseller for the Products during the preceding twelve (12) months.' },
      { id: 'ra.warranty_asis', section: '10', label: 'Products “as is” (§10)', text: 'The Reseller acknowledges that, except as expressly provided in this Agreement or in the Supplier’s standard warranty terms in Appendix 3, the Products are provided “as is” and the Supplier makes no warranties, express or implied, as to merchantability, fitness for a particular purpose, or non-infringement.' },
      { id: 'ra.s10.ip', section: '10', label: 'IP indemnity (§10)', text: 'The Supplier warrants that, to its knowledge, the sale of the Products in the Territory does not infringe any third-party intellectual property rights, and shall indemnify the Reseller against finally determined liability for the Products as supplied.' },
      { id: 'ra.s11.audit', section: '11', label: 'Audit (§11)', text: 'Audits shall not be conducted more than once per calendar year, on fourteen (14) days’ prior written notice.' },
      { id: 'ra.s13.term', section: '13', label: 'Term and termination (§13)', text: 'This Agreement shall enter into force when signed by both Parties and shall remain in force until terminated by either Party upon {{notice}} days’ written notice.' },
      { id: 'ra.s15.fm', section: '15', label: 'Force majeure (§15)', text: 'Neither Party is in default to the extent performance is delayed by a Force Majeure Event. If it continues for more than thirty (30) calendar days, either Party may terminate the affected obligations without liability.' },
      { id: 'ra.antibribery', section: '16', label: 'Anti-bribery (§16)', text: 'Both Parties shall comply with the Swedish Anti-Bribery Act and other applicable anti-bribery and anti-corruption laws.' },
      { id: 'ra.s17.law', section: '17', label: 'Governing law (§17)', text: 'This Agreement is governed by and construed in accordance with Swedish law. Disputes shall be finally settled by SCC arbitration. Seat: Malmö. Language: English.' },
    ],
    rb: [
      { id: 'rb.s2.payment', section: '2', label: 'Orders and payment (§2)', text: 'Orders through Vendora’s designated channel. Payment: {{pay}} days net in {{curr}}.' },
      { id: 'rb.s6.term', section: '6', label: 'Term (§6)', text: 'Terminable by either party on {{notice}} days’ written notice.' },
    ],
    da: [
      { id: 'da.s5.payment', section: '5', label: 'Payment (§5)', text: 'The Distributor shall pay for all ordered Products by bank transfer in {{curr}}, within {{pay}} days from the invoice date.' },
      { id: 'da.s6.warranty', section: '6', label: 'Warranty (§6)', text: 'The Supplier warrants that the Products are free from defects in materials and workmanship for a period of twenty-four (24) months from the date of delivery to the Distributor.' },
    ],
  };

  var ANNEX_DEFAULTS = {
    '1A': 'Invoice currency {{curr}}. Payment terms {{pay}} days net. Shipping {{inco}}.',
    '1B': 'The Reseller shall sell the Products only through the approved physical locations and websites. New points of sale require the Supplier’s prior written approval.',
    '2': 'All returns require a valid RMA number from rma@vendora.se, valid 10 days from issue. Warranty claims are settled by credit invoice.',
    '3': 'Warranty: 12 months from invoice date. Claims via rma@vendora.se. Inspection: discrepancies within 14 days; transport damage within 7 days.',
    '4': '',
    '5': '',
  };

  function clone(o) {
    return JSON.parse(JSON.stringify(o || {}));
  }
  function fill(template, data) {
    return String(template || '').replace(/\{\{(\w+)\}\}/g, function (_, k) {
      var v = data && data[k];
      return v == null || v === '' ? '' : String(v);
    });
  }
  function agreementData(agreement) {
    if (!agreement) return {};
    return agreement.data || agreement;
  }
  function catalog(type) {
    return CLAUSE_CATALOG[type] || CLAUSE_CATALOG.ra;
  }
  function clauseById(type, id) {
    var list = catalog(type);
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function normalizeAnnexId(raw) {
    var s = String(raw || '').trim().toLowerCase();
    s = s.replace(/^(appendix|annex|bilaga)\s+/i, '').replace(/\s+/g, '');
    if (s === '1a' || s === '1.a') return '1A';
    if (s === '1b' || s === '1.b') return '1B';
    if (s === '2' || s === '3' || s === '4' || s === '5') return s;
    return null;
  }
  function normalizeFieldId(raw) {
    var key = String(raw || '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
    var compact = key.replace(/\s+/g, '');
    return FIELD_ALIAS[key] || FIELD_ALIAS[compact] || FIELD_ALIAS[String(raw || '').trim()] || null;
  }
  function normalizeClauseId(raw) {
    var s = String(raw == null ? '' : raw).trim();
    s = s.replace(/^clause\s+/i, '').replace(/^section\s+/i, '').replace(/^§\s*/, '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(s)) return null;
    return s;
  }

  // Flat tool payload, legacy {clauseId,newText}, or the canonical object.
  function fromToolChange(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    if (raw.clauseId != null && raw.target == null && raw.target_kind == null && raw.targetKind == null) {
      return {
        target: { kind: 'clause', id: raw.clauseId },
        op: 'replace',
        oldText: raw.oldText != null ? raw.oldText : (raw.old_text || ''),
        newText: raw.newText != null ? raw.newText : (raw.new_text || ''),
        label: raw.label || '',
        rationale: raw.rationale || '',
        anchor: raw.anchor || '',
      };
    }
    var kind = raw.target_kind || raw.targetKind;
    var id = raw.target_id || raw.targetId;
    if (kind != null || id != null) {
      return {
        id: raw.id,
        checklistNr: raw.checklistNr,
        target: { kind: kind, id: id },
        op: raw.op,
        oldText: raw.old_text != null ? raw.old_text : (raw.oldText || ''),
        newText: raw.new_text != null ? raw.new_text : (raw.newText || ''),
        label: raw.label || '',
        rationale: raw.rationale || '',
        anchor: raw.anchor || '',
      };
    }
    return raw;
  }

  function validateProposal(raw) {
    var errors = [];
    var src = fromToolChange(raw);
    if (!src || typeof src !== 'object' || Array.isArray(src)) {
      return { ok: false, errors: ['Proposal must be an object'], proposal: null };
    }
    var targetIn = src.target;
    if (!targetIn || typeof targetIn !== 'object') errors.push('target is required');
    var kind = targetIn && String(targetIn.kind || '').trim().toLowerCase();
    if (KINDS.indexOf(kind) < 0) errors.push('target.kind must be clause, annex, or field');
    var op = String(src.op || '').trim().toLowerCase();
    if (OPS.indexOf(op) < 0) errors.push('op must be replace, insert, or delete');
    var oldText = src.oldText == null ? '' : String(src.oldText);
    var newText = src.newText == null ? '' : String(src.newText);
    var anchor = src.anchor == null ? '' : String(src.anchor);
    var label = src.label == null ? '' : String(src.label);
    var rationale = src.rationale == null ? '' : String(src.rationale);
    if (op === 'delete' && !oldText.trim() && kind !== 'field') errors.push('delete requires oldText');
    if ((op === 'replace' || op === 'insert') && !String(newText).trim()) errors.push(op + ' requires newText');
    if (oldText.length > 20000 || newText.length > 20000) errors.push('text is too long');

    var id = '';
    if (kind === 'annex') {
      id = normalizeAnnexId(targetIn && targetIn.id);
      if (!id) errors.push('annex id must be 1A, 1B, 2, 3, 4, or 5');
    } else if (kind === 'field') {
      id = normalizeFieldId(targetIn && targetIn.id);
      if (!id) errors.push('unknown cover-sheet field');
    } else if (kind === 'clause') {
      id = normalizeClauseId(targetIn && targetIn.id);
      if (!id) errors.push('clause id is missing or not a plain identifier');
    }
    if (op === 'insert' && kind === 'clause' && anchor && !normalizeClauseId(anchor) && !normalizeAnnexId(anchor)) {
      errors.push('anchor must be a clause or annex id');
    }
    if (errors.length) return { ok: false, errors: errors, proposal: null };
    var proposal = {
      id: src.id ? String(src.id).slice(0, 80) : '',
      checklistNr: src.checklistNr == null ? null : src.checklistNr,
      target: { kind: kind, id: id },
      op: op,
      oldText: oldText,
      newText: newText,
      label: label.slice(0, 200),
      rationale: rationale.slice(0, 2000),
      anchor: anchor ? (normalizeClauseId(anchor) || normalizeAnnexId(anchor) || '') : '',
    };
    if (!proposal.label) {
      proposal.label = kind === 'field' ? FIELDS[id].label
        : kind === 'annex' ? ('Annex ' + id)
        : id;
    }
    return { ok: true, errors: [], proposal: proposal };
  }

  function validateProposals(list) {
    var proposals = [];
    var rejected = [];
    var arr = Array.isArray(list) ? list : [];
    arr.forEach(function (raw, i) {
      var v = validateProposal(raw);
      if (!v.ok) rejected.push({ index: i, errors: v.errors, raw: raw });
      else proposals.push(v.proposal);
    });
    return { ok: rejected.length === 0, proposals: proposals, rejected: rejected };
  }

  function ensure(data) {
    data.clauseOverrides = data.clauseOverrides && typeof data.clauseOverrides === 'object' ? data.clauseOverrides : {};
    data.clauseInserts = Array.isArray(data.clauseInserts) ? data.clauseInserts : [];
    data.clauseDeletes = Array.isArray(data.clauseDeletes) ? data.clauseDeletes : [];
    data.annexOverrides = data.annexOverrides && typeof data.annexOverrides === 'object' ? data.annexOverrides : {};
    data.annexDeletes = Array.isArray(data.annexDeletes) ? data.annexDeletes : [];
    data.redlines = Array.isArray(data.redlines) ? data.redlines : [];
    return data;
  }
  function without(list, id) {
    return (list || []).filter(function (x) { return String(x && x.id != null ? x.id : x) !== id; });
  }

  function applyOne(data, p) {
    var kind = p.target.kind;
    var id = p.target.id;
    var redline = {
      target: { kind: kind, id: id },
      op: p.op,
      oldText: p.oldText,
      newText: p.op === 'delete' ? '' : p.newText,
      label: p.label,
      anchor: p.anchor || '',
    };
    if (kind === 'field') {
      data[id] = p.op === 'delete' ? '' : p.newText;
    } else if (kind === 'clause') {
      if (p.op === 'delete') {
        delete data.clauseOverrides[id];
        data.clauseInserts = without(data.clauseInserts, id);
        if (data.clauseDeletes.indexOf(id) < 0) data.clauseDeletes.push(id);
      } else if (p.op === 'insert') {
        data.clauseDeletes = data.clauseDeletes.filter(function (x) { return x !== id; });
        data.clauseInserts = without(data.clauseInserts, id);
        data.clauseInserts.push({ id: id, anchor: p.anchor || '', label: p.label, text: p.newText });
      } else {
        data.clauseDeletes = data.clauseDeletes.filter(function (x) { return x !== id; });
        data.clauseInserts = without(data.clauseInserts, id);
        data.clauseOverrides[id] = p.newText;
      }
    } else if (kind === 'annex') {
      if (p.op === 'delete') {
        delete data.annexOverrides[id];
        if (data.annexDeletes.indexOf(id) < 0) data.annexDeletes.push(id);
      } else {
        data.annexDeletes = data.annexDeletes.filter(function (x) { return x !== id; });
        data.annexOverrides[id] = p.newText;
      }
    }
    data.redlines.push(redline);
  }

  function applyProposals(data, proposals) {
    var checked = validateProposals(proposals);
    var next = ensure(clone(data));
    checked.proposals.forEach(function (p) { applyOne(next, p); });
    return {
      ok: checked.ok,
      data: next,
      applied: checked.proposals,
      rejected: checked.rejected,
      conflicts: consistencyCheck(next),
    };
  }

  function isDeleted(data, kind, id) {
    data = data || {};
    if (kind === 'clause') return (data.clauseDeletes || []).indexOf(id) >= 0;
    if (kind === 'annex') return (data.annexDeletes || []).indexOf(id) >= 0;
    return false;
  }
  function resolvedClauseText(data, id) {
    data = data || {};
    if (isDeleted(data, 'clause', id)) return '';
    var ov = data.clauseOverrides || {};
    if (ov[id] != null && String(ov[id]).trim()) return String(ov[id]);
    var ins = (data.clauseInserts || []).filter(function (c) { return c.id === id; });
    if (ins.length) return String(ins[ins.length - 1].text || '');
    var spec = clauseById(data._type || 'ra', id);
    return spec ? fill(spec.text, data) : '';
  }
  function resolvedAnnexText(data, id) {
    data = data || {};
    var nid = normalizeAnnexId(id) || id;
    if (isDeleted(data, 'annex', nid)) return '';
    var ov = data.annexOverrides || {};
    if (ov[nid] != null && String(ov[nid]).trim()) return String(ov[nid]);
    return fill(ANNEX_DEFAULTS[nid] || '', data);
  }
  function redlineFor(data, kind, id) {
    var list = (data && data.redlines) || [];
    var hit = null;
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (r && r.target && r.target.kind === kind && r.target.id === id) hit = r;
    }
    return hit;
  }

  function monthsIn(text) {
    var found = [];
    var re = /\b(\d{1,2})\b(?=\s*\)?\s*months?\b)/gi;
    var m;
    var s = String(text || '');
    while ((m = re.exec(s))) found.push(Number(m[1]));
    return found;
  }
  function warrantyMonths(text) {
    var s = String(text || '');
    var scoped = [];
    s.split(/(?<=\.)\s+/).forEach(function (part) {
      if (/warrant/i.test(part)) monthsIn(part).forEach(function (n) { scoped.push(n); });
    });
    if (!scoped.length && /months?\s+from\s+(the\s+)?(invoice|delivery)/i.test(s)) scoped = monthsIn(s);
    return unique(scoped);
  }
  function dayCounts(text) {
    var found = [];
    var re = /\b(\d{1,3})\b(?=\s*\)?\s*days?\b)/gi;
    var m;
    var s = String(text || '');
    while ((m = re.exec(s))) found.push(Number(m[1]));
    return unique(found);
  }
  function currenciesIn(text) {
    var found = [];
    var re = /\b(EUR|SEK|DKK|NOK|USD)\b/g;
    var m;
    var s = String(text || '');
    while ((m = re.exec(s))) if (found.indexOf(m[1]) < 0) found.push(m[1]);
    return found;
  }
  function unique(arr) {
    var out = [];
    arr.forEach(function (n) { if (out.indexOf(n) < 0) out.push(n); });
    return out;
  }
  function sameSet(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (b.indexOf(a[i]) < 0) return false;
    return true;
  }

  function paymentClauseIds(type) {
    if (type === 'da') return ['da.s5.payment'];
    if (type === 'rb') return ['rb.s2.payment'];
    return ['ra.s4.payment'];
  }

  function consistencyCheck(data) {
    data = data || {};
    var issues = [];
    var type = data._type || 'ra';

    var bodyMonths = [];
    var bodyWhere = [];
    catalog(type).forEach(function (c) {
      if (c.section !== '10' && !/warrant/i.test(c.id)) return;
      var text = (data.clauseOverrides || {})[c.id];
      if (text == null || !String(text).trim()) return;
      var months = warrantyMonths(text);
      if (!months.length) return;
      months.forEach(function (n) { if (bodyMonths.indexOf(n) < 0) bodyMonths.push(n); });
      bodyWhere.push(c.label);
    });
    // Inserted or unknown clause ids that talk about a warranty period (e.g. a new §10 sentence).
    Object.keys(data.clauseOverrides || {}).forEach(function (id) {
      if (clauseById(type, id) && (clauseById(type, id).section === '10' || /warrant/i.test(id))) return;
      if (!/warrant|s10|§10/i.test(id) && !/warrant/i.test(data.clauseOverrides[id] || '')) return;
      var months = warrantyMonths(data.clauseOverrides[id]);
      if (!months.length) return;
      if (!/warrant/i.test(id) && clauseById(type, id) && clauseById(type, id).section !== '10') {
        // Only count a free-text override when the id itself is a warranty/§10 target,
        // so a payment clause that happens to say "warranty" in passing is ignored.
        if (!/warrant|s10/i.test(id)) return;
      }
      months.forEach(function (n) { if (bodyMonths.indexOf(n) < 0) bodyMonths.push(n); });
      bodyWhere.push(id);
    });
    var annexText = resolvedAnnexText(data, '3');
    var annexMonths = warrantyMonths(annexText);
    if (bodyMonths.length && annexMonths.length && !sameSet(bodyMonths, annexMonths)) {
      issues.push({
        code: 'warranty_months',
        message: 'Warranty period disagrees: ' + (bodyWhere[0] || '§10') + ' says ' + bodyMonths.join(' and ') + ' months, annex 3 says ' + annexMonths.join(' and ') + ' months.',
        bodyMonths: bodyMonths,
        annexMonths: annexMonths,
      });
    }

    var fieldCurr = String(data.curr || '').trim().toUpperCase();
    var fieldDays = parseInt(data.pay, 10);
    var sources = [];
    paymentClauseIds(type).forEach(function (id) {
      var ov = (data.clauseOverrides || {})[id];
      if (ov != null && String(ov).trim()) sources.push({ where: '§4', text: String(ov) });
    });
    ['1A', '2'].forEach(function (id) {
      var ov = (data.annexOverrides || {})[id];
      if (ov != null && String(ov).trim()) sources.push({ where: 'annex ' + id, text: String(ov) });
    });
    sources.forEach(function (src) {
      var curs = currenciesIn(src.text);
      var days = dayCounts(src.text);
      var bits = [];
      if (fieldCurr && curs.length && curs.indexOf(fieldCurr) < 0) bits.push(curs.join('/'));
      if (!isNaN(fieldDays) && days.length && days.indexOf(fieldDays) < 0) bits.push(days.join(' and ') + ' days');
      if (!bits.length) return;
      var cover = [fieldCurr, !isNaN(fieldDays) ? fieldDays + ' days' : ''].filter(Boolean).join(', ');
      issues.push({
        code: 'payment_terms',
        message: 'Cover sheet is ' + (cover || 'blank') + ', but ' + src.where + ' says ' + bits.join(', ') + '.',
        where: src.where,
        coverCurrency: fieldCurr,
        coverDays: isNaN(fieldDays) ? null : fieldDays,
        textCurrencies: curs,
        textDays: days,
      });
    });
    return issues;
  }

  function catalogForPrompt(type, data) {
    data = data || {};
    return catalog(type).map(function (c) {
      var text = resolvedClauseText(Object.assign({ _type: type }, data), c.id) || fill(c.text, data);
      return { id: c.id, label: c.label, section: c.section, text: text };
    });
  }
  function catalogBlock(type, agreement, extraClauses) {
    var data = agreementData(agreement);
    var typeName = type || data._type || 'ra';
    var rows = catalogForPrompt(typeName, data);
    var byId = {};
    rows.forEach(function (r) { byId[r.id] = r; });
    (extraClauses || []).forEach(function (c) {
      if (!c || !c.id) return;
      if (byId[c.id]) byId[c.id].text = c.text || byId[c.id].text;
      else rows.push({ id: c.id, label: c.label || c.id, text: c.text || '' });
    });
    var clauseLines = rows.map(function (c) {
      return '[' + c.id + '] ' + (c.label || '') + ':\n"' + c.text + '"';
    }).join('\n\n');
    var fieldLines = Object.keys(FIELDS).map(function (id) {
      var cur = data[id] == null || data[id] === '' ? '(empty)' : String(data[id]);
      return '[' + id + '] ' + FIELDS[id].label + ' = ' + cur;
    }).join('\n');
    var annexLines = ANNEX_IDS.map(function (id) {
      var text = resolvedAnnexText(data, id);
      return '[annex ' + id + ']' + (text ? ':\n"' + text + '"' : ' (not in the template — use insert or replace to add it)');
    }).join('\n\n');
    return 'STRUCTURED EDITS — when you recommend concrete wording or a commercial term, call propose_changes. '
      + 'Every change is one item the user can approve. Do not tell the user to paste anything manually.\n'
      + 'Each change has target_kind (clause, annex, or field), target_id, op (replace, insert, or delete), old_text, new_text, label, rationale, and anchor.\n'
      + 'Use the exact clause id from the list below. For a NEW clause (for example 4A), op is insert, target_id is 4A, and anchor is the clause id it should follow.\n'
      + 'Annex target_id is 1A, 1B, 2, 3, 4, or 5. Field target_id is one of: ' + Object.keys(FIELDS).join(', ') + '.\n'
      + 'old_text quotes the current wording (empty string when there is none). new_text is the full replacement, the inserted text, or empty when op is delete. '
      + 'A delete uses the clause or annex id and puts the removed wording in old_text.\n\n'
      + 'COVER-SHEET AND FORM FIELDS (writing these updates the form, the cover sheet, and every clause that prints them):\n'
      + fieldLines + '\n\n'
      + 'CLAUSES:\n' + clauseLines + '\n\n'
      + 'ANNEXES:\n' + annexLines;
  }

  function pendingBody(data, renderedIds) {
    data = ensure(clone(data));
    var seen = {};
    (renderedIds || []).forEach(function (id) { seen[id] = 1; });
    var out = [];
    (data.clauseInserts || []).forEach(function (c) {
      if (!c || seen[c.id]) return;
      var rl = redlineFor(data, 'clause', c.id);
      out.push({
        kind: 'clause', id: c.id, op: 'insert', label: c.label || c.id, anchor: c.anchor || '',
        oldText: rl ? rl.oldText : '', newText: c.text, text: c.text,
      });
    });
    Object.keys(data.clauseOverrides || {}).forEach(function (id) {
      if (seen[id]) return;
      var rl = redlineFor(data, 'clause', id);
      out.push({
        kind: 'clause', id: id, op: 'replace', label: (rl && rl.label) || id, anchor: '',
        oldText: rl ? rl.oldText : '', newText: data.clauseOverrides[id], text: data.clauseOverrides[id],
      });
    });
    (data.clauseDeletes || []).forEach(function (id) {
      if (seen[id]) return;
      var rl = redlineFor(data, 'clause', id);
      if (!rl) return;
      out.push({
        kind: 'clause', id: id, op: 'delete', label: rl.label || id, anchor: '',
        oldText: rl.oldText, newText: '', text: '',
      });
    });
    return out;
  }
  function pendingAnnexes(data, renderedIds) {
    data = data || {};
    var seen = {};
    (renderedIds || []).forEach(function (id) { seen[String(id)] = 1; });
    var out = [];
    ANNEX_IDS.forEach(function (id) {
      if (seen[id]) return;
      var deleted = isDeleted(data, 'annex', id);
      var ov = (data.annexOverrides || {})[id];
      if (!deleted && (ov == null || !String(ov).trim())) return;
      var rl = redlineFor(data, 'annex', id);
      out.push({
        kind: 'annex', id: id, op: deleted ? 'delete' : ((rl && rl.op) || 'replace'),
        label: 'Annex ' + id,
        oldText: rl ? rl.oldText : fill(ANNEX_DEFAULTS[id] || '', data),
        newText: deleted ? '' : String(ov),
        text: deleted ? '' : String(ov),
      });
    });
    return out;
  }

  function deviationLines(data) {
    data = data || {};
    var lines = [];
    Object.keys(data.clauseOverrides || {}).forEach(function (id) {
      var t = String(data.clauseOverrides[id] || '').trim();
      if (!t) return;
      lines.push('Clause reworded — ' + id + ': “' + (t.length > 220 ? t.slice(0, 220) + '…' : t) + '”');
    });
    (data.clauseInserts || []).forEach(function (c) {
      lines.push('Clause added — ' + (c.label || c.id));
    });
    (data.clauseDeletes || []).forEach(function (id) { lines.push('Clause deleted — ' + id); });
    Object.keys(data.annexOverrides || {}).forEach(function (id) {
      lines.push('Annex ' + id + ' reworded');
    });
    (data.annexDeletes || []).forEach(function (id) { lines.push('Annex ' + id + ' deleted'); });
    return lines;
  }

  function xmlEscape(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function trackedChangeXml(opts) {
    opts = opts || {};
    var author = xmlEscape(opts.author || 'Vendora Contract Lawyer');
    var date = xmlEscape(opts.date || '2026-10-13T00:00:00Z');
    var id = Number(opts.id || 1);
    var parts = [];
    if (opts.oldText) {
      parts.push('<w:del w:id="' + id + '" w:author="' + author + '" w:date="' + date + '"><w:r><w:delText xml:space="preserve">' + xmlEscape(opts.oldText) + '</w:delText></w:r></w:del>');
    }
    if (opts.newText) {
      parts.push('<w:ins w:id="' + (id + 1) + '" w:author="' + author + '" w:date="' + date + '"><w:r><w:t xml:space="preserve">' + xmlEscape(opts.newText) + '</w:t></w:r></w:ins>');
    }
    return parts.join('');
  }

  function redlineSegments(oldText, newText) {
    var a = String(oldText || '').split(/(\s+)/);
    var b = String(newText || '').split(/(\s+)/);
    var n = a.length, m = b.length;
    // Word-level LCS. Cap the grid so a pathological paragraph cannot explode.
    if (n * m > 40000) {
      var segs = [];
      if (oldText) segs.push({ type: 'del', text: String(oldText) });
      if (newText) segs.push({ type: 'ins', text: String(newText) });
      return segs;
    }
    var dp = new Array(n + 1);
    for (var i = 0; i <= n; i++) {
      dp[i] = new Uint16Array(m + 1);
    }
    for (i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    var out = [];
    function push(type, text) {
      if (!text) return;
      var last = out[out.length - 1];
      if (last && last.type === type) last.text += text;
      else out.push({ type: type, text: text });
    }
    i = 0; j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { push('eq', a[i]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { push('del', a[i]); i++; }
      else { push('ins', b[j]); j++; }
    }
    while (i < n) { push('del', a[i]); i++; }
    while (j < m) { push('ins', b[j]); j++; }
    return out;
  }

  function crc32(buf) {
    var table = crc32.table;
    if (!table) {
      table = crc32.table = new Uint32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
      }
    }
    var crc = 0xffffffff;
    for (var i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
  function u16(n) { var b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff, 0); return b; }
  function u32(n) { var b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }

  // Minimal .docx (stored, uncompressed) whose document.xml contains the redlines.
  function buildTrackedDocx(paragraphs, meta) {
    meta = meta || {};
    var author = meta.author || 'Vendora Contract Lawyer';
    var date = meta.date || '2026-10-13T00:00:00Z';
    var body = (paragraphs || []).map(function (p, i) {
      return '<w:p>' + trackedChangeXml({
        id: i * 2 + 1, author: author, date: date, oldText: p.oldText, newText: p.newText,
      }) + '</w:p>';
    }).join('');
    var documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
      + body + '<w:sectPr/></w:body></w:document>';
    var settingsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:trackRevisions/></w:settings>';
    var contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>'
      + '</Types>';
    var rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
      + '</Relationships>';
    var docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>'
      + '</Relationships>';
    return zipStore([
      { name: '[Content_Types].xml', data: Buffer.from(contentTypes) },
      { name: '_rels/.rels', data: Buffer.from(rels) },
      { name: 'word/document.xml', data: Buffer.from(documentXml) },
      { name: 'word/settings.xml', data: Buffer.from(settingsXml) },
      { name: 'word/_rels/document.xml.rels', data: Buffer.from(docRels) },
    ]);
  }
  function zipStore(files) {
    var locals = [];
    var centrals = [];
    var offset = 0;
    files.forEach(function (f) {
      var name = Buffer.from(f.name);
      var data = f.data;
      var crc = crc32(data);
      var local = Buffer.concat([
        u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0),
        name, data,
      ]);
      var central = Buffer.concat([
        u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0),
        u16(0), u16(0), u32(0), u32(offset), name,
      ]);
      locals.push(local);
      centrals.push(central);
      offset += local.length;
    });
    var centralBuf = Buffer.concat(centrals);
    var end = Buffer.concat([
      u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
      u32(centralBuf.length), u32(offset), u16(0),
    ]);
    return Buffer.concat(locals.concat(centrals, [end]));
  }
  function docxParagraphsFromData(data) {
    var paras = [];
    (data.redlines || []).forEach(function (r) {
      if (!r) return;
      paras.push({ oldText: r.oldText || '', newText: r.newText || '', label: r.label || '' });
    });
    return paras;
  }

  var TOOL_CHANGE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
      target_kind: { type: 'string', enum: ['clause', 'annex', 'field'] },
      target_id: { type: 'string', description: 'Clause id (ra.s4.payment, 4A, …), annex id (1A, 1B, 2, 3, 4, 5), or field id (curr, pay, inco, name, terr, date, sig_name, …).' },
      op: { type: 'string', enum: ['replace', 'insert', 'delete'] },
      old_text: { type: 'string', description: 'Current wording being replaced or deleted. Empty string if there is none.' },
      new_text: { type: 'string', description: 'Replacement or inserted wording. Empty string when op is delete.' },
      label: { type: 'string', description: 'Short label shown on the redline, e.g. "Payment (§4)" or "§4A Parent guarantee".' },
      rationale: { type: 'string', description: 'One or two sentences on why, from Vendora’s side.' },
      anchor: { type: 'string', description: 'For insert: clause or annex id to insert after. Empty string otherwise.' },
    },
    required: ['target_kind', 'target_id', 'op', 'old_text', 'new_text', 'label', 'rationale', 'anchor'],
  };
  var PROPOSE_CHANGES_TOOL = {
    name: 'propose_changes',
    description: 'Propose structured edits to Vendora’s agreement. Call once with every concrete change: any clause, a new clause (for example 4A), an annex (1A, 1B, 2, 3, 4, 5), or a cover-sheet field (currency, payment days, shipping/incoterm, reseller name, territory, effective date, signatory). The user approves each item; do not ask them to paste.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: { changes: { type: 'array', items: TOOL_CHANGE_SCHEMA } },
      required: ['changes'],
    },
    strict: true,
  };

  return {
    OPS: OPS,
    KINDS: KINDS,
    ANNEX_IDS: ANNEX_IDS,
    FIELDS: FIELDS,
    FIELD_ALIAS: FIELD_ALIAS,
    CLAUSE_CATALOG: CLAUSE_CATALOG,
    ANNEX_DEFAULTS: ANNEX_DEFAULTS,
    TOOL_CHANGE_SCHEMA: TOOL_CHANGE_SCHEMA,
    PROPOSE_CHANGES_TOOL: PROPOSE_CHANGES_TOOL,
    fill: fill,
    catalog: catalog,
    catalogForPrompt: catalogForPrompt,
    catalogBlock: catalogBlock,
    fromToolChange: fromToolChange,
    validateProposal: validateProposal,
    validateProposals: validateProposals,
    applyProposals: applyProposals,
    isDeleted: isDeleted,
    resolvedClauseText: resolvedClauseText,
    resolvedAnnexText: resolvedAnnexText,
    redlineFor: redlineFor,
    consistencyCheck: consistencyCheck,
    warrantyMonths: warrantyMonths,
    pendingBody: pendingBody,
    pendingAnnexes: pendingAnnexes,
    deviationLines: deviationLines,
    redlineSegments: redlineSegments,
    trackedChangeXml: trackedChangeXml,
    buildTrackedDocx: buildTrackedDocx,
    docxParagraphsFromData: docxParagraphsFromData,
    normalizeAnnexId: normalizeAnnexId,
    normalizeFieldId: normalizeFieldId,
    normalizeClauseId: normalizeClauseId,
  };
});
