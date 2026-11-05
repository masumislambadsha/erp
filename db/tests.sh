#!/usr/bin/env bash
# Kernel schema tests, version 2. Run against a fresh database loaded with schema.sql:
#   DB=erp bash db/tests.sh        (or: bash scripts/db-test.sh, which uses Docker)
# Every test runs as erp_app (the API's role) unless its name says otherwise.
set -u
DB=${DB:-erp}
APP="psql -X -q -t -A -v ON_ERROR_STOP=1 -U erp_app -d $DB"
SU="psql -X -q -t -A -v ON_ERROR_STOP=1 -U postgres -d $DB"
pass=0; fail=0
uuid() { cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen | tr '[:upper:]' '[:lower:]'; }
now_ms() { local t; t=$(date +%s%N 2>/dev/null); case "$t" in *N|'') python3 -c 'import time; print(int(time.time() * 1000))';; *) echo $(( t / 1000000 ));; esac; }

TA=aaaaaaaa-0000-4000-8000-000000000001; TB=bbbbbbbb-0000-4000-8000-000000000002
CA=aaaaaaaa-0000-4000-8000-0000000000c1; CA2=aaaaaaaa-0000-4000-8000-0000000000c2
CB=bbbbbbbb-0000-4000-8000-0000000000c2
U=aaaaaaaa-0000-4000-8000-0000000000aa;  U2=aaaaaaaa-0000-4000-8000-0000000000ab
CASH=aaaaaaaa-0000-4000-8000-00000000a001;  GRP=aaaaaaaa-0000-4000-8000-00000000a002
AR=aaaaaaaa-0000-4000-8000-00000000a003;    INV=aaaaaaaa-0000-4000-8000-00000000a004
VATOUT=aaaaaaaa-0000-4000-8000-00000000a005; GRNI=aaaaaaaa-0000-4000-8000-00000000a006
SALES=aaaaaaaa-0000-4000-8000-00000000a007; COGS=aaaaaaaa-0000-4000-8000-00000000a008
FXG=aaaaaaaa-0000-4000-8000-00000000a009;   CASH2=aaaaaaaa-0000-4000-8000-00000000a010
SALES2=aaaaaaaa-0000-4000-8000-00000000a011
P1=aaaaaaaa-0000-4000-8000-0000000000f1;    P2=aaaaaaaa-0000-4000-8000-0000000000f2
ITEMA=aaaaaaaa-0000-4000-8000-0000000000e1; ITEMC=aaaaaaaa-0000-4000-8000-0000000000e3
ITEMB=bbbbbbbb-0000-4000-8000-0000000000e1
WH=aaaaaaaa-0000-4000-8000-0000000000d1;    NEGWH=aaaaaaaa-0000-4000-8000-0000000000d2
SUP=aaaaaaaa-0000-4000-8000-0000000000d3;   CUS=aaaaaaaa-0000-4000-8000-0000000000d4
WH2=aaaaaaaa-0000-4000-8000-0000000000d5
CTX_A="SELECT set_config('app.tenant_id','$TA',true), set_config('app.user_id','$U',true);"
CTX_B="SELECT set_config('app.tenant_id','$TB',true), set_config('app.user_id','$U',true);"

ok()    { local name=$1 sql=$2 out; out=$($APP -c "$sql" 2>&1) && { echo "PASS  $name"; pass=$((pass+1)); } \
                                                             || { echo "FAIL  $name -> $out"; fail=$((fail+1)); }; }
err()   { local name=$1 pat=$2 sql=$3 out; out=$($APP -c "$sql" 2>&1)
          if [ $? -ne 0 ] && grep -q -- "$pat" <<<"$out"; then echo "PASS  $name  [$(grep -o 'ERROR:.*' <<<"$out" | head -1)]"; pass=$((pass+1))
          else echo "FAIL  $name -> $out"; fail=$((fail+1)); fi; }
su_err(){ local name=$1 pat=$2 sql=$3 out; out=$($SU -c "$sql" 2>&1)
          if [ $? -ne 0 ] && grep -q -- "$pat" <<<"$out"; then echo "PASS  $name  [$(grep -o 'ERROR:.*' <<<"$out" | head -1)]"; pass=$((pass+1))
          else echo "FAIL  $name -> $out"; fail=$((fail+1)); fi; }
equal() { local name=$1 want=$2 sql=$3 out; out=$($APP -c "$sql" 2>&1 | tail -1)
          if [ "$out" = "$want" ]; then echo "PASS  $name  [= $want]"; pass=$((pass+1)); else echo "FAIL  $name -> got '$out', want '$want'"; fail=$((fail+1)); fi; }
su_equal(){ local name=$1 want=$2 sql=$3 out; out=$($SU -c "$sql" 2>&1 | tail -1)
          if [ "$out" = "$want" ]; then echo "PASS  $name  [= $want]"; pass=$((pass+1)); else echo "FAIL  $name -> got '$out', want '$want'"; fail=$((fail+1)); fi; }
in_a()  { echo "BEGIN; $CTX_A $* COMMIT;"; }

