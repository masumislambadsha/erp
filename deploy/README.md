# Deploying to one small Linux server

Everything runs on one VPS under Docker Compose: PostgreSQL 16 (a real superuser, which the kernel's migrations need),
the API, the web app, Caddy (automatic TLS), and a backup shipper. Nothing here deploys by itself until you give it a server:
the deploy workflow skips cleanly while its secrets are unset. The region is your decision (D11); `scripts/latency-test.sh` helps you make it.

## What you buy

| What | Why | Rough size |
| --- | --- | --- |
| A Linux VPS in the region you choose | runs everything | 2 vCPU, 4 GB RAM, 40 GB SSD, Ubuntu 24.04 LTS or Debian 12, public IPv4 |
| A domain name | Caddy gets a certificate for it | any registrar; one A record to the VPS's IP |
| An S3-compatible bucket (any provider, ideally another provider and region than the VPS) | encrypted off-server backups | a few GB; set a lifecycle rule to expire objects after your retention (14 days to start) |

Data-protection note (PLAN.md D11): where the server and the bucket sit is a legal question first. Get the lawyer's written opinion before real tenant data goes in.

## What you paste into GitHub (Settings, Secrets and variables, Actions, repository secrets)

| Secret | Value |
| --- | --- |
| `DEPLOY_HOST` | the server's IP or host name |
| `DEPLOY_USER` | the SSH user, for example `deploy` (must be in the `docker` group) |
| `DEPLOY_SSH_KEY` | the PRIVATE key of a key pair made only for deploys (`ssh-keygen -t ed25519 -f deploy_key -N ''`); put the `.pub` in the server user's `~/.ssh/authorized_keys` |
| `DEPLOY_KNOWN_HOSTS` | the output of `ssh-keyscan -t ed25519 YOUR_HOST`, checked against the fingerprint your provider shows |
| `DEPLOY_PATH` | optional: where the repository lives on the server (default `/srv/erp`) |
| `DEPLOY_ENV_FILE` | optional: the full contents of `deploy/.env` (below). If set, every deploy writes it to the server, so GitHub holds the master copy; if not, you keep `deploy/.env` on the server yourself |

## One-time server setup

```bash
# as root on the new server
apt-get update && apt-get install -y docker.io docker-compose-v2 git ufw
adduser --disabled-password deploy && usermod -aG docker deploy
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
# as deploy
git clone https://github.com/masumislambadsha/erp /srv/erp   # make /srv/erp writable by deploy first
cd /srv/erp/deploy && cp .env.example .env && chmod 600 .env   # fill it in (see the comments in the file)
```

Secrets in `.env` are yours to generate: `openssl rand -base64 32` for each password and for `TOTP_ENCRYPTION_KEY`.
**Back up `TOTP_ENCRYPTION_KEY` somewhere safe**: lose it and every TOTP user is locked out.
Backups: `age-keygen -o backup-key.txt` on your own computer; put the printed PUBLIC key (`age1...`) in `BACKUP_AGE_RECIPIENT`
and keep `backup-key.txt` offline. Without that private key a backup cannot be read, by anyone.

## First deploy, then tenant zero

Push to main (or run the `deploy` workflow by hand), or on the server: `bash /srv/erp/deploy/deploy.sh $(git -C /srv/erp rev-parse HEAD)`.
Then create your building:

```bash
cd /srv/erp/deploy
docker compose run --rm -e DATABASE_ADMIN_URL="postgres://postgres:$POSTGRES_SUPERUSER_PASSWORD@db:5432/erp" \
  -e PROVISION_ADMIN_PASSWORD='choose a long password' api \
  node dist/cli/tenant-zero-main.js "My Building" you@example.com "Your Name"
```

It prints the tenant id; sign in at `https://YOUR_DOMAIN/login` with it (the admin role asks you to set up TOTP).

## What a deploy does (`deploy/deploy.sh`)

1. checks out the commit; 2. **takes a base backup first** (skipped only on an empty first deploy; if backups are configured and the backup fails, the deploy stops);
3. builds the images; 4. runs migrations as the superuser, creates ledger partitions through next year, and sets the role passwords; 5. restarts, and waits for `/health`.

Migrations are forward-only. To undo a bad release, deploy a fixed commit; to undo bad data, restore (below).

## Backups and restores

The `backup` service ships every WAL segment (once a minute) and a base backup (nightly at `BACKUP_BASE_HOUR_UTC`, default 02:00 Dhaka),
each encrypted with `age` before it leaves the server. Check it is working: `docker compose logs backup`, and `aws s3 ls` the bucket.
Restore into a **new** PostgreSQL (never over the live one), from any machine that has `aws`, `age` and PostgreSQL 16:

```bash
deploy/restore.sh --identity backup-key.txt --bucket YOUR_BUCKET --endpoint https://s3.example \
  --base base-20261107T200000Z.tar.age --target "2026-11-08 09:30:00+00" --data /var/lib/pgrestore --port 5440
```

Then compare with production: `SELECT * FROM integrity_check()` returns nothing, and `trial_balance(<company>, <date>)` matches.
**Do this drill against a real backup before you rely on it, and monthly after.** (CI runs the same recovery on throwaway clusters every push: `scripts/restore-drill.sh`.)

## Choosing the region

From Dhaka, on the network you will really use: `bash scripts/latency-test.sh` (a built-in list of public test hosts), or
`bash scripts/latency-test.sh -n 20 name=host ...` for providers' test hosts or a trial server (`-p /health`). Compare the **ttfb** columns (what a click feels like).

## Running costs and limits

One server means one failure domain: the backups are what protects you, so verify them. Rate-limit counters are per process (fine for one API).
Metrics are on the API's port 9464 inside the compose network only; point a Prometheus at it if you add one (`ops/alerts.yml` has the rules).
