# Security

Voxren Pi holds one secret on your behalf, a Riot Development key, and talks to one local service that trusts you, the League client. Both boundaries are described in [docs/privacy.md](docs/privacy.md).

## Scope

- Riot key custody: `src/riot-key.ts` and `src/riot-key-helper.mjs` (macOS Keychain, Windows DPAPI, the helper child process, what crosses its stdout).
- League client link: `src/lcu.ts` (lockfile handling, TLS pinned to `data/riotgames.pem`, `127.0.0.1` only, token containment).
- The launcher's environment allowlist: `bin/coach.mjs`.
- Anything that lets untrusted text (search results, OP.GG, match data) act as instructions or reach the terminal unsanitized: `src/policy.ts`, `src/passage-judge.ts`, `coach.yaml`.

Out of scope: rate limits, denial of service against your own machine, and issues in Pi, Perplexity, Google (the Gemini API), OP.GG, TypeSafe, or Riot's services themselves.

## Reporting

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for a security problem.

Include what you found, how to reproduce it, and which file you believe is responsible. Fixes ship as ordinary commits; the advisory is published once the fix is on `main`.

## If a Riot key leaks

Regenerate it at [developer.riotgames.com](https://developer.riotgames.com) and run `/riot-key` in the coach to store the new one. Development keys expire every 24 hours on their own.