# SQL builders (tenant A, company A)
jh() { echo "INSERT INTO journal (tenant_id,id,company_id,posting_date,kind,document_id,reverses_id)
             VALUES ('$TA','$1','$CA','$2','${3:-post}',${4:-NULL},${5:-NULL});"; }          # id date [kind] [doc] [reverses]
gl() { echo "INSERT INTO gl_line (tenant_id,journal_id,company_id,posting_date,account_id,amount,currency,amount_tc,party_id,item_id)
             VALUES ('$TA','$1','$CA','$2','$3',$4,'BDT',$4,${5:-NULL},${6:-NULL});"; }       # journal date account amount [party] [item]
oi() { echo "INSERT INTO open_item (tenant_id,id,journal_id,company_id,posting_date,party_id,side,account_id,due_date,
                                    currency,amount,amount_tc,remaining,remaining_tc)
             VALUES ('$TA','$1','$2','$CA','$3','$4','receivable','$5','$3','BDT',$6,$6,0,0);"; }  # id journal date party account amount
st() { echo "INSERT INTO settlement (tenant_id,id,journal_id,company_id,posting_date,kind,unapplies_id,
                                     debit_item_id,credit_item_id,amount,amount_tc,fx_difference)
             VALUES ('$TA',$1,'$2','$CA','$3','${7:-apply}',${8:-NULL},'$4','$5',$6,$6,${9:-0});"; }  # id journal date debit credit amount [kind] [unapplies] [fx]
mv() { echo "INSERT INTO stock_move (tenant_id,id,journal_id,company_id,posting_date,item_id,from_location,to_location,base_qty)
             VALUES ('$TA',$1,'$2','$CA','$3','$4','$5','$6',$7);"; }                       # id journal date item from to qty
ve() { echo "INSERT INTO stock_value_entry (tenant_id,journal_id,company_id,posting_date,item_id,location_id,account_id,
                                            move_date,move_id,qty,cost,kind)
             VALUES ('$TA','$1','$CA','$2','$3','$4','$INV','$2',$5,$6,$7,'direct');"; }     # journal date item location move qty cost
tl() { echo "INSERT INTO tax_line (tenant_id,journal_id,company_id,posting_date,kind,document_line_id,direction,tax_code,rate,
                                   currency,base_amount,tax_amount,tax_amount_tc,account_id)
             VALUES ('$TA','$1','$CA','$2','${5:-adjustment}',${6:-NULL},'sale','VAT',0.15,'BDT',$3,$4,$4,'$VATOUT');"; }
                                                                                   # journal date base tax [kind] [document line]
doc(){ echo "INSERT INTO document (tenant_id,id,company_id,doc_type,series_code,posting_date,party_id,currency)
             VALUES ('$TA','$1','$CA','sales_invoice','M63-DHK-2026','$2',${3:-NULL},'BDT');"; } # id date [party]
submit(){ echo "UPDATE document SET status = 'submitted' WHERE id = '$1';"; }

# ---- Seed: tenants are created by the platform (superuser); everything else by erp_app
$SU -c "INSERT INTO tenant VALUES ('$TA','Tenant A'),('$TB','Tenant B');" >/dev/null || { echo "seed tenants failed"; exit 1; }
$APP -c "$(in_a "
  INSERT INTO company (tenant_id,id,name,base_currency) VALUES ('$TA','$CA','A Traders Ltd','BDT'), ('$TA','$CA2','A Exports Ltd','BDT');
  INSERT INTO account (tenant_id,id,company_id,code,name,kind,is_group,control_for) VALUES
    ('$TA','$CASH','$CA','1010','Cash','asset',false,NULL),
    ('$TA','$GRP','$CA','1000','Current assets','asset',true,NULL),
    ('$TA','$AR','$CA','1200','Trade receivables','asset',false,'receivable'),
    ('$TA','$INV','$CA','1300','Inventory','asset',false,'stock'),
    ('$TA','$GRNI','$CA','2200','Received not billed','liability',false,NULL),
    ('$TA','$SALES','$CA','4000','Sales','income',false,NULL),
    ('$TA','$COGS','$CA','5000','Cost of goods sold','expense',false,NULL),
    ('$TA','$FXG','$CA','7000','Exchange gain or loss','income',false,NULL),
    ('$TA','$CASH2','$CA2','1010','Cash','asset',false,NULL),
    ('$TA','$SALES2','$CA2','4000','Sales','income',false,NULL);
  INSERT INTO account (tenant_id,id,company_id,code,name,kind,control_for,tax_code,tax_direction)
    VALUES ('$TA','$VATOUT','$CA','2300','VAT output','liability','tax','VAT','sale');
  INSERT INTO party (tenant_id,id,name,bin) VALUES ('$TA','$P1','Rahim Store','000123456-0101'), ('$TA','$P2','Karim Traders',NULL);
  INSERT INTO item (tenant_id,id,sku,name,kind,base_uom,product_group,tax_category,valuation) VALUES
    ('$TA','$ITEMA','FAN-56','Ceiling fan 56in','stock','pcs','FANS','STD','fifo'),
    ('$TA','$ITEMC','FAN-48','Ceiling fan 48in','stock','pcs','FANS','STD','fifo');
  INSERT INTO location (tenant_id,id,company_id,name,kind,allow_negative) VALUES
    ('$TA','$WH','$CA','Main warehouse','internal',false),
    ('$TA','$NEGWH','$CA','Shop counter','internal',true),
    ('$TA','$SUP','$CA','Suppliers','supplier',false),
    ('$TA','$CUS','$CA','Customers','customer',false),
    ('$TA','$WH2','$CA2','Export warehouse','internal',false);
  INSERT INTO number_series (tenant_id,company_id,code,prefix) VALUES
    ('$TA','$CA','M63-DHK-2026','M63-DHK-'), ('$TA','$CA','INV-2026','INV-'), ('$TA','$CA2','M63-CTG-2026','M63-CTG-');")" >/dev/null \
  || { echo "seed A failed"; exit 1; }
# June: an invoice and its payment, posted before June is locked
JJ1=$(uuid); JJ2=$(uuid); OJ1=$(uuid); OJ2=$(uuid)
$APP -c "$(in_a "
  $(jh $JJ1 2026-06-10) $(gl $JJ1 2026-06-10 $AR 700 "'$P1'") $(gl $JJ1 2026-06-10 $SALES -700) $(oi $OJ1 $JJ1 2026-06-10 $P1 $AR 700)
  $(jh $JJ2 2026-06-12) $(gl $JJ2 2026-06-12 $CASH 700) $(gl $JJ2 2026-06-12 $AR -700 "'$P1'") $(oi $OJ2 $JJ2 2026-06-12 $P1 $AR -700)")" >/dev/null \
  || { echo "seed June failed"; exit 1; }
$APP -c "$(in_a "INSERT INTO posting_lock VALUES ('$TA','$CA','gl','2026-06-30'), ('$TA','$CA','tax','2026-06-30'),
                                                 ('$TA','$CA','receivable','2026-06-30'), ('$TA','$CA','stock','2026-06-30');")" >/dev/null \
  || { echo "seed locks failed"; exit 1; }
$APP -c "BEGIN; $CTX_B
  INSERT INTO company (tenant_id,id,name,base_currency) VALUES ('$TB','$CB','B Distributors','BDT');
  INSERT INTO item (tenant_id,id,sku,name,kind,base_uom,product_group,tax_category,valuation)
    VALUES ('$TB','$ITEMB','FAN-56','Ceiling fan 56in','stock','pcs','FANS','STD','moving_avg');
  COMMIT;" >/dev/null || { echo "seed B failed"; exit 1; }

echo "== Tenant isolation"
equal "T01 a tenant sees only its own companies"            2 "BEGIN; $CTX_A SELECT count(*) FROM company; COMMIT;"
equal "T02 the same SKU exists in two tenants"              1 "BEGIN; $CTX_B SELECT count(*) FROM item WHERE sku='FAN-56'; COMMIT;"
err   "T03 cannot write a row for another tenant"           "row-level security" \
      "BEGIN; $CTX_A INSERT INTO company (tenant_id,id,name,base_currency) VALUES ('$TB',gen_random_uuid(),'x','BDT'); COMMIT;"
err   "T04 cannot point at another tenant's company"        "foreign key" \
      "BEGIN; $CTX_A INSERT INTO account (tenant_id,id,company_id,code,name,kind) VALUES ('$TA',gen_random_uuid(),'$CB','9','x','asset'); COMMIT;"
err   "T05 no tenant context fails loudly"                  "unrecognized configuration parameter" \
      "SELECT count(*) FROM company;"
err   "T06 context does not survive its transaction"        "invalid input syntax for type uuid" \
      "BEGIN; $CTX_A COMMIT; SELECT count(*) FROM company;"
su_err "T07 the table owner is bound by RLS too (FORCE)"    "unrecognized configuration parameter" \
      "SET ROLE erp_owner; SELECT count(*) FROM company;"
err   "T08 duplicate SKU inside one tenant is rejected"     "duplicate key" \
      "BEGIN; $CTX_A INSERT INTO item (tenant_id,id,sku,name,kind,base_uom,product_group,tax_category) VALUES ('$TA',gen_random_uuid(),'FAN-56','dup','service','pcs','X','STD'); COMMIT;"

echo "== Hardening"
err   "H01 erp_app cannot create temporary tables"          "permission denied to create temporary tables" \
      "CREATE TEMP TABLE t (a int);"
J=$(uuid)
su_err "H02 shadow tables cannot fool a guard (superuser session, temp posting_lock, journal, queue)" \
      "gl ledger is locked through 2026-06-30" \
      "CREATE TEMP TABLE posting_lock (LIKE public.posting_lock); CREATE TEMP TABLE journal (LIKE public.journal);
       CREATE TEMP TABLE journal_check (LIKE public.journal_check);
       GRANT ALL ON posting_lock, journal, journal_check TO erp_app; SET ROLE erp_app;
       BEGIN; $CTX_A
       INSERT INTO public.journal (tenant_id,id,company_id,posting_date,kind) VALUES ('$TA','$J','$CA','2026-06-15','post');
       INSERT INTO public.gl_line (tenant_id,journal_id,company_id,posting_date,account_id,amount,currency,amount_tc)
         VALUES ('$TA','$J','$CA','2026-06-15','$CASH',10,'BDT',10), ('$TA','$J','$CA','2026-06-15','$SALES',-10,'BDT',-10);
       COMMIT;"
J=$(uuid)
su_err "H03 shadow tables cannot fool the COMMIT check (temp gl_line)" "out of balance by 10" \
      "CREATE TEMP TABLE gl_line (LIKE public.gl_line); GRANT ALL ON gl_line TO erp_app; SET ROLE erp_app;
       BEGIN; $CTX_A
       INSERT INTO public.journal (tenant_id,id,company_id,posting_date,kind) VALUES ('$TA','$J','$CA','2026-07-15','post');
       INSERT INTO public.gl_line (tenant_id,journal_id,company_id,posting_date,account_id,amount,currency,amount_tc)
         VALUES ('$TA','$J','$CA','2026-07-15','$CASH',10,'BDT',10);
       COMMIT;"
J=$(uuid)
err   "H04 switching tenant mid-transaction makes COMMIT fail" "must not switch tenant" \
      "BEGIN; $CTX_A $(jh $J 2026-07-15) $(gl $J 2026-07-15 $CASH 100) $(gl $J 2026-07-15 $SALES -90)
       SELECT set_config('app.tenant_id','$TB',true); COMMIT;"
J=$(uuid)
err   "H05 SET CONSTRAINTS ... IMMEDIATE cannot skip the COMMIT check" "out of balance by 5" \
      "BEGIN; $CTX_A $(jh $J 2026-07-15) $(gl $J 2026-07-15 $CASH 100) $(gl $J 2026-07-15 $SALES -100)
       SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
       $(gl $J 2026-07-15 $CASH 5) COMMIT;"
J=$(uuid)
err   "H05b ... nor can leaving it IMMEDIATE (the second review's repro)" "out of balance by 1000000" \
      "BEGIN; $CTX_A $(jh $J 2026-07-15) $(gl $J 2026-07-15 $CASH 100) $(gl $J 2026-07-15 $SALES -100)
       SET CONSTRAINTS ALL IMMEDIATE; $(gl $J 2026-07-15 $AR 1000000 "'$P1'") COMMIT;"
J=$(uuid)
err   "H05c with IMMEDIATE from the start, a journal is checked before its lines exist: it fails closed" "has no lines" \
      "BEGIN; $CTX_A SET CONSTRAINTS ALL IMMEDIATE; $(jh $J 2026-07-15) $(gl $J 2026-07-15 $CASH 1) $(gl $J 2026-07-15 $SALES -1) COMMIT;"
$SU -c "GRANT SELECT ON gl_line_2026 TO erp_app;" >/dev/null
equal "H06 a grant on a partition still shows only the tenant's own rows" 0 "BEGIN; $CTX_B SELECT count(*) FROM gl_line_2026; COMMIT;"
$SU -c "REVOKE SELECT ON gl_line_2026 FROM erp_app;" >/dev/null
su_err "H07 the owner cannot TRUNCATE a ledger"             "cannot be truncated" "SET ROLE erp_owner; TRUNCATE gl_line;"
su_err "H08 ... nor one of its partitions"                  "cannot be truncated" "SET ROLE erp_owner; TRUNCATE gl_line_2026;"
err   "H09 erp_app cannot touch the COMMIT-check queue"     "permission denied" \
      "BEGIN; $CTX_A DELETE FROM journal_check; COMMIT;"
J=$(uuid)
equal "H10 the database stamps a journal's author, time and transaction" "true|true|true" \
      "BEGIN; $CTX_A
       INSERT INTO journal (tenant_id,id,company_id,posting_date,kind,created_by,created_at,created_xact)
         VALUES ('$TA','$J','$CA','2026-07-15','post','$U2','2000-01-01','1');
       $(gl $J 2026-07-15 $CASH 1) $(gl $J 2026-07-15 $SALES -1)
       SELECT (created_by = '$U')::text || '|' || (created_at > '2001-01-01')::text || '|'
              || (created_xact = pg_current_xact_id())::text FROM journal WHERE id = '$J';
       COMMIT;"
err   "H11 only the database writes the audit log"           "permission denied for table audit_log" \
      "BEGIN; $CTX_A INSERT INTO audit_log (tenant_id,actor_id,entity,entity_id,action,changes)
         VALUES ('$TA','$U2','test','$CA','insert','{}'); COMMIT;"
J=$(uuid)
err   "H12 a journal without app.user_id fails loudly"      "app.user_id" \
      "BEGIN; SELECT set_config('app.tenant_id','$TA',true); $(jh $J 2026-07-15) COMMIT;"

J=$(uuid)
err   "H13 posting outside READ COMMITTED is refused"        "READ COMMITTED" \
      "BEGIN ISOLATION LEVEL REPEATABLE READ; $CTX_A $(jh $J 2026-07-15) $(gl $J 2026-07-15 $CASH 1) $(gl $J 2026-07-15 $SALES -1) COMMIT;"

echo "== Ledger rules"
J1=$(uuid)
ok    "T09 a balanced journal commits" \
      "$(in_a "$(jh $J1 2026-07-15) $(gl $J1 2026-07-15 $CASH 1000) $(gl $J1 2026-07-15 $SALES -1000)")"
J=$(uuid)
err   "T10 an unbalanced journal is rejected at COMMIT"     "out of balance by 100" \
      "$(in_a "$(jh $J 2026-07-15) $(gl $J 2026-07-15 $CASH 1000) $(gl $J 2026-07-15 $SALES -900)")"
J=$(uuid)
err   "T11 a line cannot carry a date other than its journal's" "foreign key" \
      "$(in_a "$(jh $J 2026-07-15) $(gl $J 2026-07-16 $CASH 5) $(gl $J 2026-07-16 $SALES -5)")"
err   "T12 a posted journal is sealed: no lines can be added later" "is sealed" \
      "$(in_a "$(gl $J1 2026-07-15 $CASH 5) $(gl $J1 2026-07-15 $SALES -5)")"
J=$(uuid)
err   "T13 an empty journal is rejected"                    "has no lines" "$(in_a "$(jh $J 2026-07-15)")"
err   "T14 the app role cannot update a ledger row"         "permission denied" \
      "$(in_a "UPDATE gl_line SET amount = 2000 WHERE journal_id = '$J1' AND amount > 0;")"
su_err "T15 even the owner cannot rewrite a ledger row"     "append-only" \
      "SET ROLE erp_owner; $(in_a "UPDATE gl_line SET amount = 2000 WHERE journal_id = '$J1' AND amount > 0;")"
J=$(uuid)
err   "T16 a group account takes no postings"               "group account" \
      "$(in_a "$(jh $J 2026-07-15) $(gl $J 2026-07-15 $GRP 1) $(gl $J 2026-07-15 $SALES -1)")"
J=$(uuid)
err   "T17 nothing posts into a locked period"              "gl ledger is locked through 2026-06-30" \
      "$(in_a "$(jh $J 2026-06-15) $(gl $J 2026-06-15 $CASH 10) $(gl $J 2026-06-15 $SALES -10)")"
J=$(uuid)
err   "T18 a journal cannot use another company's account"  "foreign key" \
      "$(in_a "$(jh $J 2026-07-15) $(gl $J 2026-07-15 $CASH2 10) $(gl $J 2026-07-15 $SALES -10)")"
J=$(uuid)
err   "T19 a manual journal cannot move a control account"  "control account 1200 (receivable)" \
      "$(in_a "$(jh $J 2026-07-15) $(gl $J 2026-07-15 $AR 500 "'$P1'") $(gl $J 2026-07-15 $SALES -500)")"
J4=$(uuid); OI=$(uuid); DINV=$(uuid); LINV=$(uuid)
ok    "T20 an invoice: receivable, VAT register and GL reconcile in one journal" \
      "$(in_a "INSERT INTO document (tenant_id,id,company_id,doc_type,series_code,posting_date,party_id,currency)
                 VALUES ('$TA','$DINV','$CA','sales_invoice','INV-2026','2026-07-20','$P1','BDT');
               INSERT INTO document_line (tenant_id,id,company_id,document_id,line_no,item_id,qty,uom,base_qty,unit_price)
                 VALUES ('$TA','$LINV','$CA','$DINV',1,'$ITEMA',2,'pcs',2,500);
               $(submit $DINV)
               $(jh $J4 2026-07-20 post "'$DINV'") $(gl $J4 2026-07-20 $AR 1150 "'$P1'") $(gl $J4 2026-07-20 $SALES -1000)
               $(gl $J4 2026-07-20 $VATOUT -150) $(oi $OI $J4 2026-07-20 $P1 $AR 1150) $(tl $J4 2026-07-20 -1000 -150 supply "'$LINV'")")"
J=$(uuid)
err   "T21 a tax line must move its tax account in the GL"  "control account 2300 (tax) moved 0" \
      "$(in_a "$(jh $J 2026-07-15) $(tl $J 2026-07-15 -1000 -150)")"
J=$(uuid)
err   "T21a a tax account holds one tax and direction: no purchase VAT on the output account" "foreign key" \
      "$(in_a "$(jh $J 2026-07-15) INSERT INTO tax_line (tenant_id,journal_id,company_id,posting_date,kind,direction,tax_code,rate,
                                 currency,base_amount,tax_amount,tax_amount_tc,account_id)
               VALUES ('$TA','$J','$CA','2026-07-15','adjustment','purchase','VAT',0.15,'BDT',100000,15000,15000,'$VATOUT');")"
J=$(uuid)
err   "T21b tax on a supply must cite its document line"    "tax_supply_cites_its_line" \
      "$(in_a "$(jh $J 2026-07-15) $(tl $J 2026-07-15 -1000 -150 supply)")"
J=$(uuid)
err   "T22 no tax line lands in a filed (locked) tax period" "tax ledger is locked through 2026-06-30" \
      "$(in_a "$(jh $J 2026-06-15) $(tl $J 2026-06-15 -1000 -150)")"
err   "T23 the VAT register is append-only"                 "permission denied" \
      "$(in_a "UPDATE tax_line SET tax_amount = 0 WHERE journal_id = '$J4';")"
err   "T24 an account with postings keeps its control type" "has postings" \
      "$(in_a "UPDATE account SET control_for = 'payable' WHERE id = '$CASH';")"
err   "T25 period totals are frozen once the GL is locked"  "gl ledger is locked through 2026-06-30" \
      "$(in_a "INSERT INTO period_balance (tenant_id,company_id,account_id,period_end,amount) VALUES ('$TA','$CA','$CASH','2026-06-30',700);")"
ok    "T26 period totals can be written while the month is open" \
      "$(in_a "INSERT INTO period_balance (tenant_id,company_id,account_id,period_end,amount) VALUES ('$TA','$CA','$CASH','2026-07-31',1000);")"
err   "T28 a company with postings keeps its base currency" "base currency and fiscal year are fixed" \
      "$(in_a "UPDATE company SET base_currency = 'USD' WHERE id = '$CA';")"
$APP -c "$(in_a "INSERT INTO tax_rule (tenant_id,company_id,direction,tax_category,tax_code,valid_from,rate,account_id) VALUES
                   ('$TA','$CA','sale','STD','VAT','2025-07-01',0.15,'$VATOUT'), ('$TA','$CA','sale','STD','VAT','2026-07-01',0.15,'$VATOUT');")" >/dev/null
err   "T29 a tax rule used in a filed period cannot be edited" "add a new effective-dated rule" \
      "$(in_a "UPDATE tax_rule SET rate = 0.10 WHERE company_id = '$CA' AND valid_from = '2025-07-01';")"
ok    "T30 a tax rule for an open period can still be corrected" \
      "$(in_a "UPDATE tax_rule SET rate = 0.075 WHERE company_id = '$CA' AND valid_from = '2026-07-01';")"
$APP -c "$(in_a "INSERT INTO posting_lock VALUES ('$TA','$CA','payable','2026-05-31');
                 UPDATE posting_lock SET locked_through = '2026-06-30' WHERE company_id = '$CA' AND ledger = 'payable';")" >/dev/null
equal "T27 a lock change is audited with its old and new date" '{"locked_through": ["2026-05-31", "2026-06-30"]}' \
      "$(in_a "SELECT changes FROM audit_log WHERE entity = 'posting_lock' ORDER BY id DESC LIMIT 1;")"

echo "== Receivables and settlements"
equal "R01 an open item starts fully open, whatever the app sent" "1150|1150" \
      "$(in_a "SELECT trim_scale(remaining) || '|' || trim_scale(remaining_tc) FROM open_item WHERE id = '$OI';")"
err   "R02 the app cannot edit an open item"                "permission denied" \
      "$(in_a "UPDATE open_item SET remaining = 0 WHERE id = '$OI';")"
su_err "R03 nor can the owner, outside a settlement"        "change only through settlements" \
      "SET ROLE erp_owner; $(in_a "UPDATE open_item SET remaining = 0 WHERE id = '$OI';")"
JP=$(uuid); PAY=$(uuid); JP2=$(uuid); PAY2=$(uuid); JP3=$(uuid); PAY3=$(uuid)
ok    "R04 three payments post (two from Rahim Store, one from Karim Traders)" \
      "$(in_a "$(jh $JP 2026-07-25)  $(gl $JP 2026-07-25 $CASH 500)  $(gl $JP 2026-07-25 $AR -500 "'$P1'")  $(oi $PAY $JP 2026-07-25 $P1 $AR -500)
               $(jh $JP2 2026-07-25) $(gl $JP2 2026-07-25 $CASH 100) $(gl $JP2 2026-07-25 $AR -100 "'$P2'") $(oi $PAY2 $JP2 2026-07-25 $P2 $AR -100)
               $(jh $JP3 2026-07-27) $(gl $JP3 2026-07-27 $CASH 200) $(gl $JP3 2026-07-27 $AR -200 "'$P1'") $(oi $PAY3 $JP3 2026-07-27 $P1 $AR -200)")"
JS=$(uuid)
equal "R05 a settlement reduces both items"                 "650|0" \
      "$(in_a "$(jh $JS 2026-07-26) $(st 900001 $JS 2026-07-26 $OI $PAY 500)
               SELECT (SELECT trim_scale(remaining) FROM open_item WHERE id = '$OI') || '|' || (SELECT trim_scale(remaining) FROM open_item WHERE id = '$PAY');")"
J=$(uuid)
err   "R06 a settlement cannot apply more than is open"     "open_item_not_overapplied" \
      "$(in_a "$(jh $J 2026-07-26) $(st 900002 $J 2026-07-26 $OI $PAY 100)")"
J=$(uuid)
err   "R07 a settlement joins items of one party"           "one party" \
      "$(in_a "$(jh $J 2026-07-26) $(st 900003 $J 2026-07-26 $OI $PAY2 100)")"
J=$(uuid)
err   "R08 a settlement cannot predate its items"           "cannot be dated before" \
      "$(in_a "$(jh $J 2026-07-26) $(st 900004 $J 2026-07-26 $OI $PAY3 100)")"
J=$(uuid)
err   "R09 a company-currency settlement has no exchange difference" "no exchange difference" \
      "$(in_a "$(jh $J 2026-07-28) $(st 900005 $J 2026-07-28 $OI $PAY3 100 apply NULL 5)")"
J=$(uuid)
err   "R10 no settlement in a locked receivable period"     "receivable ledger is locked through 2026-06-30" \
      "$(in_a "$(jh $J 2026-06-20) $(st 900006 $J 2026-06-20 $OJ1 $OJ2 700)")"
J=$(uuid)
equal "R11 an unapply restores both items"                  "1150|-500" \
      "$(in_a "$(jh $J 2026-07-28) $(st 900007 $J 2026-07-28 $OI $PAY 500 unapply 900001)
               SELECT (SELECT trim_scale(remaining) FROM open_item WHERE id = '$OI') || '|' || (SELECT trim_scale(remaining) FROM open_item WHERE id = '$PAY');")"
J=$(uuid)
err   "R12 an application is undone at most once"           "has already been undone" \
      "$(in_a "$(jh $J 2026-07-29) $(st 900008 $J 2026-07-29 $OI $PAY 500 unapply 900001)")"
J=$(uuid); X=$(uuid)
err   "R13 an open item sits on a control account of its side" "must sit on a receivable control account" \
      "$(in_a "$(jh $J 2026-07-15) $(gl $J 2026-07-15 $CASH 10) $(gl $J 2026-07-15 $SALES -10) $(oi $X $J 2026-07-15 $P1 $CASH 10)")"
JU1=$(uuid); JU2=$(uuid); OIU=$(uuid); PAYU=$(uuid)
ok    "R14 a USD invoice and its USD payment post at different rates" \
      "$(in_a "$(jh $JU1 2026-07-10)
        INSERT INTO gl_line (tenant_id,journal_id,company_id,posting_date,account_id,amount,currency,amount_tc,party_id) VALUES
          ('$TA','$JU1','$CA','2026-07-10','$AR', 11000,'USD', 100,'$P1'), ('$TA','$JU1','$CA','2026-07-10','$SALES',-11000,'USD',-100,NULL);
        INSERT INTO open_item (tenant_id,id,journal_id,company_id,posting_date,party_id,side,account_id,due_date,currency,amount,amount_tc,remaining,remaining_tc)
          VALUES ('$TA','$OIU','$JU1','$CA','2026-07-10','$P1','receivable','$AR','2026-08-09','USD',11000,100,0,0);
        $(jh $JU2 2026-07-12)
        INSERT INTO gl_line (tenant_id,journal_id,company_id,posting_date,account_id,amount,currency,amount_tc,party_id) VALUES
          ('$TA','$JU2','$CA','2026-07-12','$CASH', 11200,'USD', 100,NULL), ('$TA','$JU2','$CA','2026-07-12','$AR',-11200,'USD',-100,'$P1');
        INSERT INTO open_item (tenant_id,id,journal_id,company_id,posting_date,party_id,side,account_id,due_date,currency,amount,amount_tc,remaining,remaining_tc)
          VALUES ('$TA','$PAYU','$JU2','$CA','2026-07-12','$P1','receivable','$AR','2026-07-12','USD',-11200,-100,0,0);")"
J=$(uuid)
err   "R15 a realized exchange difference must post to the control account" "moved 0 in the GL but 200" \
      "$(in_a "$(jh $J 2026-07-14)
        INSERT INTO settlement (tenant_id,id,journal_id,company_id,posting_date,debit_item_id,credit_item_id,amount,amount_tc,fx_difference)
          VALUES ('$TA',900009,'$J','$CA','2026-07-14','$OIU','$PAYU',11000,100,200);")"
J=$(uuid)
equal "R16 with its gain posted, the USD items settle to zero in both currencies" "0|0|0|0" \
      "$(in_a "$(jh $J 2026-07-14)
        INSERT INTO settlement (tenant_id,id,journal_id,company_id,posting_date,debit_item_id,credit_item_id,amount,amount_tc,fx_difference)
          VALUES ('$TA',900010,'$J','$CA','2026-07-14','$OIU','$PAYU',11000,100,200);
        INSERT INTO gl_line (tenant_id,journal_id,company_id,posting_date,account_id,amount,currency,amount_tc,party_id) VALUES
          ('$TA','$J','$CA','2026-07-14','$AR',200,'BDT',0,'$P1'), ('$TA','$J','$CA','2026-07-14','$FXG',-200,'BDT',0,NULL);
        SELECT string_agg(trim_scale(remaining) || '|' || trim_scale(remaining_tc), '|' ORDER BY amount) FROM open_item WHERE id IN ('$OIU','$PAYU');")"

J=$(uuid); X=$(uuid)
err   "R17 the GL's receivable line must name the open item's customer" "control account 1200 (receivable) for" \
      "$(in_a "$(jh $J 2026-07-15) $(gl $J 2026-07-15 $AR 50 "'$P2'") $(gl $J 2026-07-15 $SALES -50) $(oi $X $J 2026-07-15 $P1 $AR 50)")"

echo "== Document lifecycle"
D1=$(uuid)
ok    "D01 a draft can be created and edited" \
      "$(in_a "$(doc $D1 2026-07-20 "'$P1'")
       INSERT INTO document_line (tenant_id,id,company_id,document_id,line_no,item_id,qty,uom,base_qty,unit_price)
         VALUES ('$TA',gen_random_uuid(),'$CA','$D1',1,'$ITEMA',2,'pcs',2,4500);
       UPDATE document SET posting_date = '2026-07-21', version = version + 1 WHERE id = '$D1';")"
equal "D02 submit assigns the next number from the series"  "M63-DHK-000001" \
      "$(in_a "$(submit $D1) SELECT number FROM document WHERE id = '$D1';")"
equal "D02a the database audited the submit with old and new values, and who did it" '["draft", "submitted"]|"M63-DHK-000001"|true' \
      "$(in_a "SELECT (changes->'status')::text || '|' || (changes->'number'->1)::text || '|' || (actor_id = '$U')::text FROM audit_log
                WHERE entity = 'document' AND entity_id = '$D1' AND action = 'update' ORDER BY id DESC LIMIT 1;")"
$APP -c "$(in_a "UPDATE party SET name = 'Rahim General Store' WHERE id = '$P1';")" >/dev/null
equal "D03 submit froze the buyer's name and BIN as printed" "Rahim Store|000123456-0101" \
      "$(in_a "SELECT (party_snapshot->>'name') || '|' || (party_snapshot->>'bin') FROM document WHERE id = '$D1';")"
DG1=$(uuid); DG2=$(uuid)
$APP -c "$(in_a "$(doc $DG1 2026-07-21) $(doc $DG2 2026-07-21)")" >/dev/null
$APP -c "BEGIN; $CTX_A $(submit $DG1) ROLLBACK;" >/dev/null
equal "D04 a rolled-back submit leaves no gap in the numbers" "M63-DHK-000002" \
      "$(in_a "$(submit $DG2) SELECT number FROM document WHERE id = '$DG2';")"
err   "D05 a submitted document cannot be edited"           "correct it with a new document" \
      "$(in_a "UPDATE document SET posting_date = '2026-07-22' WHERE id = '$D1';")"
err   "D06 no line can be added after submit"               "lines of a submitted document cannot change" \
      "$(in_a "INSERT INTO document_line (tenant_id,id,company_id,document_id,line_no,item_id,qty,uom,base_qty)
               VALUES ('$TA',gen_random_uuid(),'$CA','$D1',2,'$ITEMA',1,'pcs',1);")"
err   "D07 a submitted document cannot be deleted"          "never deleted" "$(in_a "DELETE FROM document WHERE id = '$D1';")"
err   "D08 a document cannot be created already submitted" "created as a draft" \
      "$(in_a "INSERT INTO document (tenant_id,id,company_id,doc_type,number,status,posting_date,currency)
               VALUES ('$TA',gen_random_uuid(),'$CA','sales_invoice','M63-DHK-999999','submitted','2026-07-20','BDT');")"
err   "D09 the app cannot move a number series"             "permission denied" \
      "$(in_a "UPDATE number_series SET next_value = 1 WHERE code = 'M63-DHK-2026';")"
su_err "D10 nor can the owner"                              "advances only when a document is submitted" \
      "SET ROLE erp_owner; $(in_a "UPDATE number_series SET next_value = 1 WHERE code = 'M63-DHK-2026';")"
DI=$(uuid)
$APP -c "$(in_a "$(doc $DI 2026-07-21 "'$P1'")")" >/dev/null
$APP -c "$(in_a "$(submit $DI)")" >/dev/null
$APP -c "$(in_a "UPDATE document SET issued_at = now() WHERE id = '$DI';")" >/dev/null
err   "D11 an issued Mushak 6.3 cannot be cancelled"        "issued to the buyer" \
      "$(in_a "UPDATE document SET status = 'cancelled' WHERE id = '$DI';")"
ok    "D12 a submitted, unissued document in an open period can be cancelled" \
      "$(in_a "UPDATE document SET status = 'cancelled' WHERE id = '$D1';")"
DJ=$(uuid)
$APP -c "$(in_a "INSERT INTO document (tenant_id,id,company_id,doc_type,series_code,posting_date,currency)
                 VALUES ('$TA','$DJ','$CA2','sales_invoice','M63-CTG-2026','2026-07-20','BDT');")" >/dev/null
$APP -c "$(in_a "$(submit $DJ)")" >/dev/null
$APP -c "$(in_a "INSERT INTO posting_lock VALUES ('$TA','$CA2','tax','2026-07-31');")" >/dev/null
err   "D13 a document in a locked period cannot be cancelled" "credit or debit note" \
      "$(in_a "UPDATE document SET status = 'cancelled' WHERE id = '$DJ';")"
DJ2=$(uuid)
err   "D13a nothing is submitted into a closed GL month"    "gl ledger is locked through 2026-06-30" \
      "$(in_a "$(doc $DJ2 2026-06-20) $(submit $DJ2)")"
D3=$(uuid)
ok    "D14 a draft can be deleted" "$(in_a "$(doc $D3 2026-07-20) DELETE FROM document WHERE id = '$D3';")"
D6=$(uuid); JD6=$(uuid)
ok    "D15 submitting a document and posting its journal is one transaction" \
      "$(in_a "$(doc $D6 2026-07-22) $(submit $D6) $(jh $JD6 2026-07-22 post "'$D6'") $(gl $JD6 2026-07-22 $CASH 300) $(gl $JD6 2026-07-22 $SALES -300)")"
err   "D16 cancelling without reversing its journals fails at COMMIT" "not all of its journals are reversed" \
      "$(in_a "UPDATE document SET status = 'cancelled' WHERE id = '$D6';")"
J=$(uuid)
err   "D17 a reversal must mirror the journal it reverses"  "does not mirror" \
      "$(in_a "UPDATE document SET status = 'cancelled' WHERE id = '$D6';
               $(jh $J 2026-07-22 reverse "'$D6'" "'$JD6'") $(gl $J 2026-07-22 $SALES 200) $(gl $J 2026-07-22 $CASH -200)")"
JR6=$(uuid)
ok    "D18 cancel plus a mirrored reversal commits" \
      "$(in_a "UPDATE document SET status = 'cancelled' WHERE id = '$D6';
               $(jh $JR6 2026-07-22 reverse "'$D6'" "'$JD6'") $(gl $JR6 2026-07-22 $SALES 300) $(gl $JR6 2026-07-22 $CASH -300)")"
J=$(uuid)
err   "D19 a journal is reversed at most once"              "duplicate key" \
      "$(in_a "$(jh $J 2026-07-23 reverse "'$D6'" "'$JD6'") $(gl $J 2026-07-23 $SALES 300) $(gl $J 2026-07-23 $CASH -300)")"
J=$(uuid)
err   "D19a a reversal is never itself reversed"            "never another reversal" \
      "$(in_a "$(jh $J 2026-07-23 reverse "'$D6'" "'$JR6'") $(gl $J 2026-07-23 $CASH 300) $(gl $J 2026-07-23 $SALES -300)")"
D7=$(uuid); J=$(uuid)
err   "D20 a draft document cannot post"                    "cannot post for a draft document" \
      "$(in_a "$(doc $D7 2026-07-22) $(jh $J 2026-07-22 post "'$D7'") $(gl $J 2026-07-22 $CASH 10) $(gl $J 2026-07-22 $SALES -10)")"
DR=$(uuid); JR0=$(uuid); OR1=$(uuid)
$APP -c "$(in_a "$(doc $DR 2026-07-24 "'$P1'") $(submit $DR)
                 $(jh $JR0 2026-07-24 post "'$DR'") $(gl $JR0 2026-07-24 $AR 800 "'$P1'") $(gl $JR0 2026-07-24 $SALES -800)
                 $(oi $OR1 $JR0 2026-07-24 $P1 $AR 800)")" >/dev/null || echo "setup DR failed"
J=$(uuid); X=$(uuid)
err   "D22 a reversal mirrors per customer, not just per account (the second review's repro)" "does not mirror" \
      "$(in_a "UPDATE document SET status = 'cancelled' WHERE id = '$DR';
               $(jh $J 2026-07-24 reverse "'$DR'" "'$JR0'") $(gl $J 2026-07-24 $AR -800 "'$P2'") $(gl $J 2026-07-24 $SALES 800)
               $(oi $X $J 2026-07-24 $P2 $AR -800)")"
J=$(uuid); X=$(uuid)
err   "D23 a reversal must settle the open items it reverses" "must settle the open items" \
      "$(in_a "UPDATE document SET status = 'cancelled' WHERE id = '$DR';
               $(jh $J 2026-07-24 reverse "'$DR'" "'$JR0'") $(gl $J 2026-07-24 $AR -800 "'$P1'") $(gl $J 2026-07-24 $SALES 800)
               $(oi $X $J 2026-07-24 $P1 $AR -800)")"
J=$(uuid); OR2=$(uuid)
equal "D24 cancel, mirrored reversal and settlement commit; both items close" "0|0" \
      "$(in_a "UPDATE document SET status = 'cancelled' WHERE id = '$DR';
               $(jh $J 2026-07-24 reverse "'$DR'" "'$JR0'") $(gl $J 2026-07-24 $AR -800 "'$P1'") $(gl $J 2026-07-24 $SALES 800)
               $(oi $OR2 $J 2026-07-24 $P1 $AR -800) $(st 900020 $J 2026-07-24 $OR1 $OR2 800)
               SELECT string_agg(trim_scale(remaining)::text, '|') FROM open_item WHERE id IN ('$OR1','$OR2');")"
DD=$(uuid); J=$(uuid)
err   "D25 a document posts on its own date"                "posts on its own date" \
      "$(in_a "$(doc $DD 2026-07-24) $(submit $DD) $(jh $J 2026-07-25 post "'$DD'") $(gl $J 2026-07-25 $CASH 10) $(gl $J 2026-07-25 $SALES -10)")"
D8=$(uuid)
err   "D21 a line cannot use another company's location"    "foreign key" \
      "$(in_a "$(doc $D8 2026-07-22) INSERT INTO document_line (tenant_id,id,company_id,document_id,line_no,item_id,location_id,qty,uom,base_qty)
               VALUES ('$TA',gen_random_uuid(),'$CA','$D8',1,'$ITEMA','$WH2',1,'pcs',1);")"

echo "== Stock"
JR=$(uuid)
equal "S01 a receipt with its value entry and GL commits; on hand rises" 10 \
      "$(in_a "$(jh $JR 2026-07-05) $(mv 900101 $JR 2026-07-05 $ITEMA $SUP $WH 10) $(ve $JR 2026-07-05 $ITEMA $WH 900101 10 1000)
               $(gl $JR 2026-07-05 $INV 1000 NULL "'$ITEMA'") $(gl $JR 2026-07-05 $GRNI -1000)
               SELECT trim_scale(on_hand) FROM stock_balance WHERE item_id = '$ITEMA' AND location_id = '$WH';")"
J=$(uuid)
err   "S02 stock cannot go negative by default"             "not enough stock" \
      "$(in_a "$(jh $J 2026-07-06) $(mv 900102 $J 2026-07-06 $ITEMA $WH $CUS 11)")"
J=$(uuid)
equal "S03 a location that allows negative stock accepts it" -1 \
      "$(in_a "$(jh $J 2026-07-06) $(mv 900103 $J 2026-07-06 $ITEMA $NEGWH $CUS 1) $(ve $J 2026-07-06 $ITEMA $NEGWH 900103 -1 0)
               SELECT trim_scale(on_hand) FROM stock_balance WHERE item_id = '$ITEMA' AND location_id = '$NEGWH';")"
err   "S04 the app cannot write on-hand quantities"         "permission denied" \
      "$(in_a "UPDATE stock_balance SET on_hand = 100 WHERE item_id = '$ITEMA';")"
su_err "S05 nor can the owner"                              "change only through stock moves" \
      "SET ROLE erp_owner; $(in_a "UPDATE stock_balance SET on_hand = 100 WHERE item_id = '$ITEMA';")"
J=$(uuid)
err   "S06 a move into stock must be valued in its journal" "has no value entry" \
      "$(in_a "$(jh $J 2026-07-06) $(mv 900104 $J 2026-07-06 $ITEMA $SUP $WH 5)")"
J=$(uuid)
err   "S07 a value entry carries its move's quantity"       "carries its move's quantity" \
      "$(in_a "$(jh $J 2026-07-06) $(mv 900105 $J 2026-07-06 $ITEMA $SUP $WH 10) $(ve $J 2026-07-06 $ITEMA $WH 900105 5 500)")"
J=$(uuid)
err   "S08 inventory in the GL must equal the value entries" "moved 900.0000 in the GL but 1000" \
      "$(in_a "$(jh $J 2026-07-06) $(mv 900106 $J 2026-07-06 $ITEMA $SUP $WH 10) $(ve $J 2026-07-06 $ITEMA $WH 900106 10 1000)
               $(gl $J 2026-07-06 $INV 900 NULL "'$ITEMA'") $(gl $J 2026-07-06 $GRNI -900)")"
J=$(uuid)
err   "S08a inventory in the GL must name the item it values" "for $ITEMA moved 0 in the GL but 1000" \
      "$(in_a "$(jh $J 2026-07-06) $(mv 900108 $J 2026-07-06 $ITEMA $SUP $WH 10) $(ve $J 2026-07-06 $ITEMA $WH 900108 10 1000)
               $(gl $J 2026-07-06 $INV 1000) $(gl $J 2026-07-06 $GRNI -1000)")"
J=$(uuid)
err   "S09 no stock moves into a locked stock period"       "stock ledger is locked through 2026-06-30" \
      "$(in_a "$(jh $J 2026-06-15) $(mv 900107 $J 2026-06-15 $ITEMA $SUP $WH 1)")"
APPLY="INSERT INTO cost_application (tenant_id,journal_id,company_id,posting_date,item_id,out_move_date,out_move_id,in_move_date,in_move_id,qty)"
J=$(uuid)
err   "S10 cost applications cannot exceed a move's quantity" "would exceed the quantity of move 900201" \
      "$(in_a "$(jh $J 2026-07-07) $(mv 900201 $J 2026-07-07 $ITEMA $WH $CUS 3) $(ve $J 2026-07-07 $ITEMA $WH 900201 -3 -300)
               $(gl $J 2026-07-07 $COGS 300) $(gl $J 2026-07-07 $INV -300 NULL "'$ITEMA'")
               $APPLY VALUES ('$TA','$J','$CA','2026-07-07','$ITEMA','2026-07-07',900201,'2026-07-05',900101,4);")"
J=$(uuid)
equal "S11 a delivery consumes its receipt; one balance row per item and location" "7|1" \
      "$(in_a "$(jh $J 2026-07-07) $(mv 900202 $J 2026-07-07 $ITEMA $WH $CUS 3) $(ve $J 2026-07-07 $ITEMA $WH 900202 -3 -300)
               $(gl $J 2026-07-07 $COGS 300) $(gl $J 2026-07-07 $INV -300 NULL "'$ITEMA'")
               $APPLY VALUES ('$TA','$J','$CA','2026-07-07','$ITEMA','2026-07-07',900202,'2026-07-05',900101,3);
               SELECT trim_scale(sum(on_hand)) || '|' || count(*) FROM stock_balance WHERE item_id = '$ITEMA' AND location_id = '$WH';")"
err   "S12 an item with stock moves keeps its valuation method" "has stock moves" \
      "$(in_a "UPDATE item SET valuation = 'moving_avg' WHERE id = '$ITEMA';")"

echo "== Concurrency (two real sessions)"
J=$(uuid)
$APP -c "$(in_a "$(jh $J 2026-07-08) $(mv 900301 $J 2026-07-08 $ITEMC $SUP $WH 1) $(ve $J 2026-07-08 $ITEMC $WH 900301 1 100)
                 $(gl $J 2026-07-08 $INV 100 NULL "'$ITEMC'") $(gl $J 2026-07-08 $GRNI -100)")" >/dev/null
deliver() { echo "$(jh $1 2026-07-09) $(mv $2 $1 2026-07-09 $ITEMC $WH $CUS 1) $(ve $1 2026-07-09 $ITEMC $WH $2 -1 -100)
                  $(gl $1 2026-07-09 $COGS 100) $(gl $1 2026-07-09 $INV -100 NULL "'$ITEMC'")"; }
JC1=$(uuid); JC2=$(uuid)
( $APP -c "BEGIN; $CTX_A $(deliver $JC1 900302) SELECT pg_sleep(2); COMMIT;" >/dev/null 2>&1 ) &
sleep 0.5
out=$($APP -c "$(in_a "$(deliver $JC2 900303)")" 2>&1); wait
if grep -q "not enough stock" <<<"$out"; then echo "PASS  C01 two deliveries of the last unit: the second waits, then fails"; pass=$((pass+1)); else echo "FAIL  C01 -> $out"; fail=$((fail+1)); fi
D4=$(uuid)
$APP -c "$(in_a "$(doc $D4 2026-07-25)")" >/dev/null
( $APP -c "BEGIN; $CTX_A $(submit $D4) SELECT pg_sleep(2); COMMIT;" >/dev/null 2>&1 ) &
sleep 0.5
out=$($APP -c "$(in_a "INSERT INTO document_line (tenant_id,id,company_id,document_id,line_no,item_id,qty,uom,base_qty)
                       VALUES ('$TA',gen_random_uuid(),'$CA','$D4',1,'$ITEMA',1,'pcs',1);")" 2>&1); wait
if grep -q "lines of a submitted document cannot change" <<<"$out"; then echo "PASS  C02 a line added during a submit waits, then is refused"; pass=$((pass+1)); else echo "FAIL  C02 -> $out"; fail=$((fail+1)); fi

JL=$(uuid)
( $APP -c "BEGIN; $CTX_A INSERT INTO posting_lock VALUES ('$TA','$CA2','gl','2026-07-31'); SELECT pg_sleep(2); COMMIT;" >/dev/null 2>&1 ) &
sleep 0.5
out=$($APP -c "$(in_a "INSERT INTO journal (tenant_id,id,company_id,posting_date,kind) VALUES ('$TA','$JL','$CA2','2026-07-31','post');
                       INSERT INTO gl_line (tenant_id,journal_id,company_id,posting_date,account_id,amount,currency,amount_tc) VALUES
                         ('$TA','$JL','$CA2','2026-07-31','$CASH2',10,'BDT',10), ('$TA','$JL','$CA2','2026-07-31','$SALES2',-10,'BDT',-10);")" 2>&1); wait
if grep -q "gl ledger is locked through 2026-07-31" <<<"$out"; then echo "PASS  C03 a posting that arrives while its period is being locked waits, then is refused"; pass=$((pass+1)); else echo "FAIL  C03 -> $out"; fail=$((fail+1)); fi
D9=$(uuid); J=$(uuid)
$APP -c "$(in_a "$(doc $D9 2026-07-26)")" >/dev/null; $APP -c "$(in_a "$(submit $D9)")" >/dev/null
( $APP -c "BEGIN; $CTX_A UPDATE document SET status = 'cancelled' WHERE id = '$D9'; SELECT pg_sleep(2); COMMIT;" >/dev/null 2>&1 ) &
sleep 0.5
out=$($APP -c "$(in_a "$(jh $J 2026-07-26 post "'$D9'") $(gl $J 2026-07-26 $CASH 10) $(gl $J 2026-07-26 $SALES -10)")" 2>&1); wait
if grep -q "cannot post for a cancelled document" <<<"$out"; then echo "PASS  C04 a posting racing its document's cancellation waits, then is refused"; pass=$((pass+1)); else echo "FAIL  C04 -> $out"; fail=$((fail+1)); fi

X1=$(uuid); J=$(uuid)
$APP -c "$(in_a "INSERT INTO account (tenant_id,id,company_id,code,name,kind) VALUES ('$TA','$X1','$CA','1250','Other receivables','asset');")" >/dev/null
( $APP -c "BEGIN; $CTX_A $(jh $J 2026-07-27) $(gl $J 2026-07-27 $X1 5000 "'$P1'") $(gl $J 2026-07-27 $CASH -5000) SELECT pg_sleep(2); COMMIT;" >/dev/null 2>&1 ) &
sleep 0.5
out=$($APP -c "$(in_a "UPDATE account SET control_for = 'receivable' WHERE id = '$X1';")" 2>&1); wait
if grep -q "has postings" <<<"$out"; then echo "PASS  C05 turning an account into a control account waits for a posting in flight, then is refused"; pass=$((pass+1)); else echo "FAIL  C05 -> $out"; fail=$((fail+1)); fi

echo "== Catalog (run as superuser)"
su_equal "K01 every table with tenant_id, in every schema and partition, has RLS enabled, forced and a policy" "0|8" \
      "SELECT count(*) FILTER (WHERE NOT (c.relrowsecurity AND c.relforcerowsecurity
                                          AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)))
              || '|' || count(*) FILTER (WHERE c.relispartition)
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\_%' AND c.relkind IN ('r','p')
          AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped);"
su_equal "K02 erp_app owns nothing and cannot bypass RLS"   "false|0" \
      "SELECT r.rolbypassrls::text || '|' || (SELECT count(*) FROM pg_class WHERE relowner = r.oid) FROM pg_roles r WHERE rolname = 'erp_app';"
su_equal "K03 erp_app cannot create temporary tables or objects in any schema" "false|0" \
      "SELECT has_database_privilege('erp_app', current_database(), 'TEMP')::text || '|'
              || (SELECT count(*) FROM pg_namespace n WHERE has_schema_privilege('erp_app', n.oid, 'CREATE'));"
su_equal "K04 every plpgsql function pins search_path with pg_temp last" 0 \
      "SELECT count(*) FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
          AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search\_path=%pg\_temp');"
su_equal "K05 SECURITY DEFINER functions belong to erp_guard, which cannot log in, bypass RLS or own tables" "11|0|false|0" \
      "SELECT count(*) FILTER (WHERE p.prosecdef) || '|' || count(*) FILTER (WHERE p.prosecdef AND p.proowner <> 'erp_guard'::regrole)
              || '|' || (SELECT (rolcanlogin OR rolbypassrls)::text FROM pg_roles WHERE rolname = 'erp_guard')
              || '|' || (SELECT count(*) FROM pg_class WHERE relowner = 'erp_guard'::regrole)
         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace;"
su_equal "K06 every ledger table and partition refuses TRUNCATE" 0 \
      "SELECT count(*) FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p')
          AND (c.relname IN ('journal','gl_line','stock_move','stock_value_entry','tax_line','open_item',
                             'settlement','cost_application','audit_log')
               OR c.oid IN (SELECT inhrelid FROM pg_inherits))
          AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgfoid = 'public.reject_truncate'::regproc);"
