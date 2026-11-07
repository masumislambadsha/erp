# ERP Master Plan

Nov 5, 2026 · @Masum Islam Badsha

Build a ledger-first, multi-tenant ERP core for Bangladeshi trading companies, prove it on real books through five test gates, and add every other industry as a pack that never changes the core.

## At a glance

The kernel comes first, then one real company's books prove it, then industries arrive as packs. First paying go-live is an estimated 2,240–3,530 focused hours away.

|  |  |
| --- | --- |
| What gets built | A multi-tenant cloud ERP: a ledger-first core (finance, inventory, order-to-cash, procure-to-pay) plus industry and localization packs that never change the core |
| First users | Your own 50-room building keeps its books on it from Phase 0. One Bangladeshi trading company runs a parallel month at Gate 1 and goes live at Gate 2 |
| First market | Bangladeshi trading and distribution SMEs; manufacturing, garments included, from Phase 3 |
| Proof it works | Five exit gates tested on real books: reconciliations to the taka, an accountant's sign-off, a paying go-live, a second industry with zero core changes |
| Scope | 172 features: 55 Must, 11 Need, 61 Should, 26 Nice, 19 Later, listed in Feature map |
| Effort to first paying go-live | 2,240–3,530 focused hours: about 1.1–1.7 years full-time, 2.2–3.4 years at 20 hours a week, or 4.3–6.8 years at 10 |
| Stack | NestJS modular monolith, PostgreSQL 16 or later, Next.js. The ledger kernel is written and passes 119 tests on PostgreSQL 16.15 after two independent attack reviews, in Kernel schema |

### How to read the claims

Every statement is one of four kinds, so nothing passes as more certain than it is:

- **Sourced**: linked to a primary source opened on 5 Nov 2026.
- **Decision**: a choice with its reason. Changing it means a new decision-log entry.
- **Target**: a number this plan sets. It counts as true only once its test passes.
- **Estimate**: a range with its assumptions, recalibrated after Phase 0.

Nothing here is tax or legal advice. Each Bangladesh rule is confirmed with a VAT consultant, and data-protection questions with a lawyer, before it ships.

### What changed from the blueprint

| Issue found in the blueprint | Fix in this plan |
| --- | --- |
| Tiers contradicted the roadmap: manufacturing and HR "Musts" were built after the first customer, the metadata engine wasn't Must, payroll was Must but its statutory rules Should | A feature's tier is the phase it ships in, so they can't disagree. The metadata engine is Must; payroll ships with its statutory rules |
| No pack contract: how a pack adds tables, documents, posting logic and screens per tenant | A written contract with can/cannot rules, per-tenant enablement, versioning and CI checks |
| "Eleven tables carry the whole design" was false: accounts, lock dates, balances, cost layers, tax rates and unit conversions were missing | The kernel is 29 tables and says so. Every table the text relies on exists |
| tenant\_id missing from the DDL; UNIQUE (sku) collided across tenants | tenant\_id leads every key and foreign key; SKUs are unique per tenant (tests T02, T04, T08) |
| Row-level security called "guaranteed" though table owners and Supabase's service role bypass it | FORCE ROW LEVEL SECURITY, an app role that owns nothing and lacks BYPASSRLS, and a tenant context that fails loudly (tests T03–T07, T31–T32) |
| "Scalable" had no numbers | Capacity targets, each with the load test that proves it |
| Gate 2's balanced trial balance tested nothing; opening data and Mushak forms arrived after the gate needed them | Gates test reconciliations and an accountant's sign-off. Opening-balance import and VAT registers are Must |
| No backup, restore or test strategy | Point-in-time recovery with restore drills from Phase 0; property tests, golden scenarios and a tenant-isolation suite |
| Missing migration tooling, notifications, segregation of duties and chart-of-accounts templates | All four are in the feature map, tiered |
| REA wasn't used, and the reason given (nothing local to analyze) was wrong | A scoped REA protocol plus a scenario lab that turns observed postings into tests; Business Central's application source is read directly |
| Sources were mostly blogs and vendor marketing | Primary sources: Business Central source code, Microsoft Learn design notes, SAP and Oracle documentation, PostgreSQL docs, PwC tax summaries |

### What two independent reviews changed

Two adversarial reviews then attacked this plan and its kernel. The first found 15 problems. The second, run against the rewritten kernel, found 7 more, one of them critical. All 22 are fixed, and each database fix has a test that replays the original attack (test names are in Kernel schema).

| What a review found | What changed | Proof |
| --- | --- | --- |
| A journal's balance check could be skipped by switching tenant mid-transaction, by a temporary table named like a ledger, or by forcing the check to run early (critical) | Commit-time checks run once per queued journal, after its rows exist; they refuse a tenant switch and use pinned, schema-qualified names; the app cannot create temporary tables | H02–H05c |
| Guards trusted columns the app writes: control-account flags, remaining amounts, on-hand stock, timestamps | The database writes them, and control accounts reconcile with their subledger per customer, supplier and item in every journal | T19, R01–R03, R17, S04–S05, H10 |
| Some ledgers skipped lock dates; documents could start out submitted; a posting could commit into a period as it was being locked | Every ledger checks its lock date under a lock that closing a period waits on; documents start as drafts; submit checks the GL lock and assigns the gapless number | T17, T22, S09, R10, D08, D13a, C03 |
| Rows could point at another company's accounts or locations | Company-scoped foreign keys on every cross-reference | T18, D21 |
| Settlements couldn't be undone or carry exchange differences; costing had no record of which receipt fed which issue | Unapply, transaction-currency amounts and realized exchange differences; a cost application table like Business Central's | R11–R16, S10–S11 |
| Offsetting fake VAT rows passed a per-account total | Each tax account holds one tax code and direction; tax on a supply cites its document line | T21a, T21b |
| A reversal could move one customer's balance to another | Reversals mirror per account, customer, item and dimension, and settle the open items they reverse | D22–D24 |
| An account's type could change while a posting to it was in flight | Postings share-lock the accounts, items and locations they use, so a type change waits, then refuses | C05, T24, S12 |
| The app could write audit rows, or hold an advisory lock to stall postings | Only the database writes the audit log; only its guard role may take advisory locks | H11, K08 |
| Partitions, other schemas and TRUNCATE sat outside the guards | Row security on every table and partition in every schema; ledgers refuse TRUNCATE | K01, K06, H06–H08 |
| Gate 1 needed landed cost and foreign currency, which sat in later tiers | Landed cost is Must (now 55 Must, 11 Need); the foreign-currency scenario moves to Gate 3 | Tiers, Exit gates, D16 |
| Bangladesh VAT gaps: Mushak 9.1.1, input-credit conditions, SD in the VAT base, mandatory NBR-approved software | Added from PwC's tax summary | Bangladesh localization, Gate 2, Risks |
| REA was said to map clicks to server calls | It inspects saved captures offline; a Business Central trial and TallyPrime join the lab as black boxes | Where REA is used |
| Hours looked low, and there was no competitor view | Hours rise for landed cost and importers, with a 10-hours-a-week figure; competitors to test in interviews | Effort, Why a company would switch |

No review can prove that no bugs are left. Still open, and owned: availability if the API itself is compromised (timeouts and monitoring, not the schema); a superuser bypasses everything, so the app never connects as one; and the kernel does not yet model exchange revaluation of open items, cross-currency application, payment discounts or lots.

## Twelve rules the system never breaks

Each rule has a mechanism, not a promise. Most are enforced by the database itself and proved by a numbered test in the kernel schema tab.

| # | Rule | Why it matters | Enforced by |
| --- | --- | --- | --- |
| 1 | Ledgers are append-only | Filed reports must stay reproducible | The app role holds only SELECT and INSERT on ledgers; a trigger stops even the table owner (T12, T13); a committed journal is sealed against new lines (T37) |
| 2 | Every journal balances in company currency | Unbalanced books are wrong books | A deferred constraint trigger checks each journal at COMMIT (T10); property tests on random documents |
| 3 | Subledgers equal their control accounts | Receivable, payable and stock reports must agree with the GL | Control accounts refuse manual journals (T14); a nightly integrity check compares the totals |
| 4 | Posted documents never change | A sent invoice or a filed VAT return must stay true | A trigger allows draft edits and submitted → cancelled only; in a locked period the fix is a credit or debit note (T20–T27) |
| 5 | Tenant isolation lives in the database | One missing WHERE clause must not leak a customer's books | Forced row-level security, tenant\_id in every key and foreign key, an app role that owns nothing (T01–T07, T31, T32) |
| 6 | Money is never a float | Float totals drift and the trial balance stops balancing | NUMERIC columns; a Money type in TypeScript that never converts to number |
| 7 | Accounts and tax rates are data | A new customer or a budget change needs no deploy | Posting handlers can only ask posting setup for an account by event name; tax rules are effective-dated rows |
| 8 | The core never depends on a pack | Any industry without forks | A dependency rule fails the build; CI flags any pack change that touches core files |
| 9 | Every write is idempotent and audited | A retry on a weak mobile connection must not post twice | An idempotency key on every POST; the audit row commits in the same transaction |
| 10 | Dates follow the company; instants are UTC | An invoice at 00:30 lands on the right day and in the right period | posting\_date is a date in the company's time zone; timestamps are timestamptz |
| 11 | Derived state is rebuildable | Caches drift; ledgers don't | Balances, cost layers and open-item remainders are rebuilt from the ledgers nightly and compared; a mismatch alerts you |
| 12 | Reports never block posting | Month-end reports must not stop the sales counter | Closed periods read frozen balances; heavy reports move to a read replica in Phase 3 |

