# Feature map

A feature's tier is the phase it ships in: Must in Phases 0–1, Need in 2, Should in 3, Nice in 4, Later when a customer pays for it. As written there are 172 features: 55 Must, 11 Need, 61 Should, 26 Nice and 19 Later. Changing a dropdown moves that feature's phase, so log the change in the plan's decision log.

## Platform and kernel

| Feature | Tier | What it covers |
| --- | --- | --- |
| Organization model | Must | Tenant, then a tree of companies (legal entities), branches, warehouses and cost centers |
| Users, roles and permissions | Must | Roles per action; record rules (only my branch) and field rules (hide cost price); deny by default |
| Sign-in and two-factor | Must | argon2id passwords; TOTP for admins and finance approvers; session revocation |
| Metadata engine | Must | Entity, field, form and list definitions drive the API, validation and the UI |
| Document engine | Must | Draft, submitted, cancelled and amend; numbering series, gapless where the law requires; links between documents |
| Audit trail | Must | Who changed what and when, old and new values, written in the same transaction |
| Attachments | Must | Files on any record, in object storage; a bill keeps its scanned original |
| Import and export | Must | CSV and Excel with validation, a dry run and row-level errors before commit |
| Opening balances and migration | Must | Trial balance, open receivables and payables, stock with costs and master data, reconciled to the legacy system |
| REST API | Must | Described in OpenAPI and used by the web app itself; idempotency keys on writes |
| Jobs and scheduler | Must | Postgres-backed queue for posting batches, recurring documents, imports and heavy reports |
| Localization basics | Must | English and Bangla UI; lakh and crore grouping; time zone per company |
| Effective-dated master data | Must | Prices, tax rules, salaries and rates with valid-from dates |
| Backups and restore | Must | Point-in-time recovery, encrypted off-site copies, a monthly restore drill |
| Observability | Must | Logs, traces, metrics and alerts on errors, latency, failed jobs and integrity checks |
| Notifications | Need | In-app and email for approvals, failures and due dates |
| Workflow and approvals | Need | States, transitions and approval chains by amount, role or department, with escalation |
| Segregation of duties | Need | Maker-checker on payments, journals and supplier bank-account changes |
| Tenant custom fields and entities | Need | Key users add fields and simple records without code; they appear in forms, API, imports and reports |
| Print designer | Need | Templates for invoices, Mushak challans, delivery notes, cheques and payslips, in Bangla and English |
| Data export and offboarding | Need | A tenant can export all its data in open formats at any time |
| Comments and mentions | Need | Discussion on any record, with @mentions |
| API keys, OAuth clients and webhooks | Should | Third-party access with scopes and rate limits; signed outbound webhooks |
| Saved views and global search | Should | Per-user filters and columns; search across records |
| SSO | Should | Google and Microsoft sign-in through OIDC |
| Mobile PWA | Should | Approvals, stock counts and collections on a phone |
| SMS and WhatsApp messaging | Should | Invoices, dues and one-time codes through local gateways |
| Tamper-evident audit | Should | Hash-chained audit entries per tenant |
| Server scripts | Nice | Sandboxed tenant hooks on document events |
| Offline mode | Nice | Queue and sync for point of sale and field sales |
| Sandbox environments | Nice | Copy a tenant's configuration to a sandbox and promote changes back |
| Pack marketplace | Nice | Tenants enable industry and localization packs themselves |
| Field-level encryption and compliance reports | Later | Encrypted sensitive fields; audit-ready compliance exports |

## Finance and accounting

| Feature | Tier | What it covers |
| --- | --- | --- |
| Chart of accounts and templates | Must | Account tree per company with types; Bangladesh templates for trading and services |
| Fiscal years and lock dates | Must | Any fiscal year, July–June by default; a lock date per ledger |
| Universal journal | Must | One GL line table with company, account, party, item, dimensions, currency and source journal |
| Posting setup | Must | Party group × product group × location group → account |
| Control accounts | Must | Receivable, payable, stock and tax accounts accept postings only from their subledgers |
| Manual journals | Must | Balanced entries with attachments; blocked on control accounts |
| Accounts receivable | Must | Invoices, credit notes, receipts, settlement, aging as of any date |
| Accounts payable | Must | Bills, debit notes, payments, settlement, aging as of any date |
| Advances | Must | Customer and supplier advances held as open items and settled against later invoices |
| Payment terms | Must | Due dates and installments that drive aging |
| Cash, bank and wallets | Must | Cash, bank and mobile-wallet accounts (bKash, Nagad), transfers, wallet fees |
| Cheques | Must | Issued and received cheques with number and date; deposit, clear, bounce with reversal |
| Bank reconciliation | Must | Statement import, matching rules, a queue of unmatched lines |
| Tax engine | Must | VAT and supplementary duty per line; VAT and income tax withheld at source; effective-dated rules |
| VAT registers | Must | Purchase and sales registers with the fields Mushak forms need |
| Financial statements | Must | Trial balance, profit and loss, balance sheet, cash flow; drill-down to source |
| Year-end close | Must | Closing entries to retained earnings; opening balances carried forward |
| Ledger integrity monitor | Must | Nightly invariant checks with alerts |
| Post-dated cheque register | Need | Cheques held by due date, reminders, bulk deposit |
| Recurring journals | Should | Templates for monthly accruals |
| Multi-currency | Should | Foreign-currency documents and realized exchange gain or loss |
| FX revaluation | Should | Unrealized gain or loss on open items at period end |
| Dimension rules | Should | Cost center, department or project required per account |
| Budgets | Should | Budget versus actual; optional hard stop on purchase orders |
| Fixed assets | Should | Register, depreciation schedules, disposal |
| Dunning | Should | Overdue reminders by email and SMS |
| Expense claims | Should | Employee claims with receipts and approval |
| Period-close checklist | Should | Tasks, owners and blockers for month-end |
| Cash-flow forecast | Nice | From open items and orders |
| Revenue recognition | Nice | Deferred revenue schedules |
| Intercompany | Nice | A sale in one company creates the matching purchase in another |
| Bank feeds | Later | Statement lines by API where banks offer one |
| Consolidation | Later | Roll-up with currency translation and eliminations |
| Parallel ledgers | Later | IFRS and local books from the same transactions |
| Lease accounting | Later | IFRS 16 right-of-use assets and lease liabilities |

