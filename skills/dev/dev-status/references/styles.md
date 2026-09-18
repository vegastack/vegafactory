# Chronicle styles

dev.md's `chronicle-style:` knob picks the voice (`plain` default · `story` · `witty`) and `emoji:` the emoji budget (`none` default · `sparing`). Tone changes; the facts and the length do not.

## The rule, every style

- Domain keywords and terms stay exact — file names, flags, labels, knob names and issue numbers are copied, never paraphrased, because the operator searches the chronicle for the terms they remember.
- Every factual field (What, Why, Changed, Decisions) says what it means in its first clause, so a reader skimming one field gets the fact.
- How it went stays under about 100 words unless something genuinely fought back — a real fight earns the space; a smooth build does not.
- Entries cover the substance and stop: no filler, no restated summaries, no closing moral.

## plain

Short declarative sentences and no figures of speech. The default, because it reads the same to every reader in every month.

## story

Narrative sentences in plain words: cause then effect, what was tried then what held. The same facts told in order, with no metaphor.

## witty

Wit lives in two places only: the entry title and the first sentence of How it went; everywhere else the entry reads as plain. The boundary is mannered prose: metaphor and flourish that display the writer rather than convey the idea are out; when a literal phrase is available, use it.

## Emoji

`none`: no emoji anywhere. `sparing`: at most one per entry, in the title or the footer, never inside a field's facts — a fact line with an emoji reads as decoration where the reader wanted the fact.

## Worked examples

All three tell the same fictional change so the styles compare: project ledgerly, issue [#42](https://github.com/example/ledgerly/issues/42), branch `feat/42-invoice-reminders` — a nightly `send-reminders` job on pg-boss at `06:00 UTC`, a `reminderAt` column on invoices, a `--dry-run` flag; the first nightly run sent nothing because the job compared `reminderAt` in server-local time, fixed on the second attempt by storing and comparing in UTC.

### Example — plain

<example>
## 14-08-2026 — Invoice reminders now chase late payers on their own ([#42](https://github.com/example/ledgerly/issues/42))

- **What:** Overdue invoices get a reminder email without anyone remembering to send one. A nightly `send-reminders` job runs on pg-boss at `06:00 UTC`, reads each invoice's new `reminderAt` column, and emails the customer when the time has passed. `send-reminders --dry-run` prints who would be emailed and sends nothing.
- **Why:** Reminders were sent by hand from a spreadsheet, so late invoices slipped whenever the person who owned the spreadsheet was out.
- **How it went:** The first nightly run sent nothing. The job compared `reminderAt` in server-local time while the column held UTC, so every invoice looked a few hours early. The second attempt stores and compares in UTC, and `--dry-run` was added so the next mistake shows up in a log before it reaches a customer.
- **Changed:** `reminderAt` column on invoices · `send-reminders` job on pg-boss, nightly at `06:00 UTC` · `--dry-run` flag on the job
- **Decisions:** none

— approved by (avery) · built by claude · branch feat/42-invoice-reminders
<rationale>Every field states its fact first and How it went names the fight in two sentences.</rationale>
</example>

### Example — story

<example>
## 14-08-2026 — Invoice reminders now chase late payers on their own ([#42](https://github.com/example/ledgerly/issues/42))

- **What:** Late invoices used to wait for a person; now a nightly `send-reminders` job on pg-boss runs at `06:00 UTC`, checks each invoice's new `reminderAt` column, and emails the customer once that time has passed. Anyone unsure what tomorrow's run will do can run `send-reminders --dry-run` and read the list without sending a thing.
- **Why:** Reminders came from a hand-kept spreadsheet, so whenever its owner was out, late invoices went quiet and stayed that way.
- **How it went:** The job shipped, the first night came, and nothing went out. The cause was a time-zone mismatch: the job compared `reminderAt` in server-local time while the column held UTC, so every invoice looked a few hours early and was skipped. The second attempt stores and compares in UTC, and `--dry-run` was added so the next surprise appears in a log instead of a customer's inbox.
- **Changed:** `reminderAt` column on invoices · `send-reminders` job on pg-boss, nightly at `06:00 UTC` · `--dry-run` flag on the job
- **Decisions:** none

— approved by (avery) · built by claude · branch feat/42-invoice-reminders
<rationale>The same facts in cause-then-effect order, still no metaphor.</rationale>
</example>

### Example — witty

<example>
## 14-08-2026 — Invoice reminders now nag late payers so nobody else has to ([#42](https://github.com/example/ledgerly/issues/42))

- **What:** Overdue invoices get a reminder email without anyone remembering to send one. A nightly `send-reminders` job runs on pg-boss at `06:00 UTC`, reads each invoice's new `reminderAt` column, and emails the customer when the time has passed. `send-reminders --dry-run` prints who would be emailed and sends nothing.
- **Why:** Reminders were sent by hand from a spreadsheet, so late invoices slipped whenever the person who owned the spreadsheet was out.
- **How it went:** The job's first night on duty, it reminded exactly nobody. The job compared `reminderAt` in server-local time while the column held UTC, so every invoice looked a few hours early. The second attempt stores and compares in UTC, and `--dry-run` was added so the next mistake shows up in a log before it reaches a customer.
- **Changed:** `reminderAt` column on invoices · `send-reminders` job on pg-boss, nightly at `06:00 UTC` · `--dry-run` flag on the job
- **Decisions:** none

— approved by (avery) · built by claude · branch feat/42-invoice-reminders
<rationale>The joke sits in the title and the opener only; the fields below are word-for-word plain.</rationale>
</example>
