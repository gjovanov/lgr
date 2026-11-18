# FR-32 — Code health: a type-check and a linter in CI, a browser smoke on pull requests, dead code out, one way to the database

| | |
|---|---|
| **Status** | Specified 2026-11-16. Nothing is built. The defaults in §9 stand unless the owner answers otherwise on the issue. |
| **Builds on** | `ci.yml` (the always-on gate) and `e2e-nightly.yml` (#365, the whole Playwright suite), the route-table suites (tenant isolation, route and read permission), `dal` and `dal-mongo`, the known-items list in `CLAUDE.md`, #675 |
| **Touches** | Every package gets a type-check configuration. `.github/workflows` (two new jobs). `dal`, `dal-mongo` and `db` (entity types, `select`, `session`). `services` (dead DAO classes out, document services). `invoicing-api` (the largest controller). `ui-shared`, `ui-shell` and the `*-ui` packages (dead files out, typed API modules, the two order forms). `reporting` (one dependency moves). `portal-api` (file deletion, the auth plugin). `CLAUDE.md` and `docs/` |
| **Tracking** | [gjovanov/lgr#797](https://github.com/gjovanov/lgr/issues/797) |
| **Code anchors** | origin/master `cb7d18c5` (2026-11-16), re-read and re-counted at `cb039b1a`. Anchors, not gospel. |
| **Batch** | One of the four FRs of the 2026-11-16 audit: [FR-29](FR-29-atomic-bookings-records-runtime.md) reliability, [FR-30](FR-30-speed-at-shop-volume.md) speed, [FR-31](FR-31-forms-and-lists-that-do-not-lose-or-mislead.md) forms and lists, FR-32 (this one). [`README.md`](README.md) maps every finding to its FR. |

## 0. The request (owner, 2026-11-16)

> identify what are the technical debts, code smells, performance bottle-necks and suboptimal UX aspects of the app and propose a solution to each of them

and, after reading the findings: create the FRs, grouped as much as makes sense.

**How the audit was done.** `cb7d18c5` was read and counted by pattern, and a strict type-check was run once, by hand, over everything the backend imports. The other three FRs of the batch hold the defects that were found by running the app. This one holds the reasons such defects reach master, and the code that makes the next change slower than it has to be.

**This FR** holds twelve findings. Each keeps the id it had in the audit.

**Evidence.** *measured*: a tool was run (the strict type-check, at `cb7d18c5`). *counted*: a pattern count over `.ts` and `.vue` files outside the tests, made again at `cb039b1a`. *read*.

| Finding | In short | Evidence | Today | Requirements | Slice |
|---|---|---|---|---|---|
| T1 | Nothing type-checks or lints the code | measured | §1.1 | FR-32.1 to .5, .7, .8 | A |
| C3 | Errors are swallowed | counted | §1.1 | FR-32.5 | A |
| T2 | The browser tests run only at night | read | §1.2 | FR-32.6 | A |
| T4 | Code that is dead and looks live | counted | §1.3 | FR-32.9, .10 | B |
| T9 | Known items that are still open | read | §1.3 | FR-32.11, .12 | B |
| T8 | `CLAUDE.md` is 5 640 lines | measured | §1.3 | FR-32.13 | B |
| T3 | Three ways to reach the database, and types written by hand | counted | §1.4 | FR-32.14 to .16 | C |
| C2 | `any` as the default type | counted | §1.4 | FR-32.17 | C |
| T5 | Write routes that declare no body schema | the repository's own open item | §1.5 | FR-32.18 to .20 | D |
| C1 | Very large files and handlers | measured | §1.6 | FR-32.21 to .23, .26 | E |
| C4 | HTTP calls inside components, with the answer's shape guessed | counted | §1.6 | FR-32.24 | E |
| C5 | Copies | read | §1.6 | FR-32.25 | E |

**Where to look.** Slice A is the one that pays for the others: a type-check would have caught sixteen audit rows stored without their content ([FR-29](FR-29-atomic-bookings-records-runtime.md).19) the day they were written. FR-32.14 is small and two other FRs wait for it. Slices C and E are long, and are meant to be done a file at a time, as the files are touched.

## 1. What is wrong today

### 1.1 Nothing checks the code before it runs (T1, C3)

- 26 of the 31 packages have no `tsconfig.json`. There is no linter and no formatter configuration in the repository. No script and no workflow runs `tsc` or `vue-tsc`. `bun run build` is `vite build`, which strips types without checking them.
- **A strict type-check, run once by hand** over the backend's import graph, reported 242 errors:
  - 78 are "`user` is possibly null" in handlers under the `isSignIn` macro. The macro's type does not say what the route guarantees.
  - 23 are "type instantiation is excessively deep" on long Elysia route chains.
  - 9 were artefacts of the ad-hoc configuration.
  - The rest include real defects:
    - sixteen audit entries that are stored without their content ([FR-29](FR-29-atomic-bookings-records-runtime.md) §1.5);
    - four repositories that the audit entity search reads and that do not exist ([FR-29](FR-29-atomic-bookings-records-runtime.md).22);
    - two fields that `stripe.service.ts` reads from a subscription and from an invoice, and that the installed Stripe SDK (20.4.1) no longer has in its types.
- **Swallowed errors (C3).**
  - UI packages: 149 catch blocks that are empty or hold only a comment, in about 80 files, and 24 `.catch()` handlers that take no error.
  - Backend packages: 72 such blocks and 140 such handlers, most of them in `services`.
  - Many are deliberate and say why. Two findings of this batch are the kind that were not: a document that failed to load and looks like a draft ([FR-31](FR-31-forms-and-lists-that-do-not-lose-or-mislead.md).6), and the audit entry of a system action ([FR-29](FR-29-atomic-bookings-records-runtime.md).20).

### 1.2 The browser tests run at night (T2)

- `e2e-nightly.yml` runs the whole Playwright suite at 02:17 UTC. A pull request merges on unit and integration tests.
- The workflow says why: the suite holds a runner for about fifteen minutes against CI's five. A branch can be run by hand.
- Four findings of this batch are of the kind only a browser shows: the guard that a save switches off, the late search answer, the missing document that looks like a draft, the list that asks twice ([FR-31](FR-31-forms-and-lists-that-do-not-lose-or-mislead.md).1, .4, .6 and [FR-30](FR-30-speed-at-shop-volume.md).6). A regression of that kind is seen the next morning, after it is on master.

### 1.3 Dead code, open items, and a rules file that became a history (T4, T9, T8)

- **Dead code (T4).**
  - 24 DAO classes are imported only by tests: the 23 under `services/src/dao/{accounting,invoicing,payroll,warehouse}/` and `org-app.dao.ts`. One of them holds the repository's only `$text` query ([FR-30](FR-30-speed-at-shop-volume.md).4).
  - Four DAO classes are live (organization, user, invite, sign-in code). Three of them extend the base class that the open item "BaseDao read methods missing `.lean()`", rated high in `CLAUDE.md`, is about.
  - Eight files in `ui-shared` are imported by nothing: `AuditTrail.vue`, `DataTable.vue`, `DetailSidebar.vue`, `FileUpload.vue`, `ServerDataTable.vue`, `usePriceResolver.ts`, `useStatusLabel.ts`, `useWebSocket.ts`.
  - About seventy route records carry a `meta.breadcrumb`. `AppShell` never mounts `AppBreadcrumb`, so nothing renders them; two comments in the code say so.
  - `sendNotification` (`portal-api/src/websocket/ws.server.ts`) is called only by a test.
  - `md-to-pdf` is a production dependency of `reporting`. One helper loads it, and that helper exists as the reference of a parity test.
- **Open items (T9).** `CLAUDE.md` lists them as open:
  - deleting a file removes its row and leaves the stored file (`file.controller.ts`);
  - the payroll run's overtime is always 0, and so are its bonuses and allowances (`payroll.service.ts`);
  - the `TODO` comments it counts, most of them export stubs in payroll.
- **`CLAUDE.md` (T8)** is 5 640 lines. It is loaded into every agent session that works in the repository. Most of it is the history of what was built, and the rules and traps a session needs sit between the release notes.

### 1.4 Reaching the database (T3, C2)

- **Three ways, and a fourth.** About 520 calls go through a repository (`getRepos()`), about 1 780 straight to a Mongoose model (1 392 of them in `services`), and 64 to the raw driver (29 of them in migrations, where that is right). Four DAO classes are a fourth way, for four portal entities (§1.3).
- **Half the models.** `dal-mongo/src/index.ts` registers a repository for 48 of the 100 model files.
- **Types written by hand.** The repository's `IInvoice` names 43 fields; the model that stores an invoice is 768 lines. Nothing ties the two together.
- **What the interface lacks.** No projection, so a list cannot ask for rows ([FR-30](FR-30-speed-at-shop-volume.md).7). No session, so a booking cannot run in a transaction ([FR-29](FR-29-atomic-bookings-records-runtime.md).3).
- **What it was for.** The DAL was built so that a second backend could implement it. That backend was retired with the desktop's local mode (FR-14.34).
- **`any` (C2).** Outside the tests: 2 173 `as any` (919 in `services`, 570 in `invoicing-api`) and 3 664 `: any` (1 821 in `services`). The tests hold about twice as many again, and are not the concern. About 180 of `invoicing-api`'s casts sit on an object handed to a call, most often a filter for a repository, where the cast hides what the repository's types would have said.

### 1.5 Write routes without a body schema (T5)

- This is the repository's own open item, re-checked on 2026-11-11 and rated low: "72 of the 272 write routes declare no body schema; most of the others are actions that read no body".
- The item says what is closed: a body can no longer name a field it should not (S-25, S-35, S-36).
- And what is left, inside the caller's own module: a `PUT` is cast and not validated, so an enumerated field takes any word; a `POST` that the schema refuses answers 500 where 422 is meant; four screens on these routes cannot save what they show (#675).
- The audit adds one thing: where an array is written to a model, some routes declare its elements as "anything".

### 1.6 Size, guessed shapes, and copies (C1, C4, C5)

- **Size (C1).** 20 source files outside the tests are longer than 1 000 lines.
  - `invoice.controller.ts`: 2 425 lines, with handlers of several hundred lines each.
  - `useDocumentForm.ts`: 2 224 lines.
  - `OrderFormView.vue` (1 511 lines, 56 functions) and `InternalOrderFormView.vue` (1 531 lines, 66 functions): 27 of the functions share a name.
  - Eight editable line grids, each written out ([FR-31](FR-31-forms-and-lists-that-do-not-lose-or-mislead.md) §1.6).
- **Guessed shapes (C4).** Components make their own HTTP calls: 131 in 36 components of `invoicing-ui`, 85 in 25 of `portal-ui`, 65 in 18 of `inventory-ui`. The answer's shape is guessed at the call: 55 `_id || id` fallbacks in 26 files, and reads that try one key and then another.
- **Copies (C5).**
  - The map from the app's language to a formatting locale, in 41 files ([FR-31](FR-31-forms-and-lists-that-do-not-lose-or-mislead.md).13).
  - The block that draws an issued number, twice ([FR-29](FR-29-atomic-bookings-records-runtime.md).8).
  - Two auth plugins of about 145 lines each that run the same chain: `portal-api/src/auth/auth.service.ts` and `services/src/http/app-auth.service.ts`.

## 2. Design

### 2.1 Terms

- **Baseline**: a committed list of the errors a check reports today. The check fails on an error that is not in it. The list may only get shorter.
- **Ratchet**: a count in a test that may only go down.
- **Smoke**: a few browser tests that prove the app opens, lists, opens a document and saves a form.

### 2.2 A type-check that can be switched on today

- One `tsconfig.base.json` at the root, strict, and a `tsconfig.json` per package that extends it.
- Two CI jobs' worth of work in one new job: `tsc --noEmit` over the backend packages and `vue-tsc --noEmit` over the UI packages.
- **The baseline** makes it possible to switch the check on with 242 errors open.
  - It lists errors by file, error code and count, without line numbers, so that an edit above an old error does not look like a new one.
  - A new error fails the job. So does a count that grew.
  - A script rewrites the baseline when errors were fixed, and refuses to when any were added.
- **The first run's errors are sorted, not silenced.**
  - Real defects are fixed, or filed with their FR: §1.1 names three groups.
  - "`user` is possibly null": the guarantee is typed once, where the runtime gives it. Where the runtime does not give it, the handler's explicit check stays. No check that exists is removed, and each handler is under the route-table suites before its type is narrowed.
  - "Excessively deep": long route chains are split into groups, which is also what makes them readable.
- **Order of the packages.** `services` and `db` first, then the API packages, then the UI.

### 2.3 A linter with three rules

- No empty catch, and no `.catch()` handler that drops its error: an error is handled, reported, or ignored with a comment that says why.
- The blocks that hold only a comment pass such a rule, so they are read once by hand (about 200 outside the tests): each reports its error, or keeps a reason that is true.
- No new `as any` in the API packages and `services`.
- No promise left floating.
- Each rule starts against its own baseline, like the type-check. More rules are added only when one of them would have caught a defect that reached master.
- A formatter is optional (D-3). Reformatting every file once makes every open branch conflict.

### 2.4 A smoke on pull requests

- A pull request that touches a UI package (`*-ui`, `ui-shared`, `ui-shell`) or the e2e package runs the smoke. Other pull requests do not.
- The smoke is a tagged subset of the existing suite, on the nightly's own rig (`packages/e2e/scripts/nightly.ts`): sign in; open a list; open a document; edit a form, save it, edit again and leave ([FR-31](FR-31-forms-and-lists-that-do-not-lose-or-mislead.md).1); find an article in a line.
- It has a budget of five minutes (D-2). A smoke test that needs a retry counts as a failure of the smoke, not as a pass.
- The night keeps running everything.

### 2.5 Cleanup

- **Deleted**: the 24 dead DAO classes with their tests; the eight shared UI files; `sendNotification` unless a caller is planned; the breadcrumb metadata and the unmounted component (D-4).
- **The four live DAO classes** move onto repositories as their controllers are touched, and the base class goes with the last of them. Until then its read methods are lean, which closes the open item either way.
- **Moved**: `md-to-pdf` and the reference helper that loads it go to the tests package, where the parity test lives.
- **Kept from coming back**: a check lists the files of `ui-shared` that nothing imports, with an allow-list that starts empty.
- **Open items.**
  - Deleting a file removes the stored file too, after the row, and a failed removal is logged and retried by the retention job.
  - Payroll: see D-5.
  - Each `TODO` is done, filed as an issue, or deleted.
- **`CLAUDE.md`** keeps what a session must know before it writes: commands, the architecture in one screen, the rules, the traps (every ⚠), and where things are. What was built, release by release, moves to `docs/history/`, one file per area, linked from the rule it explains. Rules that concern one area can become path-scoped rule files (D-6).

### 2.6 One way to the database

- **`select` and `session`** on the repository's read and write methods. This is the small change two other FRs wait for.
- **Entity types come from the schemas.** The model's schema is the one description of a document. The repository's entity type is derived from it, so a field added to the model is a field the repository knows.
- **A repository for every model a controller touches.** New code in an API package goes through a repository or a service. A count of direct model calls in controllers is a ratchet.
- **The raw driver** stays where it is used on purpose (reads that must not build indexes, migrations, the profiler-style checks), and each such file says why.
- **Casts.** The filter casts the types already accept are removed mechanically. A ratchet counts `as any` outside the tests.
- Whether the repositories stay an interface apart from their one implementation is a decision (D-7).

### 2.7 Every write route says what it accepts

- Shared schema fragments per model, built from the same source as the entity type where that is possible.
- Every `POST`, `PUT` and `PATCH` that reads a body declares it. An array declares its elements. A `PUT` validates values the way a `POST` does.
- A body the schema refuses answers 422, with the field.
- A test over the real route table fails on a write route without a body schema, unless the route is on a list of "reads no body" with a reason.

### 2.8 Smaller pieces

- **Document services.** `createDocument`, `updateDocument` and `issueDocument` in `services/biz`. A handler parses, calls and maps errors. `issueDocument` is [FR-29](FR-29-atomic-bookings-records-runtime.md).8, so that one is built there first.
- **`useDocumentForm`** is split along the seams it already has: loading, lines, pricing, totals, saving, issuing.
- **One base for the two order forms**: what they share by name moves into one composable, and each form keeps what is its own.
- **Typed API modules.** One module per domain in each UI package. A component calls a function and gets a typed answer. The types come from the controllers' schemas, so the UI cannot guess a shape that the server does not send.
- **The copies.** The locale map goes with [FR-31](FR-31-forms-and-lists-that-do-not-lose-or-mislead.md).13 and the numbering block with [FR-29](FR-29-atomic-bookings-records-runtime.md).8. The two auth plugins share one chain, with the portal's as the place it is written.

## 3. Requirements

### 3.1 Gates (slice A)

**FR-32.1 — Every package can be type-checked (MUST).** Each package has a `tsconfig.json` that extends one strict base. `bunx tsc --noEmit -p packages/<name>` runs for every backend package, and `vue-tsc` for every UI package.

**FR-32.2 — The backend is type-checked in CI (MUST).**
- A CI job runs the check on every pull request and on every push to master.
- It fails on an error that is not in the baseline, and on a baseline count that grew.
- The baseline is committed, lists no line numbers, and its total is printed by the job.

**FR-32.3 — The UI is type-checked the same way (MUST).** `vue-tsc` over the UI packages, with its own baseline.

**FR-32.4 — What the first run found is fixed or filed (MUST).**
- The three groups of §1.1 are fixed, each with a test, or carried by the FR that owns them.
- The two Stripe fields are checked against the API version the webhook receives, and the code reads what that version sends.
- The 78 "possibly null" errors are resolved without removing a check, and the route-table suites pass unmodified.
- The baseline of `services` and `db` reaches zero within this FR.

**FR-32.5 — A linter with three rules (MUST).**
- No empty catch and no promise whose rejection is discarded without a reason; no new `as any` in the API packages and `services`; no floating promise.
- Each rule runs in CI against a baseline that only shrinks.
- The catch blocks that hold only a comment are read once, and the pull request lists the ones that now report their error.
- The two instances this batch names are fixed with their own FRs.

**FR-32.6 — A browser smoke on pull requests that touch the UI (MUST).**
- A pull request that changes a UI package or the e2e package runs the smoke, and cannot merge while it is red.
- The smoke finishes within its budget (D-2) on the runner CI uses.
- It covers: sign-in, one list, one document, one form's save-edit-leave, one line search.
- A pull request that touches no UI path does not run it.

**FR-32.7 — A formatter (MAY).** Only with the owner's word (D-3), and then in one commit that touches nothing else, announced beforehand.

**FR-32.8 — The gates stay cheap (MUST).** The type-check and the linter together add at most three minutes to a pull request's CI. If they cannot, they run in parallel with the tests rather than before them.

### 3.2 Cleanup (slice B)

**FR-32.9 — Dead code is deleted (MUST).**
- The 24 dead DAO classes and their tests are gone, and with them the `$text` query.
- The base class's read methods are lean, or the base class is gone with the last class that used it. Either way the open item about `.lean()` is closed.
- The eight shared UI files are gone.
- `md-to-pdf` is not a dependency of any package that ships in the image. The parity test still runs.
- `sendNotification` and the breadcrumb metadata are deleted or have a caller (D-4).
- `bun run build`, `bun run test` and the nightly are green afterwards: nothing that was deleted was reached.

**FR-32.10 — Unimported shared files do not come back (SHOULD).** A unit check lists the files of `ui-shared` and `ui-shell` that no source file imports. Its allow-list is empty, or each entry has a reason.

**FR-32.11 — Deleting a file deletes the file (MUST).** After `DELETE` of a file, the stored object is gone as well as the row. A removal that fails is logged, leaves a marker, and is retried. A test deletes a file and looks for the object.

**FR-32.12 — Payroll shows what it computes (SHOULD).** The legacy payroll run either computes overtime, bonuses and allowances, or its form and its payslip say that they are not computed (D-5). No figure that is always 0 is shown as a result. The `TODO` comments the open item counts are done, filed or deleted.

**FR-32.13 — `CLAUDE.md` holds rules and traps (SHOULD).**
- The file is at most 800 lines (D-6), and a check in CI keeps it there.
- Every ⚠ of today's file is in the new one, in a path-scoped rule file, or in the document it is linked to: a script compares the lists before and after.
- The history is under `docs/history/`, by area, with nothing lost.
- A session that opens the repository still learns the commands, the layout, the contracts that do not move, and the traps.

### 3.3 Data access (slice C)

**FR-32.14 — The repository takes `select` and `session` (MUST).**
- The read methods take a projection. The read and write methods take a session, and use it for every operation they make.
- A unit test covers both on the Mongo implementation, and the `dal/repos` tests pass unmodified.
- This requirement ships by itself, ahead of the rest of the slice: [FR-29](FR-29-atomic-bookings-records-runtime.md).3 and [FR-30](FR-30-speed-at-shop-volume.md).7 wait for it.

**FR-32.15 — Entity types come from the schemas (MUST).**
- An entity's type is derived from its model's schema. No hand-written interface restates a model's fields.
- Adding a field to a model makes it known to the repository without a second edit: a type-level test proves it for `Invoice`.
- It starts with the documents (invoice, order, movement) and proceeds by model.

**FR-32.16 — A repository for every model a controller touches (SHOULD).** New code in an API package reads and writes through a repository or a service. The count of direct model calls in controllers only goes down. A file that uses the raw driver says why.

**FR-32.17 — Fewer casts (SHOULD).** The count of `as any` outside the tests only goes down, from 2 173. The casts on a filter handed to a repository go first, with the entity types of FR-32.15.

### 3.4 Schemas (slice D)

**FR-32.18 — Every write route declares what it accepts (MUST).**
- A write route that reads a body has a body schema. An array that is written to a model declares its elements.
- A value that the model does not allow is refused on `PUT` as it is on `POST`.
- A body the schema refuses answers 422 and names the field.

**FR-32.19 — A test keeps it so (MUST).** A test over the real route table fails on a write route with no body schema that is not on the "reads no body" list. The list is in the test, with a reason per route.

**FR-32.20 — The four screens save what they show (MUST).** Fixed assets, exchange rates, timesheets and reconciliation (#675): what the form shows can be saved, and a test per screen saves it.

### 3.5 Structure (slice E)

**FR-32.21 — Document services (SHOULD).** Creating, updating and issuing a document are functions in `services/biz`. No handler in `invoice.controller.ts` is longer than 80 lines. The API's answers are unchanged: the invoicing suites pass unmodified.

**FR-32.22 — `useDocumentForm` in parts (SHOULD).** The composable is split along its seams into files of at most 500 lines. What it returns to the form is unchanged, and the document form's unit and e2e tests pass unmodified.

**FR-32.23 — One base for the two order forms (SHOULD).** What the supplier order form and the customer order form share lives in one place. Each form is at most 900 lines. Their route names, their e2e tests and the stable row keys they already have are unchanged.

**FR-32.24 — Typed API modules (SHOULD).**
- A component of `invoicing-ui` or `inventory-ui` makes no HTTP call by itself: it calls a function of its domain's API module.
- The functions' types come from the controllers' schemas.
- The `_id || id` fallbacks and the "one of three keys" reads are gone from the modules that were converted.
- It proceeds by screen, the daily ones first.

**FR-32.25 — The copies are folded (SHOULD).** One auth chain, written once and used by both plugins, with the shared session rules where they are today. The other two copies are closed by [FR-31](FR-31-forms-and-lists-that-do-not-lose-or-mislead.md).13 and [FR-29](FR-29-atomic-bookings-records-runtime.md).8.

**FR-32.26 — Large files do not grow (MAY).** A check lists the source files over 1 000 lines. A file on the list may not get longer, and no new file may join it.

### 3.6 Across this FR

**FR-32.27 — Behaviour does not change (MUST).**
- Slices B, C and E are refactors. The existing suites pass unmodified, and a test that had to change is named in the pull request with the reason.
- No check that exists in a handler is removed to satisfy a type.
- `POST /org/:orgId/invoices`, `POST /org/:orgId/bills/import/{extract,draft,convert}`, the list endpoints' response keys and the route names are unchanged.
- One answer changes on purpose: a body the schema refuses is a 422 where it was a 500 (FR-32.18).

**FR-32.28 — Guards, data, Windows (MUST).**
- The tenant-isolation, route-permission and read-permission suites pass unmodified, and so does `unit/replication-meta.test.ts`.
- A released migration file is not edited, reformatted or linted into a change: its checksum covers the whole file.
- No test, fixture, issue comment or PR carries a customer's name or figure.
- No new test uses `.rejects` or `.resolves`.

## 4. Migration

| What | Change | Procedure |
|---|---|---|
| Stored data | none, except FR-32.11 | Files whose row was deleted earlier and whose object remains are counted first. Removing them is the owner's decision |
| CI | one job for the type-check and the linter; a smoke for UI pull requests | The baselines are committed with the jobs, so the first run is green |
| Open pull requests | none | No formatter runs unless D-3 is answered, so nothing conflicts |
| `CLAUDE.md` | shorter | The history moves in the same commit that removes it, and the ⚠ comparison is in the pull request |
| Packages | `md-to-pdf` leaves `reporting` | The image is built and a PDF is rendered before the merge |
| An on-prem master | none | Nothing here changes what a master stores or serves |

## 5. Slices, dependencies and rollback

| Slice | Ships | Visible change | Exit |
|---|---|---|---|
| A | FR-32.1 to .6, .8 | none for users; two more checks on a pull request | the jobs are green on master; a planted type error and a planted empty catch turn them red |
| B | FR-32.9 to .13 | a deleted file is gone from storage; a shorter `CLAUDE.md` | build, tests and nightly green; the ⚠ comparison |
| C | FR-32.14 first, then .15 to .17 | none | the `dal/repos` tests unmodified; the ratchets |
| D | FR-32.18 to .20 | a refused body says which field; four screens save | the route-table test |
| E | FR-32.21 to .25 | none | the invoicing and order suites unmodified |

**Order.** A first, because every later slice is safer with it. FR-32.14 right away, by itself. B at any time. D after A. C and E continuously, a file at a time, and never in the same pull request as a behaviour change.

**Rollback.** A: a job can be made non-blocking by one line, and the baseline remains. B: a deleted file is restored from history; `CLAUDE.md` is restored from history. C, D and E: each pull request reverts alone, which is why they stay small.

**Risks.**
- *A type "fix" removes a check that mattered.* FR-32.27, and the route-table suites run before and after.
- *A baseline that nobody shrinks.* Its total is printed on every run, and `services` and `db` have a target of zero inside this FR.
- *The smoke becomes the slow, flaky step everybody reruns.* Five tests, a budget, and a retry counts as a failure.
- *A refactor and a behaviour change in one pull request.* They are kept apart (FR-32.27), so a regression has one suspect.
- *Deleting something that was reached after all.* Build, tests and the nightly, and the image is built before the merge.
- *A rule or trap is lost when `CLAUDE.md` shrinks.* The ⚠ comparison.
- *Schemas refuse what a script sends.* The in-repository importers and skills are run against a local server before slice D ships.

## 6. Tests

- **The gates test themselves**: a branch with a planted type error, a planted empty catch and a planted floating promise fails each job; the baseline script refuses to add an error.
- **Unit**: the repository's `select` and `session`; the unimported-files check; the route-table schema test; the type-level test for derived entity types; the ratchets (casts, direct model calls, large files, raw number of baseline errors).
- **Integration**: file deletion removes the object; a `PUT` with a value outside an enum answers 422; the four screens of #675.
- **E2E**: the smoke subset, tagged; it is also part of the night.
- **Guards, unmodified**: `tenant-isolation.flow`, `route-permission.flow`, `read-permission.flow`, `unit/replication-meta.test.ts`, the `dal/repos` tests, the invoicing, order and document-form suites, the PDF parity test.

## 7. Acceptance criteria

1. A pull request with a type error in `services` cannot merge.
2. A pull request with an empty catch in a UI package cannot merge.
3. A pull request that breaks the save-edit-leave of a form cannot merge, and learns it within about five minutes.
4. `services` and `db` type-check with an empty baseline.
5. No DAO class is left that only tests import, and the build, the tests and the night are green.
6. A deleted file's object is gone.
7. `CLAUDE.md` is at most 800 lines and every ⚠ it had can be found.
8. The repository takes a projection and a session.
9. No write route reads a body it did not declare.
10. No handler in the invoice controller is longer than 80 lines, and the invoicing suites pass unmodified.
11. `bun run test`, `bun run build`, `bun run test:e2e` and CI are green.

## 8. Field test (production, after each slice; the demo organization, never a customer's)

Most of this FR is proven by CI, not in production.

1. **Slice A.** Open a draft pull request with one planted error of each kind and read the three red checks. Close it without merging and delete its branch.
2. **Slice B.** After the deploy: print an invoice, an order sheet and a stock receipt (the PDF path lost a dependency). Upload a file in the demo organization, delete it, and confirm the object is gone.
3. **Slice C and E.** After each deploy: create, edit, issue and void an invoice; receive a bill; save a supplier order and a customer order. The audit page shows each action.
4. **Slice D.** Save each of the four screens of #675. Send one `PUT` with a value outside its enum from the browser's tools and read the 422.
5. **Clean up.** Void or delete what the test made, delete the test branch, and report the count left (0).

## 9. Decisions (defaults stand unless the owner answers otherwise)

| | Question | Default |
|---|---|---|
| D-1 | Which linter? | The fastest one that has the three rules; the rule about floating promises needs type information, so it may run inside the type-check job |
| D-2 | The budget of the smoke | Five minutes, five tests, only for pull requests that touch a UI package or the e2e package |
| D-3 | A formatter? | No, until the owner asks. One reformatting commit makes every open branch conflict |
| D-4 | Breadcrumb metadata and `sendNotification` | Deleted. The alternative for breadcrumbs is to mount the component, which costs a row of height on every screen ([FR-31](FR-31-forms-and-lists-that-do-not-lose-or-mislead.md).20) |
| D-5 | Payroll's overtime, bonuses and allowances | The legacy run's form and payslip say they are not computed. Computing them is a payroll decision of its own (FR-25) |
| D-6 | The size of `CLAUDE.md` | At most 800 lines. Area rules move to path-scoped rule files, history to `docs/history/` |
| D-7 | Do the repositories stay an interface apart from their implementation? | Yes for now: the `dal/repos` tests exercise the interface. Merging `dal` and `dal-mongo` is cheap later and wins little today |
| D-8 | The order of packages for the type-check | `services` and `db`, then the API packages, then the UI |

## 10. Not in this FR

- A rewrite of any module. Every slice here is incremental.
- Replacing Elysia, Mongoose, Vuetify or Bun, or changing how the packages are split.
- More test coverage as a goal by itself. The tests named in the other three FRs are theirs.
- Dependency upgrades, beyond what the type-check forces.
- The desktop shell's Rust code, which has `clippy` in CI already.
- The scripts under `scripts/` and the skills. They are type-checked last, if at all, and are not linted.
- The defects themselves: [FR-29](FR-29-atomic-bookings-records-runtime.md), [FR-30](FR-30-speed-at-shop-volume.md) and [FR-31](FR-31-forms-and-lists-that-do-not-lose-or-mislead.md).

## 11. Build log

### Slice A

- **#806** (FR-32.1–.3, .8): a `tsconfig.json` on one strict base in every package, `bun run typecheck`, the CI job, the baselines (backend 248, ui 57, desktop-ui 3 at the start).
- **#807** (FR-32.5): oxlint with the four rules, against `scripts/lint/baseline.json` (2 064 at the start). The job is `typecheck + lint (ubuntu)`, about a minute, beside the tests (FR-32.8).
- **#809** (FR-32.6): the five `@smoke` tests on every pull request that touches a UI package or `e2e`, five minutes, no retries.
- **FR-32.14** shipped by itself in **#799** (slice C's first requirement).
- **FR-32.5, the catches** (`feat/797-fr32-a-catches`): the 198 catch blocks that held only a comment were read once.
  - 139 give a reason that is true, and stay as they are.
  - 49 gave no reason (`/* */`, `ignore`, `Silent fail`). They now say why the error is dropped. Most are reference lists, where the HTTP client already reports a network failure or a 5xx.
  - Ten now report their error through `ui-shared/composables/report-error#reportError`. It says a refusal (a 4xx), which the HTTP client leaves to its caller, and it says and logs an error that is not an HTTP answer. The ten:
    - a note added to a record (`EntityNotesPanel`), which was lost silently, and that panel's history;
    - a contact's ledger (`useContactLedger`);
    - a product's stock page (the product, and its levels, movements and counts);
    - the valuation;
    - the lines a new count is seeded with;
    - the lines copied from a related invoice;
    - a file's versions;
    - an audit entry's correlated entries.
  - The 14 empty catches and the 20 floating promises are gone. The lint baseline falls from 2 073 to 2 039.
  - The 158 `.catch()` handlers that drop their error stay on the baseline, which may only shrink.
- **FR-32.4, the core packages** (`feat/797-fr32-a-core-typecheck`): the backend baseline falls from 248 to 208. Every error of `dal`, `dal-mongo`, `db` and `fiscal` is fixed, and 37 of `services`' 48. The Stripe webhook reads the period end and an invoice's subscription in both API shapes, the one before 2025-03-31 and the one after (`periodEndOf`, `subscriptionIdOf`, `unit/stripe-webhook-shapes.test.ts`). Left in `services`, each carried by the work that owns its file:
  - `audit-log.service.ts` (5: the four repositories that do not exist, a missing import) and `doc-import/persist.ts` (an audit entry stored without its content): [FR-29](FR-29-atomic-bookings-records-runtime.md) §1.5 and .22;
  - `access/evaluate.ts`, `access/role.service.ts`, `biz/auth.service.ts` and `dao/user.dao.ts` (5): files FR-27's open pull requests change;
  - `dao/warehouse/stock-level.dao.ts` (1): a dead DAO class, deleted by slice B.

### Slice B

- **FR-32.9, .10: dead code out** (`feat/797-fr32-b-dead-code`).
  - The 24 DAO classes only tests imported are gone, with their four unit suites. That includes `org-app.dao.ts` and the `$text` query, which FR-30.4 had already removed.
  - The base class's reads are lean for the four left (org, user, invite, sign-in code). `GET /org/:orgId` reads the lean org as `toJSON()` gave it. The open item about `.lean()` is closed.
  - Nine files of `ui-shared` are deleted: the audit's eight, and `AuditLogPanel.vue`, which the new check found.
  - Also deleted: the shell's unmounted `AppBreadcrumb` and the 69 `meta.breadcrumb` of the module manifests (D-4), and `sendNotification` with its `notification` message (D-4).
  - `md-to-pdf` and the parity test's reference page (`tests/helpers/md-to-pdf-reference.ts`) moved to the tests package. `reporting` no longer depends on it.
  - `unit/unimported-shared-files.test.ts` (FR-32.10) fails on a file of `ui-shared` or `ui-shell` that no source file imports. Its allow-list is empty.
  - Tests that had to change (FR-32.27):
    - `app-hub.flow` reads `OrgApp` itself, and its "OrgApp DAO" block went with the class;
    - `movement-number`, `product-ledger` and `warehouse.flow` number their fixtures through `biz/movement-number#nextMovementNumber`, which the deleted DAO method called;
    - `tasks-ws.flow` lost the `notification` assertions;
    - `module-manifests` asserts that no route carries a breadcrumb.

### Slice B, the open items

- **FR-32.11, .12** (`feat/797-fr32-b-file-delete`):
  - **Deleting a file deletes its bytes.** `DELETE /org/:orgId/file/:id` removes the stored object after the row (`services/biz/files/file-removal.service.ts`).
    - Bytes another `File` row or a `DocFile` still names stay, in either the relative or the old absolute form.
    - A file already gone, another provider's key and a path outside the org are left alone.
    - A removal that fails is logged and leaves a `NodeState` marker (`file-removal:<hash>`, node state: the bytes are this node's). The retention tick retries it (`fileRemovalsRetried`).
    - `integration/file-delete.flow.test.ts` deletes a file and looks for the object, and makes a removal fail, then lets the tick finish it.
    - Files whose row was deleted before this are not touched: §4 leaves counting and removing them to the owner.
  - **Payroll says what it computes** (D-5).
    - The generic run's gross is the base salary, with no overtime, bonus or allowance figure computed beside it.
    - Its form and its payslips say so (`payroll.legacyNotComputed`, four languages).
    - The four payroll lists' Export and the payslip's PDF button did nothing. They are removed and filed as #830.
    - The three TODOs left in the source are FR-25 §7.5's, and `unit/payroll-says-what-it-computes.test.ts` fails on a TODO that names no issue or spec item.

### Slice C

- **FR-32.14** shipped first, by itself (#799).
- **FR-32.15, .16, .17** (`feat/797-fr32-c-entity-types`):
  - **Entity types from the model.** `dal/entity-of.ts#EntityOf` and `Plain` derive an entity from its model's interface. They map `ObjectId` to string, add `id` and the stamps, and drop Mongoose's own keys, as `toEntity` does at run time.
    - The invoice is the first entity: `IInvoice` and its lines, payments, price steps, addresses and cash-sale ref are now `Plain<…>` of `db/models/invoice.model.ts`, where `dal` restated 43 fields by hand.
    - `unit/entity-types.test.ts` compiles a probe. The entity has every field of the model, a field added to a model reaches its entity as a plain value, and a planted wrong type fails.
    - The other models follow as they are touched (the order and the movement next), each the same three lines.
  - **Ratchets** (`unit/code-ratchets.test.ts`):
    - direct model calls in the API packages' controllers, 277 (272 on this branch's first base; the masters merged in since added five, three of them the journal list's document names, FR-29 D);
    - `as any` outside the tests, 2 156 (2 173 at the audit, 2 183 on this branch's first base);
    - each file that uses the raw driver listed with its reason, and a new one fails until it is listed. Ten are listed with their reason still to be named.

### Slice D

- **FR-32.18, .19, .20** (`feat/797-fr32-d-body-schemas`):
  - **A value the model refuses answers 422 with its fields** (`code: 'invalid_fields'`, `fields`, the message S-12 already wrote). That covers a create whose document the model refuses and an edit that runs the validators (`updateInOrg(…, { validate: true })`, #685). It was a 500 that named them. This is the one answer FR-32.27 lets change.
  - **Every write route that reads a body declares it.**
    - The eleven creates that store the body as the document (`clientCreate`) declare it as an object; their values stay the model's to judge.
    - `POST /invoices/:id/send` declares its two optional fields. `acknowledgeOverlap` takes any value, as before: only `true` answers the question, and anything else is asked again (409), which the overlap suites pin.
    - The 16 arrays declared as "anything" now declare their elements as objects (`services/http/body-schemas#AnObject`), without naming fields, because a schema is a whitelist.
  - **`unit/write-route-bodies.test.ts`** reads the real route table.
    - A POST, PUT or PATCH with no body schema fails unless it is on `READS_NO_BODY` with its reason.
    - A listed route, or a DELETE, whose handler takes `body` fails.
    - So does an array whose elements are "anything".
    - The six multipart uploads are on the list: each reads its files from the form itself.
  - **The four screens of #675** were closed before this FR was written, by #685 (fixed assets, exchange rates, timesheets) and #686 (bank reconciliation). Their tests are `integration/form-payloads` and the reconciliation suite.