## Sales

| Feature | Tier | What it covers |
| --- | --- | --- |
| Customers and contacts | Must | Party with the customer role, contacts, addresses, BIN, credit terms |
| Sales order, delivery and invoice | Must | Each created from the one before; partial quantities; invoice-with-delivery for counter sales |
| Price lists and discounts | Must | Effective-dated prices per item, unit and customer group; line and document discounts |
| Line taxes | Must | Computed per line by the tax engine |
| Returns and credit notes | Must | Against the original delivery and invoice; restock at original cost or scrap |
| Fulfilment status | Must | Ordered, delivered, invoiced and paid quantities on every line |
| Credit control | Need | Hold orders over the credit limit or with overdue invoices; approval to release |
| Recurring invoices | Need | Contracts billed on a schedule; the rental pack builds on it |
| Quotations | Should | Quotes converted to orders |
| CRM pipeline | Should | Leads, opportunities, stages, activities |
| Pricing rules | Should | Quantity breaks, customer tiers, date-bound promotions |
| Stock reservation | Should | Reserve on order confirmation; available-to-promise date |
| Customer portal | Should | Orders, invoices, statements and online payment |
| Point of sale | Should | Touch POS with cash sessions and receipts (retail pack) |
| Route and van sales | Should | Salesperson routes, van stock and collections (distribution pack) |
| Sales commissions | Nice | Rules per rep, product or margin |
| E-commerce sync | Nice | Products, stock and orders with a storefront |
| Loyalty and gift cards | Nice | Points and stored value |
| Product configurator | Later | Option rules that build a valid variant and its price |
| Rebates and trade promotions | Later | Volume rebates accrued and settled |
| Omnichannel fulfilment | Later | Route each order to the best warehouse or store |

## Procurement

| Feature | Tier | What it covers |
| --- | --- | --- |
| Suppliers | Must | Party with the supplier role, supplier item codes, BIN and TIN |
| Purchase order, receipt and bill | Must | Each created from the one before; partial receipts |
| Three-way match | Must | Bill checked against order price and received quantity within tolerances |
| Purchase returns and debit notes | Must | Return to supplier against the receipt |
| Supplier payments with withholding | Must | Payments that withhold income tax and VAT at source and record certificates |
| Landed cost | Must | Freight, labour and other charges allocated into item cost |
| Purchase approvals | Need | Approval chain by amount or category, on the workflow engine |
| Requisitions | Should | Departments or MRP raise requests; buyers convert them to orders |
| RFQs and quote comparison | Should | RFQs to several suppliers; replies compared side by side |
| Blanket orders | Should | Annual contracts released in call-offs |
| Import and LC management | Should | Letters of credit, shipments, customs and C&F charges per import |
| Supplier portal | Nice | Suppliers confirm orders, upload invoices, see payment status |
| Supplier scorecards | Nice | On-time delivery, quality rejects, price variance |
| Sourcing events | Later | Tenders and reverse auctions |
| Spend analytics | Later | Spend by category and supplier; off-contract buying |

## Inventory and warehouse