su_equal "K07 the COMMIT-check queue is empty between transactions" 0 \
      "SET ROLE erp_owner; $(in_a "SELECT count(*) FROM journal_check;")"

err   "K08 erp_app cannot take advisory locks (so it cannot stall the lock-date protocol)" "permission denied for function pg_advisory_lock" \
      "SELECT pg_advisory_lock(1);"

echo "== Performance"
J=$(uuid)
t0=$(now_ms)
out=$($APP -c "$(in_a "$(jh $J 2026-07-31)
  INSERT INTO gl_line (tenant_id,journal_id,company_id,posting_date,account_id,amount,currency,amount_tc)
  SELECT '$TA','$J','$CA','2026-07-31', CASE WHEN g % 2 = 0 THEN '$CASH'::uuid ELSE '$SALES'::uuid END,
         CASE WHEN g % 2 = 0 THEN 1 ELSE -1 END, 'BDT', CASE WHEN g % 2 = 0 THEN 1 ELSE -1 END
    FROM generate_series(1, 4000) g;")" 2>&1)
rc=$?; ms=$(( $(now_ms) - t0 ))
if [ $rc -eq 0 ] && [ $ms -lt 3000 ]; then echo "PASS  P01 a 4,000-line journal commits in ${ms} ms (limit 3,000)"; pass=$((pass+1)); else echo "FAIL  P01 -> rc=$rc ${ms} ms $out"; fail=$((fail+1)); fi

echo; echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
