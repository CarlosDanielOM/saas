# Named application schema types and source retirement — 2026-10-30

The Rust crate now contains the named value types and schema contracts for
`admin`, `accounts`, `credit_gift`, and `credit_transaction`, alongside the
native model descriptors. The named-type feature and its native value
dependencies passed isolated source-bound validation at source commit
`425b662cec154d4337f2bcc591c76b8b0f2a7335`. Validation input: 1,482 frozen
inputs, source tree SHA-256
`3c2937e2042719071e2ba02033de15ea23003c279ae276c1e9e1a64d371743aa`.

The corresponding four TypeScript files have since been moved into the archive
and passed post-retirement source and native validation. The accepted source
commit is `dec14f0afd4176816ab347493b4a9c443ed2a8be`; its frozen 1,482-input
source tree has SHA-256
`71ca4cf0d80a38f86f19ebe7291d52af4f852b09bdd93c4bde9abf03a3394997`. The
source binding covers 1,472 Git inputs and ten reused SDK inputs; all hashes
matched. Caller adoption and deployment are separate and remain open.

## Source contracts and native types

| TypeScript source | Named TypeScript exports | Native counterpart |
|---|---|---|
| `dimabot/src/schemas/admin.schema.ts` | `IAdmin`, role union, model | `admin::IAdmin`, `AdminRole`, existing `schema()` descriptor |
| `dimabot/src/schemas/accounts.schema.ts` | `IAccounts`, model | `accounts::IAccounts`, `AccountToken`, existing `schema()` descriptor |
| `dimabot/src/schemas/credit_gift.schema.ts` | `CreditGiftStatus`, `ICreditGift`, model | `credit_gift::CreditGiftStatus`, `ICreditGift`, existing descriptor |
| `dimabot/src/schemas/credit_transaction.schema.ts` | `TRANSACTION_TYPES`, `TransactionType`, `ICreditTransactionMetadata`, `ICreditTransaction`, model | Existing `TRANSACTION_TYPES` and named catalog constants; `TransactionType`, `RewardTargetType`, `ICreditTransactionMetadata`, `ICreditTransaction`, existing descriptor |

The pinned actual-source oracle covers 12 exports and 75 interface members.
Each of the four TypeScript files imports only Mongoose. The Rust crate uses
the existing `application-schemas` capability and native MongoDB crate; it
does not require an additional package or a missing application adapter. The
role, gift-status and transaction-value catalogs reuse their corresponding
schema descriptor catalogs. The model descriptors predated this work; these
named Rust types filled the remaining local value-contract gap.

## String, number, and stored-document boundaries

Declared string fields use the shared `JsString`, preserving arbitrary UTF-16
units—including lone surrogates—in the native value representation. Explicit
`to_bson_document` and `from_bson_document` conversion follows BSON string
encoding: unpaired UTF-16 units are replaced at that BSON boundary. The
source-bound oracle checks six string cases against the pinned Node BSON SDK.
The numeric oracle checks five BSON number cases, including special values.

Optional declared fields distinguish absence from explicit null: they accept
missing values and reject null where the source schema does. Stored-value
projections are separate types because ordinary Mongoose-created documents
have null defaults for the five required `IAccounts` strings and for selected
credit-transaction fields and metadata. Native ObjectIds and dates replace
Mongoose-specific runtime types. These projections describe persisted model
values; they do not relax the source declaration contract.

## Validation of the type implementation

Two exact type-validation attempts are retained. Node attempt
`1793362449019157447` passed source extraction, strict TypeScript checking,
version/hash pins and fixture generation. Compiler attempt
`1793362463134937029` passed the ordinary type tests, application-schema tests
and exact source replay, then failed strict scoped Clippy on `type_complexity`
in the expected-interface table. The only correction was adding two local
type aliases. Node attempt `1793362526601171654` and compiler attempt
`1793362541503862592` then passed. The final compiler phase took 112.86 seconds
total (101.39 seconds of phase work), with a 4 GiB no-swap limit, six CPUs,
two Cargo jobs and a 256 PID limit. Minimum available memory was 8,713,089,024
bytes and the private cache peak was 8,167,485,440 bytes. It passed the two
named-type tests, three application-schema tests, one exact-source replay,
formatting, scoped Clippy, minimal profile, Mongo+Redis profile and all-feature
strict checks. Format receipt `1793362424162883540` passed.

The named-type fixture records interface fields, catalog values, source and
native hashes, BSON bytes, NaN, typed builders, stored defaults,
missing-versus-null behavior, hidden projections, ObjectIds, dates and
descriptor identity. It is generated externally; the Rust replay does not run
Node. Mongoose date reference readers must also preserve five-zone output
semantics; their reader-hash changes are distinguished from the pinned
`admin` source hash.

## Four-source retirement validation

The four sources were removed from the live tree after their Rust types passed
review. Archive verification confirms the previous 36 entries and top-level
metadata are unchanged and the four new archive files are byte-exact copies
from Git commit `425b662c`, bringing the archive to 40 entries. The pinned
manifest used for evidence is read from the accepted immutable source commit
`dec14f0a`, not from the mutable checkout. The retirement resolver pins nine
source identities, checks the single archive path and manifest entry, rejects
live shadows and verifies source outputs. An ordinary test separately
verifies all four archived source hashes.

The current retirement Node run `1793362880829965805` passed in 19.816 seconds
total (18.508 seconds for the check step). It regenerated the five Mongoose
date fixtures twice; all five timezone outputs were byte-identical across
generations, and every case and missing-value result matched the prior
fixtures. This includes 80 cases per timezone (400 timezone cases) with three
recorded assertions per case. It also found all 25 semantic comparisons equal
against the pre-retirement named, application-schema, and action-log reference
outputs. Format run `1793362849611128786` passed. Capped compiler run
`1793362925365685891` passed in 147.829 seconds total (135.279 seconds of
compiler-phase work). It ran with 4 GiB memory and no swap, six CPUs, two Cargo
jobs, and a 256 PID limit. Minimum available memory was 8,996,634,624 bytes
and the private cache peak was 8,208,592,896 bytes. The suite passed three
ordinary named-type tests, three application-schema tests, two ordinary
action-log tests, ignored named/action-log actual-source replays, all five
Mongoose date-zone replays, formatting, scoped Clippy, minimal profile, and
all-feature strict checks. This wave did not run Mongo CRUD. Final readback
found 18 production records unchanged and zero task-owned resources.

The frozen snapshot excludes only the four unwired DeleteTwitch draft files
listed in `snapshot-isolation.json`; no results for those drafts are implied.
The retirement fixture work does not claim Mongo CRUD for the OAuth/account/credit flows;
Mongo CRUD and index tests from the separate moderation action-log evidence do
not verify these models. No new benchmark or speed claim was made.

See the [evidence package](evidence/2026-10-30-schema-named-types/README.md)
for the indexed immutable wave artifacts, two type attempts, final retirement
Node/compiler/format receipts, source binding, Git-pinned archive manifest,
production readback, and reproduction tools.

## Adoption and completion

The source files were archived only in the migration checkout. The admin, gift, and transaction application paths remain unported; production
continues to use its existing built TypeScript models. Application adoption
of the native schema types has not been established. The native account schema has no verified caller cutover.
The accepted local Rust feature and dependency closure do not establish
production release or total migration completion. No deployment or push
occurred. The matrix now records 27 locally complete mappings and 24 partial
source rows across 806 baseline rows, with 40 archived snapshots and 766 live
baseline TypeScript rows (including six excluded React Email templates).
Total migration completion remains `null`.