| Feature | Tier | What it covers |
| --- | --- | --- |
| Items, variants and units | Must | Templates with attributes (color, size) generating variants; units with conversions |
| Warehouses and locations | Must | Location tree plus virtual supplier, customer, production, adjustment, scrap, transit and opening locations |
| Stock moves | Must | Every receipt, delivery, transfer and adjustment is a move between two locations |
| Valuation | Must | FIFO and moving average; quantity and value ledgers kept apart; perpetual posting to the GL; negative stock only where a location allows it |
| Cost adjustment | Must | Backdated or late costs correct later issues with new entries, never edits |
| Stock counts and adjustments | Must | Count sheets; variances with reasons, posted to loss or gain |
| Warehouse transfers | Must | Direct transfers between one company's warehouses |
| Batches, serials and expiry | Should | Lots and serials with expiry, traceable both ways |
| Reorder rules | Should | Min-max per item and location, proposing purchases or production |
| In-transit transfers | Should | Transfers through a transit location |
| Bin locations | Should | Rack, shelf and bin |
| Barcode scanning | Should | Mobile scanning for receipts, picking and counts |
| Kits and bundles | Should | Sell one SKU, consume several components |
| Cycle counting | Should | Count a rotating subset by ABC class |
| Courier integration | Should | Book shipments and track parcels through local courier APIs |
| Pick, pack and ship | Nice | Picking waves, packing, putaway rules |
| Consignment stock | Nice | Stock owned by a supplier, or held at a customer's site |
| Standard costing | Later | Standard cost with purchase and production variances |
| Full WMS | Later | Slotting, labour tracking, cross-docking |

## Manufacturing and quality

The first slice, when manufacturing starts in Phase 3, is bills of materials, work orders and cost roll-up.

| Feature | Tier | What it covers |
| --- | --- | --- |
| Bills of materials | Should | Multi-level, with scrap percentage and alternatives |
| Work orders | Should | Consume and produce as moves through a production location |
| Cost roll-up | Should | Material, labour and overhead into finished-goods cost |
| Routings and work centers | Should | Operations, times and capacity |
| MRP | Should | Net requirements become planned purchases and work orders |
| Subcontracting | Should | Send materials out, receive finished goods, pay for the service |
| Quality inspections | Should | Checks at receipt, in process and at the end |
| By-products | Should | Secondary outputs valued into stock |
| Shop-floor terminal | Nice | Operators log start, stop, output and rejects |
| BOM versions and change orders | Nice | Engineering changes with effective dates |
| Production scheduling | Nice | Drag-and-drop work orders by line |
| Advanced planning | Later | Finite-capacity scheduling and optimization |
| Machine data | Later | MES and IoT feeds for equipment effectiveness |

## HR and payroll

Until Phase 3, salaries are paid through payables or journals. Payroll then ships together with its Bangladesh statutory rules.

| Feature | Tier | What it covers |
| --- | --- | --- |
| Employee records | Should | Effective-dated position, department, grade and salary |
| Org structure | Should | Departments, designations, reporting lines |
| Attendance | Should | Manual or device import; late, absent and half-day rules |
| Leave | Should | Types, accrual, balances, approval |
| Payroll with Bangladesh statutory rules | Should | Salary structures, income tax on salary, provident fund, festival bonuses, payslips, GL posting |
| Shifts and overtime | Should | Rosters, overtime rates and approval |
| Loans and advances | Should | Salary advances recovered through payroll |
| Employee self-service | Should | Payslips, leave and attendance on a phone |
| Attendance devices | Should | Punches synced from biometric terminals |
| Final settlement | Should | Leave encashment, gratuity and dues on exit |
| Piece-rate pay | Nice | Pay by pieces per operation, common on garment lines |
| Recruitment and onboarding | Nice | Openings, applicant pipeline, onboarding checklists |
| Performance reviews | Nice | Goals, appraisal cycles, ratings |
| Workforce planning | Later | Headcount plans, succession, learning |

## Projects, services and assets

| Feature | Tier | What it covers |
| --- | --- | --- |
| Projects and tasks | Should | Projects, milestones, tasks, assignees |
| Timesheets | Should | Hours per task with approval and cost rate |
| Project costing | Should | Budget versus actual from time, purchases and stock issued |
| Project billing | Should | Time-and-materials, fixed-price and milestone invoices |
| Maintenance | Nice | Preventive schedules and breakdown tickets with spare parts from stock |
| Helpdesk | Nice | Customer tickets with SLA timers and a knowledge base |
| Resource planning | Later | Utilization and capacity by person and skill |
| Field service | Later | Technician dispatch, mobile job sheets, on-site billing |

## Reporting, analytics, integrations and AI

| Feature | Tier | What it covers |
| --- | --- | --- |
| Standard reports | Must | Statements, aging, stock balance and valuation, sales, purchase and tax registers |
| Drill-down | Must | Any total to its journal lines and source documents |
| Export | Must | Excel, CSV and PDF from every list and report |
| Report builder | Should | Fields across related records; filter, group, save, share |
| Role dashboards | Should | KPIs per role: cash, overdue receivables, stock value, open orders |
| Scheduled reports | Should | Reports emailed on a schedule |
| Read replica and BI | Should | A reporting replica for Metabase or Power BI |
| Integration connectors | Should | Payment gateways, couriers, storefronts, SMS |
| Ask your data | Nice | Questions answered by generated SQL on the replica, within the asker's permissions |
| Document capture | Nice | Bills and receipts read into draft documents for review |
| Anomaly alerts | Nice | Duplicate bills, unusual journals, margin drops |
| Demand forecasting | Nice | Forecasts from sales history feeding reorder rules and MRP |
| AI agents with approval | Later | Agents draft orders, collection emails or close tasks; a person approves each |
| Planning and scenarios | Later | Driver-based budgets and what-if scenarios |
