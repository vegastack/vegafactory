# Chronicle — vegastack/billing

The project's story, newest first: what got built, why, and how it went — for the operator's future recall. Format home: the dev-status skill.

## 28-08-2026 — Invoices can be filtered by status ([#22](https://github.com/vegastack/billing/issues/22))

- **What:** the invoices page has a status filter (draft, sent, overdue, paid) that survives a reload through the URL, and the list query honours it server-side.
- **Why:** operators were scrolling past hundreds of paid invoices to find the overdue ones.
- **How it went:** smooth, except the filter first lived in component state and was lost on reload; moving it to the URL cost one extra task.
- **Changed:** `app/invoices/page.tsx` filter bar · `server/routes/invoices.ts` list query · one Bun test per status value.
- **Decisions:** none

— approved by (kmanojkumar) · built by claude · branch feat/22-invoice-status-filter

## 21-08-2026 — Customers get emailed a PDF when an invoice is sent ([#17](https://github.com/vegastack/billing/issues/17))

- **What:** sending an invoice now renders a PDF and emails it through Resend, with the send recorded on the invoice.
- **Why:** the team was downloading PDFs and attaching them by hand.
- **How it went:** the PDF renderer fought back — the first library needed a headless browser on the server, which the deploy target does not have; it was swapped for a pure-Node renderer halfway through, and the plan was revised (v2).
- **Changed:** `server/email/templates/invoice-sent.tsx` · `lib/pdf.ts` · `server/routes/invoices.ts` send handler · the `sentAt` column.
- **Decisions:** 21-08-2026 (kmanojkumar) — PDF rendering stays pure Node; no headless browser on the server.

— approved by (kmanojkumar) · built by claude · branch feat/17-invoice-pdf-email

## 14-08-2026 — The billing repo runs on the dev workflow ([#1](https://github.com/vegastack/billing/issues/1))

- **What:** `.vegastack/dev.md`, the workflow labels, and the AGENTS.md block exist; issues flow through intake, plan, implement, and ship.
- **Why:** the first two features were built from chat messages nobody could find later.
- **How it went:** smooth; the only surprise was that the repo had no branch protection, which was enabled the same day.
- **Changed:** `.vegastack/dev.md` · `AGENTS.md` · ten labels · branch protection on main.
- **Decisions:** none

— approved by (kmanojkumar) · built by claude · branch chore/dev-setup
