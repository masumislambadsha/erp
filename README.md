# ERP starter kit

Everything Claude Code needs to start Phase 0 of the ERP plan.

| Path | What it is |
| --- | --- |
| `PROMPT.md` | The kickoff prompt for Claude Code, and one prompt per Phase 0 milestone |
| `CLAUDE.md` | Project rules Claude Code loads on every run: non-negotiables, stack, commands, milestones |
| `docs/PLAN.md` | The full plan, exported from the "ERP Master Plan" doc on 6 Nov 2026 |
| `docs/FEATURE_MAP.md` | All 172 features with their tiers |
| `db/schema.sql` | The ledger kernel: 29 tables and their database guards |
| `db/tests.sh` | 119 tests that attack the kernel |
| `db/test-output.txt` | The last full run: 119 passed |
| `docker-compose.yml`, `scripts/` | Run the kernel tests in a throwaway PostgreSQL 16 container |
| `.github/workflows/kernel.yml` | Runs the kernel tests in CI on every push |

## Start

1. Put this folder in a new git repo and push it to GitHub.
2. Install Docker. Bash is needed too: on Windows, use WSL or Git Bash.
3. Run `bash scripts/db-test.sh`. It should end with `119 passed, 0 failed`.
4. Open Claude Code in the folder and paste the kickoff prompt from `PROMPT.md`.
