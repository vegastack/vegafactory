<!-- vsk:v1 type=brief rev=1 scope=small -->
**Scope:** small — the invoice list already exists; this adds one export path beside it.

## Outcome

Operators can download the filtered invoice list as CSV from the invoices page. The file carries the same columns the table shows (number, customer, issued, due, total, status) in the table's current sort order, and respects the active status filter.

## Out of scope

- PDF or XLSX export.
- Scheduled or emailed exports.

## Rules and edge cases

- An empty filter result downloads a header-only file, never an error.
- Amounts are written as plain decimals (`1234.50`), no currency symbol.
- Dates use ISO `YYYY-MM-DD`.

## Approach and touch points

Extend the existing `lib/export.ts` helper (it already serialises the invoice table for the print view) with a `toCsv(rows)` function, and add a `GET /api/invoices/export.csv` route in `server/routes/invoices.ts` that reuses the list query. The button goes next to the filter bar in `app/invoices/page.tsx`.
**Version impact:** minor — new user-facing capability.

## Tests and acceptance

- `toCsv` unit tests: quoting of commas and newlines inside customer names; the header-only case.
- Route test: the filter query string is honoured; content type is `text/csv`.

## Risks and stop conditions

- If the list query cannot be reused without duplicating the filter logic, stop and hand back.

## Assumptions

- None open — `(kmanojkumar)` approved the CSV column set on 01-09-2026.

---

Repository tree at approval (from `tree -L 2 --gitignore`):

```
.
├── app
│   ├── invoices
│   └── layout.tsx
├── lib
│   ├── db.ts
│   ├── format.ts
│   └── print.ts
├── server
│   ├── routes
│   └── index.ts
├── tests
│   ├── lib
│   └── routes
└── package.json
```
