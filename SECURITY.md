# Security Policy

OpenGPT Live handles microphone audio, provider credentials, and streamed model
output. Please treat security and privacy issues carefully, even when testing a
local deployment.

## Supported versions

This project is pre-1.0 and evolves quickly.

| Version | Security fixes |
| --- | --- |
| Default branch | Supported |
| Latest tagged release | Best effort |
| Older commits or forks | Not supported |

Before reporting, reproduce against the current default branch when it is safe
to do so.

## Report a vulnerability privately

Do not open a public issue for a suspected vulnerability.

Use GitHub's **Security → Report a vulnerability** flow for this repository. If
private vulnerability reporting is unavailable, open a public issue containing
only a request for a private maintainer contact. Do not include exploit details,
credentials, private audio, or personal data in that issue.

Please include:

- The affected commit or version and deployment shape.
- A concise impact statement and realistic attack scenario.
- Minimal reproduction steps or a proof of concept.
- Whether credentials, microphone audio, transcripts, or network boundaries are
  involved.
- A suggested fix or mitigation, if known.

We aim to acknowledge complete reports within five business days. Fix timing
depends on severity, reproducibility, and release risk. Please allow time for a
patch before public disclosure.

## Issues in scope

Examples include:

- Exposure of API keys, audio, transcripts, or session data.
- WebSocket validation bypasses, denial of service, or cross-origin access bugs.
- Provider URL handling that enables unintended network access.
- Cancellation or reconnect behavior that sends data after a user stops a turn.
- Dependency vulnerabilities that are exploitable in the shipped application.

General hardening suggestions, provider outages, model-quality problems, and
unsupported public deployments are normally not vulnerabilities. They can use a
regular issue unless sensitive information is involved.

## Safe research

- Test only systems and accounts you control.
- Use synthetic audio and redacted credentials.
- Avoid privacy violations, persistence, destructive actions, and service
  disruption.
- Stop testing once you have enough evidence to report the issue.

Thank you for helping protect users and contributors.
