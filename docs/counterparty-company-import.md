# Company details from the comparison document

The initial **Compare and propose changes** upload also requests company details in the same model call. It works for supplier/distribution (da), reseller (ra), and simplified reseller (rb). No additional upload, external company-register lookup or unrelated customer context is used.

## User flow

The saved review shows **Företagsuppgifter från det uppladdade avtalet** before the legal proposals. The card identifies the intended legal entity and role. Each field shows the existing value, extracted value and source quote/reference. Empty high-confidence fields with text-verified quotes are suggested for selection. Existing values, uncertain fields and native-PDF quotes are not preselected. The user must confirm the correct legal entity and explicitly approve selected fields, or retain existing details. Approval updates the current case's structured fields, archive company name, form and next generated Word agreement. It does not update the shared standard, an unrelated case or a signed document.

Supported details: legal company name, registration number, VAT/Tax ID, explicit incorporation country and registered address; supplier EORI and parent company; signatory fields supported by reseller templates and role-specific supplier/reseller contact fields. Supplier management/signatory contacts use the existing Appendix 3 contact fields. A generic contact is not automatically a signing representative. An unknown registration country must not be inferred from a phone number or delivery territory.

## Controls

- Source-only schema: no copying from Vendora's own benchmark or current form. Unknown fields (bank details, payment terms, Vendora invoice email, signatures) cannot be imported.
- Ambiguous parties, wrong supplier/customer role and Vendora's own identity are blocked. Missing data remains missing. Conflicting values for a field are blocked instead of picking one.
- For extracted text, quotes and values must be present in the uploaded text. For native PDF, quotes have not been mechanically verified and require explicit selection after checking the original. A source quote and model confidence are not a company-register or signatory-authority verification.
- Suggestions are stored against the review/document source hash. Decisions record selected fields, old/new values, actor and revision. Idempotent commands, optimistic versions and row locks prevent stale overwrites and duplicate approvals.
- Manual form edits are saved before import; if a target changed after extraction, import stops. Changes affecting an already customised clause also stop for separate review.
- All identity write paths reject invited, approval-pending and signed/locked cases. Source evidence remains internal and does not go to the customer or Word output.
- User must accept or skip a pending import before inviting, running a new comparison or requesting signature. Historical reviews without extraction remain compatible.
- This does not automatically change email recipients, accept commercial changes or send/sign an agreement.

## Word output

The reseller templates previously collected VAT/Tax ID but omitted it from their generated parties tables. Both reseller exports now include a VAT/Tax ID line when supplied, as the supplier template already does. Missing VAT adds no placeholder or new line. Existing legal wording and Vendora's invoice@vendora.se remain unchanged. The end-to-end test verifies the actual exported text rather than only the saved form.

## Tests

Unit tests cover all three agreement types, source attribution, malformed/ambiguous output, wrong-party prevention, field allowlists, stale targets, idempotency, non-mutation and signing guards. An AI plumbing test runs the actual review code with a stub provider and confirms one call containing the extraction schema/instruction. The existing Chrome/PostgreSQL end-to-end test is extended to upload synthetic details, approve them separately, verify persisted archive/form values and actual Word output, then complete both negotiation rounds and signing gates. AI and email are mocked; no production customer records or messages are used.
