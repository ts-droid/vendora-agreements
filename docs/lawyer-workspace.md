# Saved lawyer workspace and related document drafts

## User flow

From **Archive → Agreements**, select **Avtalsadvokaten** on the desired record. This opens a separate workspace bound to that agreement's saved data, type and revision. The same action is available for signed agreements: drafting a supplement must not require unlocking or editing the original. The ordinary form, proposal application and signing workflow remain separate.

The workspace offers **Bilaga / appendix**, **Tilläggsavtal**, **Anslutningsavtal** and **Nytt grundavtal**. Describe the purpose in chat. Documents returned through the drafting tool are persisted as separate draft versions and shown below the source agreement. Mark a document as reference material before asking for a supplemental agreement that refers to it. References identify the exact document ID, number, version and content hash; they never silently advance to a later revision. Reworking a selected document creates a new immutable version.

An internally reviewed draft is still **not signed**, and linking a draft to a contract is not either party's assent. These documents can be reviewed and downloaded as Word drafts; this feature does not automatically send them or run a new digital-signature process. The original agreement's signature must never be copied into the new document. All exported drafts are explicitly marked as unsigned.

## Memory and scope

- Conversations are stored in PostgreSQL per thread and agreement. The ordinary saved-agreement chat drawer uses the same persisted history. The recent-agreement selector contains the ten most recently **created** accessible agreements, not ten entire documents injected into every AI call. Older agreements remain available from the archive.
- AI input is the selected case plus its saved conversation and explicitly checked reference drafts. Neither cases nor unrelated counterparties are automatically mixed. Access mirrors archive ownership, admin privileges and the distribution-agreement restriction. Standalone threads have no parent contract.
- Full stored conversational text is retained rather than silently sliced to twenty messages. At 300 messages or roughly 180,000 input-history characters the app explicitly requests a new conversation; it does not erase the previous one. Threads with draft documents cannot be casually deleted because they carry document provenance.
- Existing chat from before deployment was only in browser memory. It cannot be recovered after that page has been discarded. A still-visible old chat can be explicitly imported into a new thread with confirmation. It is not automatically imported into an arbitrary counterparty's case.
- A thread pins the source data seen at creation. A change to that source blocks further generation in the old thread; the history remains readable and the user starts a new conversation with the current source. Draft exports warn about stale source data. The source is saved structured contract data, not verification of the uploaded signed original. Review binding amendments against that signed original before use.
- None of this promotes a customer-specific concession into the shared playbook or standard template.

## Duplicate type selector

For a saved agreement, its stored type is authoritative. The old drawer now shares a single type state between chat and document verification; the redundant selector is hidden and populated from the same value. Unsaved work asks for the relationship once. The workspace derives type from its selected source, or asks once when starting an independent draft. Existing server-side type checks remain in place.

## Safety / persistence

New tables: `lawyer_threads`, `lawyer_documents`. No backfill or rewrite of agreement contents/signatures. Model responses, conversation turns and generated drafts commit atomically. Requests carry an idempotency key and expected conversation revision. Row locking plus an expiring in-flight lease prevents concurrent history forks. Ownership and source freshness are rechecked after AI work. Failed model calls release the lease without saving partial turns or documents. Related documents use an immutable content hash and exact references. Separate drafts have no endpoint that can mark them signed.

## Verification

Unit tests exercise validation, type selection, history boundaries, reference scoping and actual AI tool plumbing with a stub provider. An isolated Chrome/PostgreSQL/API integration test opens the archive action, creates an appendix and linked addendum, reloads memory, exports real Word content, preserves signed-parent data, creates a new draft revision without retargeting old references, checks access control and stale-source/concurrent-write handling. AI and email are not live in CI. Existing workflow and 50 MB tests remain enabled.
