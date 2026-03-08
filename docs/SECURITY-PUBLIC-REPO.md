# Public Repository Security

## Policy

This repository must not expose personal machine details, local usernames, or private credentials.

## Rules

- Never commit `.env` files
- Never commit local virtual environments
- Never commit runtime queue/result artifacts unless explicitly intended
- Use `$HOME` placeholders in examples instead of absolute local paths
- Use environment variables for all publish credentials and tokens

## Verification Checks

Run before every push:

```bash
rg -n '(/Users/|MacBook-Pro|tatsheen|jamonwidit@|plushtrap\.com|plushtrap/|Tatsheens-Mini|\(408\) 386-1907|408-386-1907|/Volumes/home/Storage|\bScott\b)' --glob '!.git/**' --glob '!node_modules/**' --glob '!.venv-openclaw-tools/**'
```

The command should return no personal identifiers in tracked documentation or config.

## Branch Discipline

- Use `main` as the single public release line
- Avoid long-lived parallel release branches

## Push Rule Reference

- See [PUSH-RULES.md](PUSH-RULES.md) for mandatory pre-push checks and InayanBuilderBot coordination requirements.