## Evidence: how the leaders were reverse-engineered

The deepest evidence is public and legal: a top-tier commercial ERP's full application source, SAP's and Oracle's published data models, and two open-source ERPs run locally. REA runs only where analysis is permitted, and no hosted commercial system is decompiled.

### What each source shows

| Source | What it reveals | Used for |
| --- | --- | --- |
| [Business Central application source](https://github.com/microsoft/BCApps) (Microsoft, MIT license; Base Application included, commit of 4 Nov 2026 read) | The posting code and ledger tables of a commercial ERP: [G/L Entry, table 17](https://github.com/microsoft/BCApps/blob/main/src/Layers/W1/BaseApp/Finance/GeneralLedger/Ledger/GLEntry.Table.al); [Item Ledger Entry, 32](https://github.com/microsoft/BCApps/blob/main/src/Layers/W1/BaseApp/Inventory/Ledger/ItemLedgerEntry.Table.al) beside [Value Entry, 5802](https://github.com/microsoft/BCApps/blob/main/src/Layers/W1/BaseApp/Inventory/Ledger/ValueEntry.Table.al); [Item Application Entry, 339](https://github.com/microsoft/BCApps/blob/main/src/Layers/W1/BaseApp/Inventory/Ledger/ItemApplicationEntry.Table.al); [Inventory Adjustment, codeunit 5895](https://github.com/microsoft/BCApps/blob/main/src/Layers/W1/BaseApp/Inventory/Costing/InventoryAdjustment.Codeunit.al); [Sales-Post, codeunit 80](https://github.com/microsoft/BCApps/blob/main/src/Layers/W1/BaseApp/Sales/Posting/SalesPost.Codeunit.al); [Cust. Ledger Entry, 21](https://github.com/microsoft/BCApps/blob/main/src/Layers/W1/BaseApp/Sales/Receivables/CustLedgerEntry.Table.al) with [Detailed Cust. Ledg. Entry, 379](https://github.com/microsoft/BCApps/blob/main/src/Layers/W1/BaseApp/Sales/Receivables/DetailedCustLedgEntry.Table.al); [Dimension Set Entry, 480](https://github.com/microsoft/BCApps/blob/main/src/Layers/W1/BaseApp/Finance/Dimension/DimensionSetEntry.Table.al); [General Posting Setup, 252](https://github.com/microsoft/BCApps/blob/main/src/Layers/W1/BaseApp/Finance/GeneralLedger/Setup/GeneralPostingSetup.Table.al); [G/L Account, 15](https://github.com/microsoft/BCApps/blob/main/src/Layers/W1/BaseApp/Finance/GeneralLedger/Account/GLAccount.Table.al) and its Direct Posting flag | Separate quantity and value ledgers; cost adjustment by new entries; dimension sets; posting setup; control accounts; open items with dated applications |
| Business Central design notes: [cost adjustment](https://learn.microsoft.com/en-us/dynamics365/business-central/design-details-cost-adjustment), [GL reconciliation](https://learn.microsoft.com/en-us/dynamics365/business-central/design-details-reconciliation-with-the-general-ledger), [dimension sets](https://learn.microsoft.com/en-gb/dynamics365/business-central/design-details-dimension-set-entries-overview), [posting groups](https://learn.microsoft.com/en-au/dynamics365/business-central/finance-posting-groups) | Adjustments are new value entries dated with the related invoice, or the first open date when that period is closed. Each dimension combination is stored once and referenced by ID | The backdating rule; the dimension\_set table; posting setup as business group × product group |
| SAP S/4HANA: [universal journal](https://learning.sap.com/courses/outlining-cost-management-and-profitability-analysis/discussing-the-concept-of-the-universal-journal_f62cf151-5562-44f5-8ff6-df16fb232e94), [MATDOC](https://community.sap.com/t5/enterprise-resource-planning-blog-posts-by-sap/sap-s-4hana-inventory-management-tables-new-simplified-data-model-nsdm/ba-p/13497469), [Business Accelerator Hub](https://learning.sap.com/courses/devoloping-soap-web-services-on-sap-erp/exploring-apis-in-the-sap-universe_c765ebfe-26e4-44ae-9c85-cda235bf9da2) | ACDOCA holds FI and CO line items with cost center, project and order on each line. MATDOC keeps material documents in one insert-only table, which SAP says solved its lock issues. The hub lists 2,700+ APIs plus CDS views and events | One GL line table with every dimension; insert-only ledgers instead of hot total rows; API and field checklists |
| Oracle NetSuite: [SuiteScript Records Browser](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4267255811.html) | Every standard record type, its fields, sublists and joins | Field-level checklist for master data and transactions |
| Dynamics 365 Finance: [extensibility](https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/extensibility/extensibility-home-page) | Extension is the only customization framework; overlayering isn't supported, so updates don't break custom code | Packs extend only through declared extension points |
| Odoo: [stock design notes](https://github.com/odoo/odoo/blob/14.0/addons/stock/doc/stock.rst) | Stock moves between two locations, a "double-entry concept" with virtual supplier, customer, production and loss locations | The location model |
| ERPNext: [immutable ledger](https://docs.frappe.io/erpnext/immutable-ledger-in-erpnext), [payment ledger](https://docs.frappe.io/erpnext/payment_ledger), [repost item valuation](https://docs.frappe.io/erpnext/repost-item-valuation) | Cancelling keeps the original rows and adds reversals. A separate ledger tracks which invoice each amount settles. A backdated stock entry triggers a repost of later stock and GL entries that can change closed years | Reversals instead of deletes; open items with settlements; the counter-example behind the backdating decision |

### Where REA is used

REA connects a coding agent to tools for native binaries, JavaScript and Electron apps, .NET assemblies, websites and saved network captures. Its README limits it to lawful research and to software you own or are authorized to examine ([REA](https://github.com/morluto/rea)).

| Target | REA? | Why |
| --- | --- | --- |
| Odoo and ERPNext running on your machine | Yes | Open source and yours to run. Record a HAR file of each lab scenario; REA inspects the saved capture offline, request by request with its payload; you match the call that posts to the lab step that caused it, then read that method's source |
| Your own ERP | Yes | The same capture of the same scenario shows where your flow departs from the references |
| Business Central | Not needed | Its application source is public, and a free trial runs the lab scenarios as a black box; decompiling would show less than the code does |
| SAP, NetSuite, Workday and other hosted ERPs | No | Their posting logic runs on their servers, so a browser sees only screens and API calls, and their terms typically forbid reverse engineering. Their published models show more |

TallyPrime joins the lab as a black box too: the scenarios run in a licensed copy or its educational mode, and only its reports are compared, never its code. Declined, whatever the brief asks: decompiling, scraping or automating hosted proprietary ERPs, or anything their license forbids. Their published data models are read instead.

### The scenario lab

The lab turns research into tests: each scenario is a short run of business events, and the rows the reference ERPs write become this ERP's expected rows, replayed in CI.

1. Run current Odoo Community and ERPNext in Docker, each with a Bangladesh-style company: BDT, a July–June year, 15% VAT.
2. Click through each scenario below with a HAR capture running.
3. Export the journal entries and stock valuation rows each system wrote.
4. Where they agree, that becomes the expected result. Where they disagree, check Business Central's source and the accounting standard, decide, and log the decision.
5. Save the scenario as YAML; the posting engine's tests replay every scenario on every commit.

| ID | Scenario | What it proves |
| --- | --- | --- |
| O2C-01 | Cash sale with VAT, invoice and delivery together | Revenue, VAT and cost of sales in one posting; statutory numbering |
| O2C-02 | Order 100, deliver 60, invoice 60, two part payments | Partial flows, settlement and fulfilment status |
| O2C-03 | Return 10 after invoicing | Credit note; restock at the original cost |
| O2C-04 | Customer advance, then invoice, then the advance applied | Advances as open items |
| O2C-05 | Post-dated cheque received, deposited, bounced | Cheque states; reversal plus bank charge |
| O2C-06 | Sale to a customer that withholds VAT at source | Receivable settled partly by a withholding certificate |
| O2C-07 | Price-list change mid-month; line and document discounts | Effective-dated prices; discount allocation |
| O2C-08 | bKash collection with the wallet fee deducted | Wallet account; fee expense |
| P2P-01 | Order, partial receipt, bill at the order price | Stock received not billed clears exactly |
| P2P-02 | Bill above the order price, goods still in stock | The variance is added to inventory value |
| P2P-03 | Bill above the order price, goods already sold | The variance goes to cost of sales instead |
| P2P-04 | Freight and labour billed separately | Landed cost allocated to the received items |
| P2P-05 | Return to supplier with a debit note | Reversal at receipt cost |
| P2P-06 | Supplier advance, bill, payment with income tax withheld | Advance settlement; withholding liability |
| P2P-07 | Purchase in USD paid at a later rate | Realized exchange gain or loss |
| INV-01 | Receipts at 10 then 12; one issue across both | FIFO versus moving average |
| INV-02 | Receipt backdated before an issue already posted | Cost adjustment by new value entries; nothing rewritten |
| INV-03 | Count finds a shortage and a surplus | Adjustments to loss and gain |
| INV-04 | Transfer between two warehouses | Quantity moves, value unchanged |
| INV-05 | Two users deliver the last unit at once | One succeeds, one is refused (test T33) |
| INV-06 | Issue from a location that allows negative stock, receipt later | Provisional cost, then cost adjustment |
| FIN-01 | Bank statement with charges and an unknown deposit | The reconciliation queue |
| FIN-02 | Post into a locked period; reopen with permission | Lock dates per ledger; the reopen is audited |
| FIN-03 | Year-end close | Profit to retained earnings; opening balances carried |
| FIN-04 | Cancel an invoice in an open period, then in a filed one | Exact reversal; after filing, a credit note is required |
| FIN-05 | Opening balances from a legacy trial balance | The system's trial balance equals the legacy one |
| FIN-06 | Three lines of 33.333 with VAT | The rounding difference goes to the rounding account |

Each scenario is a file like this one. The values are this plan's expectation until the lab confirms them:

```yaml
id: P2P-02
title: Bill above the order price, goods still in stock
given:
  company: { currency: BDT, vat_rate: 0.15 }
  item: { sku: FAN-56, valuation: moving_avg, on_hand: 0 }
steps:
  - purchase_order: { supplier: S1, lines: [{ sku: FAN-56, qty: 100, price: 2000 }] }
  - goods_receipt:  { from: 1, qty: 100 }
  - supplier_bill:  { from: 2, price: 2100, tax: VAT }
expect:
  gl:                                    # company currency; debit +, credit -
    - { step: 2, account: inventory,           amount:  200000 }
    - { step: 2, account: received_not_billed, amount: -200000 }
    - { step: 3, account: received_not_billed, amount:  200000 }
    - { step: 3, account: inventory,           amount:   10000 }   # stock still on hand
    - { step: 3, account: vat_input,           amount:   31500 }
    - { step: 3, account: payable,             amount: -241500 }
  stock: { FAN-56: { qty: 100, value: 210000 } }
```

The references already disagree once, and the plan takes a side. After a backdated receipt, ERPNext reposts later entries and can change closed years; Business Central posts new adjustment entries in the first open period. This plan follows Business Central (decision D5).

## Who it's for first

The first customer is a Bangladeshi trading company: small enough for a one-person parallel month, real enough to test every Must feature. Your own building is tenant zero, with no customer at risk.

### The pilot company

The Gate 1 pilot must meet every criterion below. Together they exercise each Must feature and nothing beyond it.

| Criterion | Requirement | Why |
| --- | --- | --- |
| Business | Trading or distribution of physical stock | Exercises inventory, order-to-cash and procure-to-pay together |
| Size | One company; at most 2 warehouses, 5,000 SKUs and 3,000 documents a month | Fits Phase 1 scope and a one-person parallel run |
| Currency | BDT only | Foreign-currency documents ship in Phase 3 |
| Tax | VAT-registered | Tests the tax engine and registers against a real filed return |
| Money | Bank, cash and a mobile wallet; some credit sales and cheques | Tests reconciliation, settlement and cheques |
| Records | Shares last month's documents, bank statement and stock count under an NDA | A parallel run needs the real inputs |
| Accountant | Its accountant agrees to review the results | Gate 1 needs a sign-off |

### Tenant zero: your building

Your 50-room building runs rent invoices, security deposits, utilities and repairs on the system from the Phase 0 walking skeleton. Until Phase 2 it uses generic invoices; the rental pack then adds units, leases and automatic rent runs. It is also the first pack, proving the pack contract on data you control.

### Why a company would switch (hypotheses to test)

1. VAT registers and Mushak challans are built in; ERPNext, for comparison, needs [an add-on](https://ecosire.com/apps/erpnext/erpnext-bangladesh-vat-mushak) for them.
2. Bangla and English side by side, with lakh and crore grouping and amounts in words.
3. bKash, Nagad, cash and cheques are first-class money, not workarounds.
4. Approvals and stock counts work on a phone.
5. Priced for SMEs, with support in Bangla.

Hypothesis 1 is the weakest: ERPNext already has Bangladesh VAT apps on [Frappe's marketplace](https://cloud.frappe.io/marketplace/apps/vat_compliance), so the edge to test is depth, accuracy and support, not whether Mushak forms exist. The interviews also test who a prospect would leave:

| Alternative | Likely reason it's chosen (to verify) | What to learn in interviews |
| --- | --- | --- |
| TallyPrime | Familiar to accountants; quick for books and VAT | What it can't do for stock, orders and approvals, and what owners pay to work around that |
| ERPNext with a Bangladesh VAT app | Open source, broad modules, local implementers | Total cost with an implementer, and how closely the app follows Mushak practice |
| Odoo with a local partner | Polished interface and a large app catalog | Where per-user pricing and customization costs push them |
| Local Bangladeshi ERPs | Local support and VAT forms | Price, lock-in, and how they handle NBR software approval |
| Spreadsheets | Free and familiar | Which month-end or VAT pain would make them switch at all |

### Validate before Phase 1

- Interview 10 owners or managers and 5 accountants of target firms: how they keep books, what breaks at month-end and VAT time, what they pay today.
- Get 3 candidate pilots to agree in writing to a parallel run under an NDA.
- Kill-or-redirect rule: fewer than 3 commitments by the end of Phase 0 means re-picking the segment before building Phase 1 depth.
- Test pricing in the same interviews: a monthly fee per company plus per active user, with packs as add-ons. No price is set before then.
- You bill your own customers from your own tenant, so the ERP is its own first invoicing customer.

## Tiers: one tier per phase

A feature's tier is the phase it ships in, so the tiers and the roadmap can't disagree.

| Tier | Ships in | Means | Proved by |
| --- | --- | --- | --- |
| Must | Phases 0–1 | Without it a company can't keep its books, stock and orders on the system | Gate 1: a real company's parallel month reconciles |
| Need | Phase 2 | Without it the first paying customer can't go live: statutory forms, approvals, printing | Gate 2: a paying go-live |
| Should | Phase 3 | Expected by mid-sized buyers comparing with Odoo or Business Central | Gate 3: a second industry goes live |
| Nice | Phase 4 | Differentiators that win deals | Gate 4: scale and AI targets |
| Later | When a customer pays for it | Enterprise depth | That customer's acceptance test |

1. Tier says when, not how much a feature matters to one customer. Bills of materials are vital to a factory but ship in Phase 3, because the first customers trade.
2. Moving a feature changes its phase too, and goes in the decision log.
3. The data model is complete from Phase 0 wherever retrofitting is expensive. Currency, company, dimensions and tenant are on every row before the features that use them ship, so a column existing doesn't mean its feature has shipped.
4. Inside a phase, each module ships its own minimum first: manufacturing starts with bills of materials, work orders and cost roll-up.

| Area | Must | Need | Should | Nice | Later | Total |
| --- | --- | --- | --- | --- | --- | --- |
| Platform and kernel | 15 | 7 | 6 | 4 | 1 | 33 |
| Finance and accounting | 18 | 1 | 9 | 3 | 4 | 35 |
| Sales | 6 | 2 | 7 | 3 | 3 | 21 |
| Procurement | 6 | 1 | 4 | 2 | 2 | 15 |
| Inventory and warehouse | 7 | 0 | 8 | 2 | 2 | 19 |
| Manufacturing and quality | 0 | 0 | 8 | 3 | 2 | 13 |
| HR and payroll | 0 | 0 | 10 | 3 | 1 | 14 |
| Projects, services and assets | 0 | 0 | 4 | 2 | 2 | 8 |
| Reporting, analytics and AI | 3 | 0 | 5 | 4 | 2 | 14 |
| **Total** | **55** | **11** | **61** | **26** | **19** | **172** |

Every core feature, with what it covers and a tier you can change from its dropdown, is in Feature map.

## Industry adaptability: the pack contract

Every industry is a pack built against a published contract. The core never imports a pack, and a pack never edits the core.

### Six layers of change, cheapest first

| Layer | What it changes | Who | Example |
| --- | --- | --- | --- |
| Configuration | Chart of accounts, taxes, numbering, units, posting setup, approval limits | Admin, no code | A trading firm switches off manufacturing |
| Custom fields and entities | New attributes and simple records | Key user, no code | GSM and fabric composition on items |
| Workflow and rules | States, approvals, notifications | Key user, low code | A purchase order over ৳5,00,000 needs a director |
| Industry pack | Documents, screens, reports, posting handlers | Developer, as a pack | Garments: style, color × size matrix, cut plan |
| Localization pack | Tax rules, statutory forms | Developer, as a pack | Bangladesh Mushak forms |
| Integration | External apps over the API and webhooks | Developer, outside the codebase | bKash, couriers, a storefront |

### The contract

A pack is a package in the monorepo, compiled into the same deployable and switched on per tenant. Its manifest declares everything it adds:

```typescript
// packs/rental/pack.ts
export default definePack({
  id: 'rental',
  version: '1.2.0',
  requiresCore: '^1.4.0',                    // semver range of the core's extension API
  entities: [Building, Unit, Lease, Meter],   // own tables in schema pack_rental: tenant_id keys, forced RLS
  docTypes: [RentRun, DepositReceipt],        // one lifecycle, numbering and audit via the document engine
  extends: {                                  // namespaced fields on core records, JSON-Schema validated
    party: { 'rental.emergency_contact': { type: 'string' } },
  },
  posting: [rentRunHandler],                  // returns a posting plan; only the engine writes ledgers
  hooks: { 'sales_invoice.beforePlan': addUnitDimension },  // declared extension points only
  permissions: ['rental.lease.manage', 'rental.unit.read'],
  setup: seedRentalAccounts,                  // runs when a tenant enables the pack
  ui: { slots: { 'unit.form.sidebar': MeterReadings } },
  reports: ['rent_roll', 'vacancy', 'deposit_liability'],
});
```

| A pack can | A pack cannot |
| --- | --- |
| Own tables in its own schema, with tenant\_id keys and forced RLS | Read or write core tables directly; it calls core services |
| Register document types, posting handlers, reports, permissions, jobs and print templates | Write ledger rows; only the posting engine does |
| Add namespaced fields to core records | Change a core field's meaning or validation |
| Hook declared extension points | Patch core code or another pack's internals |
| Ship seed data, such as accounts and posting setup, applied when a tenant enables it | Be uninstalled once a tenant has submitted documents with it; it can only be disabled, which makes it read-only |

### Many tenants, one database

- Code is shared: every tenant runs the same build. A pack's tables exist for all tenants and hold rows only for those using it.
- tenant\_pack records who enabled what. For a disabled pack, the API refuses its endpoints, menus hide it and jobs skip it.
- Migrations are forward-only and expand-then-contract, so no deploy breaks a running tenant. Per-tenant data changes run as background jobs.
- The core's extension API follows semver; a breaking change ships behind a deprecation warning for one minor version first.

### How the contract is enforced

- A dependency-cruiser rule fails the build if the core imports a pack, or a pack imports another pack's internals.
- CI flags any pack pull request that touches core files; it needs an explicit extension-API review.
- The core ships a contract test suite every pack must pass: forced RLS on its tables, balanced posting plans, declared permissions, English and Bangla labels.
- The gates prove it: the rental pack ships with zero core changes at Gate 2, and a second industry pack does the same at Gate 3.

### The first packs

| Pack | Tier | Adds | Reuses from the core |
| --- | --- | --- | --- |
| Bangladesh localization | Must for rules, Need for forms | VAT rates and registers, withholding, Mushak forms, return data | Tax engine, documents, print designer |
| Property rental | Need | Buildings, units, leases, rent runs, deposits, meters, maintenance tickets | Recurring invoices, receivables, advances, payables |
| Trading and distribution | Should | Route and van sales, secondary sales, scheme discounts | Sales, inventory, pricing |
| Retail | Should | Point of sale, cash sessions, fiscal device (EFD/SDC) link | Sales, inventory |
| Garments manufacturing | Should | Buyer orders and styles, color × size matrix, fabric consumption, cut-sew-finish stages, CMT subcontracting, export LC and shipment | Bills of materials, work orders, subcontracting, sales |
| Services and agencies | Should | Retainers, milestone billing | Projects, receivables |
| Clinics, construction, education | Later | Appointments; bills of quantities and retention; student fees | Parties, projects, recurring billing |

## Bangladesh localization

Bangladesh rules live in the localization pack as dated data, because budgets change them. Even current sources disagree on how often the VAT return is filed, which is why its period is a setting, not code.

| Requirement (source) | What the system does | Tier |
| --- | --- | --- |
| Income year runs July to June; banks, insurers and financial institutions use the calendar year ([PwC, reviewed 31 Jul 2026](https://taxsummaries.pwc.com/bangladesh/corporate/tax-administration)) | Fiscal year set per company, July by default | Must |
| VAT is 15% standard with reduced rates from 1.5% to 10%; supplementary duty of 10–67% is charged once, at the first stage of supply ([PwC](https://taxsummaries.pwc.com/bangladesh/corporate/other-taxes)) | Tax rules per item category, effective-dated; supplementary duty is its own tax code | Must |
| VAT registration above BDT 5 million turnover; 4% turnover tax between BDT 3 and 5 million ([PwC](https://taxsummaries.pwc.com/bangladesh/corporate/other-taxes)) | A company setting chooses VAT or turnover tax; thresholds are data | Must for VAT, Should for turnover tax |
| Mushak 9.1 return: PwC describes quarterly filing within 15 days of quarter-end, monthly optional; a [2026 practitioner guide](https://rakibhassan.eu/mushak-9-1-vat-return-guide-for-bangladesh-2026/) says monthly by the 15th | Return period and due date are company settings; the return's figures come straight from the VAT registers | Need |
| Mushak 6.3 tax invoice per sale, with credit and debit notes for later changes | A gapless 6.3 series per branch; once a tax period is locked, cancelling is blocked and a credit note is required (test T26) | Must for rules, Need for print |
| VAT deducted at source: government bodies, banks, insurers and limited companies withhold 2–15% when paying vendors ([PwC](https://taxsummaries.pwc.com/bangladesh/corporate/other-taxes)) | As seller, the receivable is settled partly by a withholding certificate; as buyer, the system deducts and issues one | Must for rules, Need for certificates |
| Income tax withheld at source on payments where the law requires it | Rates by payment type kept as dated data, set with your tax adviser; certificates tracked | Must |
| NBR has required electronic fiscal devices (EFD or SDC) in some sectors, such as highway hotels and restaurants ([Financial Express, 3 Mar 2025](https://today.thefinancialexpress.com.bd/print/installation-of-efdsdc-mandatory-at-hotels-restaurants-located-on-highways-nbr-1740937651)) | The retail pack links point of sale to the device | Should |
| Parliament passed the Personal Data Protection Bill, 2026 on 9 Apr 2026 ([BSS](https://www.bssnews.net/js-session/376218)); a [legal summary](https://securiti.ai/bangladesh-personal-data-protection-act-overview/) describes limits on large-scale transfers of national ID, passport and tax ID numbers abroad | An ERP stores tax IDs for every party, so hosting location is decided with a lawyer's written opinion in Phase 0 (decision D11). A breach runbook and consent records for employee data come with it | Must |
| Bangla and English, lakh and crore grouping, the ৳ sign, amounts in words | Both languages in UI and print; PDFs rendered by headless Chromium and checked against a Bangla conjunct test page | Must for UI, Need for print |
| Mobile wallets (bKash, Nagad), cash and cheques, including post-dated ones | Wallets are bank-type accounts with fee rules; cheques carry states from received to cleared or bounced | Must, Need for the post-dated register |
| Payroll rules: income tax on salary, provident fund, festival bonuses, Labour Act leave and overtime | Ship with payroll in Phase 3, never after it | Should |
| Input VAT is claimable only if a supply above BDT 100,000 was paid through a bank, the claim falls in the month of receipt or the next six months, and the supplier charged the standard 15% (PwC tax summary) | Each purchase tax line records how it was paid and its claim deadline. The pack claims what qualifies, holds the rest as pending input VAT, and moves what expires into cost | Must |
| Traders who don't take input credit file Mushak 9.1.1 instead of 9.1 (PwC tax summary) | The return builder makes either form from the same register, by the company's registration type | Need |
| VAT is charged on value plus supplementary duty (PwC's worked example) | Tax rules carry a calculation order and a compound flag, so VAT's base includes SD on the same line | Must |
| With prior-year sales above BDT 50 million, NBR-approved VAT software integrated with the ERP or accounting system is mandatory; software used below that for statutory registers and returns must also be NBR-approved (PwC tax summary) | Until approved, the system feeds an NBR-approved VAT system and its own registers are working copies; apply for approval before Gate 3 | Need |
| Open question: whether an advance payment creates a VAT tax point. The sources checked don't say; confirm with a VAT consultant before Gate 1 | Advances post as open items; the tax engine can add a tax line at receipt once confirmed | Need |

Each budget can change rates and thresholds. The pack ships a reviewed update before new rules apply, and the engine picks a rate by its tax-point date, so documents on both sides of a change come out right. A VAT consultant reviews this table before Phase 1 and after every budget.

## Architecture

One deployable, one database, one posting engine: a modular monolith whose seams are drawn so it can split later without touching the ledgers.

&#91;embedded content: architecture · clients, kernel, modules, posting engine, database\]

Read it top down: every client calls one API, the kernel gives every document the same lifecycle and audit, and modules and packs hand posting plans to one engine that writes every ledger in one transaction.

### Module boundaries

- Modules: kernel (tenancy, auth, metadata, documents, audit, jobs), finance, tax, inventory, sales and purchasing, with packs on top.
- Each module owns a PostgreSQL schema and exposes a service interface. Others call it in-process or react to its events; no module reads another's tables.
- The posting engine is the only writer of ledgers. Modules and packs hand it posting plans.

### Stack decisions

| Concern | Decision | Why | Revisit when |
| --- | --- | --- | --- |
| Shape | Modular monolith in NestJS | One deploy and one transaction per posting; module seams allow a split later | A module needs separate scaling or its own team |
| Database | PostgreSQL 16 or later | Forced RLS, partitioning, NUMERIC, transactional DDL; the kernel is tested on 16.15 | — |
| Data access | Drizzle ORM for CRUD, hand-written SQL for posting | Posting needs row locks, deferred constraints and per-transaction settings | — |
| Tenancy | Shared schema, forced RLS, tenant\_id leading every key; the API connects as erp\_app, never as a superuser or a role with BYPASSRLS such as a platform's service role | Cheapest to run and enforced by the database; a large tenant can move to its own database without key changes | A contract or a tenant's load needs dedicated hosting |
| IDs | UUIDv7, from the app or from PostgreSQL 18's uuidv7() | Time-ordered keys keep index inserts local, unlike UUIDv4 ([Nile](https://thenile.dev/blog/uuidv7)) | — |
| Jobs and events | Postgres-backed queue (pg-boss) | A job is enqueued in the posting transaction, so none is lost or phantom, and there is one less service to run | The load test shows the queue limiting throughput |
| Money | NUMERIC in the database; a decimal.js Money type in TypeScript | No float drift | — |
| API | REST with OpenAPI, Zod validation, idempotency keys | Web, mobile and integrations share one contract | — |
| Frontend | Next.js, TanStack Query and Table, shadcn/ui; metadata-driven forms and lists; keyboard-first line entry | Accountants enter hundreds of lines a day; one renderer draws every form, custom ones included | — |
| PDF | Headless Chromium rendering the same HTML templates | Bangla conjuncts shape correctly; screen and print match | — |
| Files | S3-compatible object storage | Attachments stay out of the database | — |
| Search | PostgreSQL full-text search and pg\_trgm | No extra service until load proves one is needed | Search misses its latency target |
| Auth | Server-side sessions in httpOnly cookies, argon2id, TOTP; OIDC for SSO in Phase 3 | Standard, auditable, revocable | — |
| Hosting | Containers in one region, chosen in Phase 0 by a latency test from Dhaka and the data-protection opinion | Where the data may live is a legal question first | — |
| Observability | OpenTelemetry traces and metrics, structured logs | Vendor-neutral | — |

## How posting works

Submitting a document is one database transaction: lock, plan, check, write, commit. Either every ledger row lands, or none does.

### The submit pipeline

1. **Validate.** Metadata rules, permissions and segregation-of-duties checks run on the draft. Field errors return before any lock is taken.
2. **Begin and set the tenant.** One transaction, with `set_config('app.tenant_id', …, true)` as its first statement.
3. **Lock in a fixed order:** the document row, then the number series, then stock balances sorted by item and location, then the open items being settled. Every writer uses this order, so two submits wait for each other instead of deadlocking.
4. **Plan.** The document type's handler builds a posting plan as a pure function: stock moves, value entries, GL lines, open items, settlements, tax lines. Accounts come only from posting setup, rates only from tax rules.
5. **Cost.** The cost engine prices each outgoing move from FIFO layers or the moving average.
6. **Check.** The engine rejects a plan that doesn't balance per company, touches a locked ledger, lacks a required dimension or posts manually to a control account. The database repeats the critical checks.
7. **Write and commit.** Journal, ledger rows, balances, document status and number, the audit row and queued jobs commit together. Deferred checks run at COMMIT.
8. **Retry safely.** On a deadlock or serialization failure the API retries up to three times under the same idempotency key, so a client never sees a double post.

### Posting rules

| Situation | Rule | Basis |
| --- | --- | --- |
| Account choice | The posting-setup row with the most exact matches (party group, product group, location group) wins; ties are rejected when the setup is saved | Business Central posting groups |
| Tax | The rule matching party tax group, item tax category and direction, with the latest valid\_from on or before the tax-point date | Rule 7 |
| Receipt before bill | The receipt debits inventory and credits "stock received not billed" at the order price. The bill clears it; a price difference adds to inventory value for stock on hand and goes to cost of sales for stock already issued | Business Central interim accounts; P2P-02, P2P-03 |
| Costing | FIFO consumes the oldest open layer; moving average recomputes on each receipt. Valuation is per company by default | INV-01 |
| Backdated or late costs | Allowed only in open periods. Later outgoing entries are corrected by new adjustment value entries dated with their cause, or the first open date if that period is closed; nothing posted is rewritten | Business Central cost adjustment; decision D5 |
| Negative stock | Off by default; a location can allow it. An issue into negative is costed at the last known cost and corrected by cost adjustment when the receipt posts | INV-06 |
| Settlement | Payments and credit notes settle invoices through dated settlement rows, so aging as of any past date is exact. Exchange differences post at settlement | ERPNext payment ledger |
| Rounding | Amounts round per line to the currency's minor unit; a residual within tolerance goes to the rounding account | FIN-06 |
| Cancellation | Allowed only while no lock date covers the document. The reversal journal is dated on the document's own posting date, so it nets to zero in its own period and VAT register. After a lock, the fix is a credit or debit note | Tests T25, T26 |
| Numbering | Statutory series are gapless: taken under a row lock inside the submit transaction, one series per branch or register to spread the contention. Other series use sequences and may skip numbers | Mushak 6.3 |

## Ledger kernel schema

The kernel is 29 tables plus yearly partitions, written as runnable SQL and tested on PostgreSQL 16.15: all 119 tests pass, four runs in a row, including five that race real sessions against each other. The full DDL, test script and output are in Kernel schema.

The database enforces structure: tenant isolation, balanced and sealed journals, control accounts equal to their subledgers per customer, supplier and item, stock valued move by move, lock dates on every ledger, the document lifecycle, gapless numbers, and stock that never goes negative unless a location allows it. The golden scenarios enforce semantics: that the posting engine picks the right accounts, rates, costs and dates.

| Group | Tables | Rule |
| --- | --- | --- |
| Tenancy | tenant, tenant\_pack | A tenant sees only its own row |
| Master data | company, account, party, party\_role, item, uom\_conversion, location | tenant\_id leads every key; foreign keys also carry company\_id when both rows belong to a company; types are fixed once used |
| Rules as data | posting\_setup, tax\_rule, dimension\_set, posting\_lock, number\_series | Changes are audited; a tax rule used in a filed period is never edited; numbers advance only at submit |
| Documents | document, document\_line | Created as drafts; submit assigns the number and freezes the buyer; cancelling needs every journal reversed |
| Ledgers | journal, gl\_line, stock\_move, stock\_value\_entry, tax\_line, settlement, cost\_application | SELECT and INSERT only; every journal is checked at COMMIT; the four that grow with every line are partitioned by year |
| Subledger | open\_item | Its remaining amount changes only through settlements |
| Derived state | stock\_balance, cost\_layer, period\_balance | On-hand stock changes only through stock moves; the rest rebuild from the ledgers and are compared nightly |
| Audit and checks | audit\_log, journal\_check | Written only by the database |

The isolation core, as it runs:

```sql
REVOKE TEMPORARY ON DATABASE erp FROM PUBLIC;   -- no temporary table can shadow a real one
CREATE ROLE erp_app LOGIN NOBYPASSRLS;          -- the API's only role; owns nothing

CREATE FUNCTION public.app_tenant() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT pg_catalog.current_setting('app.tenant_id')::pg_catalog.uuid $$;  -- unset: error, not zero rows

-- every table with tenant_id, in every schema, partitions included (test K01 fails if one is missed)
ALTER TABLE company ENABLE ROW LEVEL SECURITY;
ALTER TABLE company FORCE  ROW LEVEL SECURITY;      -- binds the table owner too
CREATE POLICY tenant_isolation ON company
  USING (tenant_id = public.app_tenant()) WITH CHECK (tenant_id = public.app_tenant());
```

The commit-time check: every journal and every ledger row queues its journal after the row is written, and a deferred trigger checks each queued journal once, at COMMIT:

```sql
CREATE TRIGGER t90_queue AFTER INSERT ON gl_line        -- and on every other ledger table
  FOR EACH ROW EXECUTE FUNCTION public.queue_journal(); -- a row added after an early check queues it again
CREATE CONSTRAINT TRIGGER journal_valid AFTER INSERT ON journal_check
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_journal();
-- check_journal: not empty; balanced; each control account equals its subledger per party,
-- item or tax account; every stock move valued once; reversals mirror and settle; document rules
-- T10:  lines of +1000 and -900 → "journal … is out of balance by 100.0000" at COMMIT
-- H05b: SET CONSTRAINTS ALL IMMEDIATE, then a 1,000,000 line → refused
```

Why each guard is in the database and not only in code: the PostgreSQL manual says table owners normally bypass row security unless it is forced, and that superusers and BYPASSRLS roles always do ([row security policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)). A guard that lives only in application code is one forgotten filter away from a leak.

Module tables arrive with their phases and follow the same conventions: price lists, payment terms, cheques, bank statements and matches, fixed assets, bills of materials, work orders, employees, payroll runs, projects, attachments, comments, workflow states and idempotency keys.

## Scalability

Scale comes from the data model, not from microservices: append-only ledgers, no hot total rows, and keys that let a tenant move out. Each number below is a target that a named test must prove.

### Capacity targets

| Target | Value | Proved by | First checked at |
| --- | --- | --- | --- |
| Tenants on one database cluster | 100 by Gate 2; designed for 1,000 | Synthetic tenants in a load test | Gate 2, then Gate 4 |
| Largest tenant | 20,000 documents and 250,000 GL lines a month | A seeded load test at twice that volume | Gate 1 |
| Concurrent active users | 50 per tenant; 1,000 across the platform | k6 scripts | Gate 2 |
| Submit a 50-line invoice | p95 under 500 ms, server side | k6 against staging with production-sized data | Gate 1 |
| Load a 50-row list page | p95 under 200 ms | k6 | Gate 1 |
| Trial balance for any range, largest tenant | Under 3 s | Load test | Gate 1 |
| Recovery | At most 5 minutes of data lost; restored within 4 hours, 1 hour by Phase 4 | A restore drill into a fresh environment | Gate 0, then monthly |
| Availability | 99.5% a month through Phase 3 | An external uptime monitor | Gate 2 |

### Hot spots

| Hot spot | Risk | Design |
| --- | --- | --- |
| GL account totals | Every posting updating one "Sales" total row would queue a company's postings behind each other | No total rows for open periods: figures come from indexed lines, and closed periods keep frozen snapshots. SAP moved inventory to insert-only MATDOC for the same lock problem |
| Stock balance | Two deliveries of the last unit | One locked row per item, location and lot, so contention is per SKU, not per company (T33) |
| Gapless numbering | Every invoice waits for the series lock | One series per branch or register; gapless only where the law requires it |
| Cost adjustment | A backdated receipt touching thousands of later issues | A per-item background job, coalesced, dating each adjustment with its cause, or the first open date if that period is locked |
| Imports and month-end reports | Long scans slowing the sales counter | Background jobs now; a read replica for reports and BI in Phase 3 |
| Partition upkeep | A posting date with no partition fails | A job creates yearly partitions two years ahead and alerts if one is missing |

### Scaling path

1. One PostgreSQL primary with forced RLS (Phases 0–2).
2. A read replica for reports and BI (Phase 3).
3. The largest tenants move to their own database; keys already lead with tenant\_id, so their rows move unchanged (Phase 4, or sooner by contract).
4. Sharding by tenant only if many large tenants share a cluster (Later).

## Security, privacy and access control

The requirement baseline is [OWASP ASVS](https://owasp.org/projects/asvs?tab=asvs-users) 5.0 at Level 2, checked by an external penetration test before the first paying go-live.

| Area | Control | Tier |
| --- | --- | --- |
| Tenant isolation | Forced RLS, tenant\_id in every key, and the isolation tests in CI (T01–T07, T31, T32) | Must |
| Sign-in | argon2id passwords; TOTP required for admins and finance approvers; session revocation; lockout after repeated failures | Must |
| Permissions | Deny by default. Roles carry record rules (only my branch) and field rules (hide cost price), checked in the service layer and tested per role | Must |
| Injection | Parameterized queries only. The tenant setting comes from the authenticated session, never from input, because arbitrary SQL could change it | Must |
| Segregation of duties | Maker-checker on payments and journals. A change to a supplier's bank account needs a second approver and notifies the supplier's contact | Need |
| Audit | Every change written with old and new values in the same transaction; hash-chained per tenant from Phase 3 | Must, Should for hash chain |
| Secrets and transport | TLS everywhere, encrypted backups, secrets in a secret manager, none in the repository | Must |
| Support access | Impersonation only with the tenant's consent, time-boxed and audited | Need |
| Files | Type and size checks on upload; malware scanning from Phase 3 | Must, Should for scanning |
| Abuse | Rate limits per user now, per API key when keys ship | Must |
| Supply chain | Dependency and secret scanning in CI; pinned versions | Must |
| Personal data | Hosting decided with a lawyer's opinion (D11); full tenant export on request; deletion at contract end, keeping what tax law requires | Must, Need for export |
| Verification | External penetration test against ASVS Level 2 | Need, before Gate 2 |

## Operations

One person can run this only if operations are automated from day one: one-command deploys, tested restores and alerts that reach your phone.

| Concern | Practice | From |
| --- | --- | --- |
| Environments | Local with Docker Compose; staging with production-sized synthetic data; production | Phase 0 |
| Releases | Trunk-based. Every merge runs the full suite and deploys to staging; production weekly, never on the eve of the Friday–Saturday weekend | Phase 0 |
| Migrations | Expand, migrate, contract: new columns are added and backfilled before anything stops using the old ones, so deploys need no downtime | Phase 0 |
| Feature flags | Per tenant, for pilots and gradual rollout | Phase 0 |
| Backups | Continuous WAL archiving for point-in-time recovery and daily encrypted off-site copies. A monthly drill restores into a fresh environment and compares row counts and trial balances | Phase 0, proved at Gate 0 |
| Monitoring | Error rate, p95 latency, failed jobs, queue depth, replica lag, disk, and the nightly integrity check's result | Phase 0 |
| Alerts | To your phone for an integrity mismatch, a failed backup, an error spike or posting latency over target | Phase 0 |
| Incidents | A runbook per alert; a short postmortem after any incident that touched a customer's data or books | Phase 2 |
| Support | Business hours written into contracts to match a one-person team; a status page; a second developer after Gate 2 revenue | Phase 2 |
| Month-end | A period-close calendar agreed with each customer; lock dates are set by their accountant, not by you | Phase 2 |

## Testing strategy

Accounting software is tested against invariants and real books, not screens. A wrong posting rule still balances, so a balanced trial balance alone proves nothing.

| Layer | What it checks | Tool | Runs |
| --- | --- | --- | --- |
| Unit | Posting planners, tax engine and cost engine as pure functions | Vitest | Every commit |
| Property | Random document sequences keep every invariant: journals balance, subledgers equal control accounts, stock stays non-negative where required, FIFO takes the oldest layer, posting then cancelling nets to zero | fast-check | Every commit (1,000 runs); nightly (10,000) |
| Golden scenarios | The 27 lab scenarios produce exactly their expected rows | YAML replayed by Vitest | Every commit |
| Database | Isolation, append-only ledgers, balance, locks, document guards, concurrency: the 37 kernel tests and their successors | psql or Testcontainers on real PostgreSQL | Every commit |
| Pack contract | Each pack's tables, postings, permissions and labels meet the contract | Suite shipped by the core | Every pack commit |
| Migration | Upgrade from the previous release with seeded data, then replay the golden scenarios | CI job | Every release |
| End to end | Order-to-cash, procure-to-pay and month-end close in a browser | Playwright | Nightly |
| Load | The capacity targets | k6 | Before every gate |
| Human | An accountant reviews the pilot's statements and reconciliations | Parallel run | Gates 1 and 2 |

### Definition of done, for every feature

- Posting rules and their golden scenarios, if it posts anything
- Permissions declared and tested per role
- Audit entries for every change it makes
- An API endpoint in the OpenAPI spec, with an idempotency key on writes
- Import and export wherever users manage lists of it
- English and Bangla labels
- A migration that is safe under expand-then-contract
- A per-tenant flag until its tier's gate passes
- Help text a user can reach from the screen

## Roadmap

&#91;embedded content: roadmap · 5 phases, 5 gates\]

Gate 1 matters most: an ERP that can't reproduce a real company's month, to the taka, isn't an ERP yet, however many screens it has.

### Exit gates

A phase ends only when every criterion of its gate passes. Dates follow from hours, never the reverse.

| Gate | Closes | Passes when all of these hold |
| --- | --- | --- |
| Gate 0 | Phase 0: foundations | A document type defined only in metadata goes draft, submit, cancel and amend with numbering, permissions and audit. The isolation suite passes on every table. A backup restores into a fresh environment with a matching trial balance. Your building's rent invoices, receipts and trial balance run on the walking skeleton in production |
| Gate 1 | Phase 1: books close | The property tests and every golden scenario except P2P-07 (foreign currency, now at Gate 3) pass. A real trading company's last month, started from its opening balances, reproduces its books: the bank reconciles to the statement to the taka; receivable and payable subledgers equal their control accounts and its party balances; stock value equals the inventory account and matches its count, with variances explained; VAT registers match the return it filed. Its accountant signs off the trial balance, profit and loss and balance sheet. Phase 1 capacity targets pass |
| Gate 2 | Phase 2: first go-live | A paying customer closes a full month live, not in parallel. Once the pack contract shipped, the rental pack needed zero core changes and your building runs on it. Mushak 6.3 invoices print and the return's figures supported a real filing. Before a customer relies on its VAT registers, the software holds NBR approval or feeds an NBR-approved VAT system. The external penetration test passed; the restore drill and incident runbook were rehearsed |
| Gate 3 | Phase 3: breadth | A second customer in another industry is live. Its pack shipped with no core change beyond published extension-API additions. Payroll with statutory deductions ran for a real company and its accountant verified it. Golden scenario P2P-07 (foreign currency) passes with multi-currency |
| Gate 4 | Phase 4: scale and AI | Capacity targets hold at 1,000 synthetic tenants. Every AI feature has a human approval step and an audit trail, and its error rate is measured on real tenant data |

### Effort and calendar (estimates)

One developer using AI coding assistants; focused hours, not elapsed time. Ranges, not promises: after Phase 0, divide actual hours by the Phase 0 estimate and rescale the rest. Add weeks for holidays, exams and day-job crunches.

| Phase | Builds | Focused hours | Weeks at 20 h/week | Weeks at 40 h/week |
| --- | --- | --- | --- | --- |
| 0 Foundations | Kernel, auth, metadata, documents, audit, API, jobs, backups, CI; the walking skeleton for your building (120–180 h of the total) | 400–650 | 20–33 | 10–17 |
| 1 Books and stock | Finance, tax, inventory, order-to-cash, procure-to-pay with landed cost, reports, opening-balance import, Tally and Excel transaction importers, scenario lab, parallel run | 1,200–1,840 | 60–92 | 30–46 |
| 2 First go-live | Pack contract, rental pack, Bangladesh forms, link to an NBR-approved VAT system, approvals, notifications, printing, custom fields, go-live support | 640–1,040 | 32–52 | 16–26 |
| **To first paying go-live** | **Phases 0–2** | **2,240–3,530** | **112–177** | **56–89** |
| 3 Breadth | Manufacturing and garments pack, HR and payroll, CRM, projects, point of sale, report builder, multi-currency | 1,500–2,500 | 75–125 | 38–63 |
| 4 Scale and AI | Sized when Phase 3 ends | — | — | — |

At 10 hours a week, first paying go-live is 224–353 weeks away: about 4.3–6.8 years. Treat all of these hours as the optimistic end. Scope like this tends to grow, and the Phase 0 rescale rule above is the correction.

### People

- A paid, part-time accountant adviser from Phase 1, a few hours a week: reviews posting rules, scenarios and reports.
- A VAT consultant before Phase 1 and after every budget; a lawyer's written opinion on hosting in Phase 0.
- A second developer once Gate 2 brings revenue.

### The next two weeks

1. Book the first 5 of the 15 interviews.
2. Run Odoo Community and ERPNext in Docker and capture five scenarios with HAR files: O2C-01, O2C-02, P2P-01, P2P-02, INV-01.
3. Create the monorepo, load the kernel schema and get its 119 tests running in CI.
4. Measure latency from Dhaka to two candidate regions; send the hosting question to a lawyer.
5. Build the walking skeleton's first flow: a rent invoice for one room, through to the trial balance.

## Risks

The biggest risk isn't technical: it's one part-time builder running out of time before Gate 1. Most mitigations exist to bring real use earlier and to keep you from being the only safety net.

| Risk | Likelihood | Impact | Early warning | Mitigation |
| --- | --- | --- | --- | --- |
| Time runs out before Gate 1 | High | High | Phase 0 takes 1.5 times its estimate | Walking skeleton live for your building in Phase 0; strict tiers; after Phase 0, cut Should scope, never Must |
| You are the only person who can fix it | High | High | The first customer signs | Runbooks, automated deploys and restores, a decision log; a second developer after Gate 2; source-code escrow offered to customers |
| A posting bug produces wrong books | Medium | High | The nightly integrity check or a scenario fails | Database guards, property tests, golden scenarios, a parallel run before go-live, an accountant's review |
| No pilot commits to a parallel run | Medium | High | Fewer than 3 commitments by the end of Phase 0 | Recruit during Phase 0; offer the parallel run free; re-pick the segment if needed |
| Data-protection law limits hosting abroad | Medium | High | The lawyer's opinion | Decide hosting in Phase 0 with that opinion; keep infrastructure portable: containers and standard PostgreSQL |
| One tenant sees another's data | Low | High | An isolation test or the penetration test fails | Forced RLS, composite keys, the isolation suite on every commit, a penetration test before Gate 2 |
| Tax rules change or are misread | High | Medium | A budget announcement; a consultant flags a rule | Rules as dated data; consultant review before Phase 1 and after each budget; a yearly pack update |
| Performance falls short | Medium | Medium | A load test misses a target | Targets tested before every gate; hot rows designed out; the scaling path ready |
| Free open-source ERPs win on price | Medium | Medium | Interviews show price decides | Win on Bangla-first use, built-in Mushak and local support; don't compete on breadth |
| Payment and courier APIs need slow merchant approvals | Medium | Low | Integration work is blocked | Apply for merchant and sandbox accounts in Phase 1, before Phases 2–3 need them |
| Your employment contract claims what you build (an IP or moonlighting clause) | Medium | High | The contract mentions inventions, outside work or company equipment | Read the clause before writing code; build only on your own time and hardware; get written permission if it's unclear |
| A VAT or Mushak error costs a customer penalties | Medium | High | A return's figures differ from the register, or a customer disputes a filing | VAT golden scenarios run on every release; the customer's accountant signs off each return; contracts cap liability at fees paid |
| NBR approval of the VAT software takes longer than Phase 2 | High | High | A prospect asks for the approval certificate | Feed an NBR-approved VAT system until the software is approved; apply before Gate 3 |

## Decision log and open questions

Eleven design decisions are made with their reasons; five product and legal questions stay open, each with the point by which it gets answered.

| ID | Decision | Status | Reason, or when it gets decided |
| --- | --- | --- | --- |
| D1 | Modular monolith in NestJS | Decided | One deploy and one transaction per posting; the seams allow a split later |
| D2 | Shared schema with forced RLS; tenant\_id leads every key | Decided | Isolation enforced by the database at the lowest running cost |
| D3 | Signed amounts in one GL line table | Decided | One SUM proves balance; one table carries every dimension, as in SAP's universal journal |
| D4 | Quantity and value ledgers kept apart | Decided | Costs can be corrected without touching quantities, as in Business Central |
| D5 | Backdated costs fixed by new adjustment entries, never by reposting | Decided | Closed periods stay closed; ERPNext's repost can change closed years |
| D6 | Negative stock off by default, allowed per location | Decided | A safe default, with an exception for counters that sell before receipts are posted |
| D7 | Postgres-backed job queue (pg-boss) | Decided | Jobs enqueue inside the posting transaction; one less service to run |
| D8 | Drizzle for CRUD, hand-written SQL for posting | Decided | Posting needs row locks, deferred constraints and per-transaction settings |
| D9 | Stock valued per company, per warehouse later as an option | Decided | Simpler costing; transfers don't change value |
| D10 | Cancellation reversals dated on the original posting date | Decided | The document nets to zero in its own period and VAT register; allowed only while that period is open and before the Mushak 6.3 is issued to the buyer; after that, a 6.7 credit or debit note |
| D11 | Hosting region and where data may live | Open | Phase 0: a latency test from Dhaka plus a lawyer's written opinion under the 2026 data-protection law |
| D12 | The pilot company | Open | Before Phase 1, from the three written commitments |
| D13 | Identity provider for SSO | Open | Phase 3, when SSO ships |
| D14 | Prices | Open | After the interviews |
| D15 | Payroll's statutory scope | Open | Before Phase 3, with an HR and tax adviser |
| D16 | Landed cost is Must; the foreign-currency scenario P2P-07 moves to Gate 3 | Decided | The pilot's parallel month needs landed cost for imported stock; multi-currency is a Should feature, so its scenario waits for Phase 3 |
| D17 | Rounding: half up to the currency's minor unit, per line, as the default; the mode is a currency setting | Decided, pending the VAT consultant | Set per tenant and currency in `currency_setting` (minor unit, and half_up, half_even, down or up). BDT starts at two places, half up. Revisit when the consultant advises on NBR's required method for VAT amounts |

Open questions the interviews and advisers answer:

- Will pilots share a real month's records under an NDA?
- Does the pilot file its VAT return monthly or quarterly?
- Which payment, courier and SMS providers do pilots already use?

What this plan can't promise: estimates are unproven until Phase 0 ends, tax rules change with every budget, and demand is a hypothesis until three companies commit. No plan survives a real company unchanged; the gates and this log are how this one changes on purpose.

## Glossary

| Term | Meaning |
| --- | --- |
| Control account | A GL account, such as trade receivables, whose balance must equal the sum of a subledger; manual journals can't post to it |
| Subledger | Detailed records (open items, stock entries) that add up to a control account |
| Posting setup | The table that picks an account from who (party group), what (product group) and where (location group) |
| Universal journal | One table of GL lines carrying every dimension, so reports need no reconciling |
| Value entry | A row that changes stock value without changing quantity, kept apart from the quantity ledger |
| Cost adjustment | New value entries that correct the cost of earlier issues after a late or backdated cost |
| FIFO, moving average | Two valuation methods: oldest cost first, or a running average recomputed at each receipt |
| Stock received not billed | The interim account between a goods receipt and the supplier's bill |
| Three-way match | Checking a supplier bill against the purchase order's price and the received quantity |
| Open item, settlement | An unpaid invoice, payment or advance, and the dated row that applies one against another |
| Lock date | The date up to which a ledger accepts no new postings |
| Parallel run | Re-entering a real company's past month in the new system and reconciling it to its existing books |
| Mushak 6.3 | Bangladesh's VAT tax invoice, issued per sale |
| Mushak 9.1 | Bangladesh's VAT return |
| VDS | VAT deducted at source by certain buyers when they pay a supplier |
| BIN, TIN | VAT registration number and income-tax identification number |
| Post-dated cheque | A cheque received now but dated for a later deposit |
| RLS | Row-level security: PostgreSQL policies that decide which rows a session can see or write |
| Walking skeleton | The thinnest end-to-end version of the system, deployed and used, before features are added |

## Sources

All opened on 5 Nov 2026. Business Central source files are linked individually in the evidence section.

ERP design and source

- [Microsoft BCApps repository: Business Central System Application, Business Foundation and Base Application, MIT license](https://github.com/microsoft/BCApps)
- [Microsoft Learn: design details, cost adjustment](https://learn.microsoft.com/en-us/dynamics365/business-central/design-details-cost-adjustment)
- [Microsoft Learn: design details, reconciliation with the general ledger](https://learn.microsoft.com/en-us/dynamics365/business-central/design-details-reconciliation-with-the-general-ledger)
- [Microsoft Learn: dimension set entries overview](https://learn.microsoft.com/en-gb/dynamics365/business-central/design-details-dimension-set-entries-overview)
- [Microsoft Learn: posting groups](https://learn.microsoft.com/en-au/dynamics365/business-central/finance-posting-groups)
- [Microsoft Learn: extensibility in finance and operations apps](https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/extensibility/extensibility-home-page)
- [SAP Learning: the universal journal](https://learning.sap.com/courses/outlining-cost-management-and-profitability-analysis/discussing-the-concept-of-the-universal-journal_f62cf151-5562-44f5-8ff6-df16fb232e94)
- [SAP Community: S/4HANA inventory tables and the new simplified data model (MATDOC)](https://community.sap.com/t5/enterprise-resource-planning-blog-posts-by-sap/sap-s-4hana-inventory-management-tables-new-simplified-data-model-nsdm/ba-p/13497469)
- [SAP Learning: exploring APIs in the SAP universe](https://learning.sap.com/courses/devoloping-soap-web-services-on-sap-erp/exploring-apis-in-the-sap-universe_c765ebfe-26e4-44ae-9c85-cda235bf9da2)
- [Oracle NetSuite: N/record module and the SuiteScript Records Browser](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4267255811.html)
- [Odoo: stock module design notes](https://github.com/odoo/odoo/blob/14.0/addons/stock/doc/stock.rst)
- [ERPNext: immutable ledger](https://docs.frappe.io/erpnext/immutable-ledger-in-erpnext)
- [ERPNext: payment ledger](https://docs.frappe.io/erpnext/payment_ledger)
- [ERPNext: repost item valuation](https://docs.frappe.io/erpnext/repost-item-valuation)
- [ECOSIRE: Bangladesh VAT (Mushak) app for ERPNext](https://ecosire.com/apps/erpnext/erpnext-bangladesh-vat-mushak)

Tools and standards

- [REA: reverse engineer anything with agents](https://github.com/morluto/rea)
- [PostgreSQL documentation: row security policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [Nile: UUIDv7 comes to PostgreSQL 18](https://thenile.dev/blog/uuidv7)
- [OWASP Application Security Verification Standard](https://owasp.org/projects/asvs?tab=asvs-users)

Bangladesh

- [PwC Worldwide Tax Summaries: Bangladesh, tax administration](https://taxsummaries.pwc.com/bangladesh/corporate/tax-administration)
- [PwC Worldwide Tax Summaries: Bangladesh, other taxes](https://taxsummaries.pwc.com/bangladesh/corporate/other-taxes)
- [Md. Rakib Hassan: Mushak 9.1 VAT return guide, Apr 2026](https://rakibhassan.eu/mushak-9-1-vat-return-guide-for-bangladesh-2026/)
- [The Financial Express: EFD/SDC mandatory at highway hotels and restaurants, 3 Mar 2025](https://today.thefinancialexpress.com.bd/print/installation-of-efdsdc-mandatory-at-hotels-restaurants-located-on-highways-nbr-1740937651)
- [BSS: bills passed in Parliament, including the Personal Data Protection Bill, 2026, 9 Apr 2026](https://www.bssnews.net/js-session/376218)
- [Securiti: Bangladesh Personal Data Protection Act overview, Jun 2026](https://securiti.ai/bangladesh-personal-data-protection-act-overview/)
