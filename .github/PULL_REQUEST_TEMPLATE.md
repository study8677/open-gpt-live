## What changed

<!-- Describe the focused change. -->

## Why

<!-- What user or maintainer problem does this solve? -->

## Change type

- [ ] Bug fix
- [ ] Voice quality, latency, or VAD improvement
- [ ] Protocol or Gateway lifecycle change
- [ ] Provider integration
- [ ] Web or playback change
- [ ] Documentation, tests, or maintenance

## Verification

```text
pnpm check:
additional manual test:
browser / device / provider:
```

<!-- Add before/after latency or VAD measurements when relevant. -->

## Compatibility and safety

- [ ] Tests cover the new behavior or the limitation is explained above.
- [ ] Protocol types, runtime validation, and `docs/protocol.md` agree.
- [ ] Interrupt, abort, reconnect, and late-event behavior were considered.
- [ ] New configuration is documented and defaults remain safe.
- [ ] Logs, fixtures, screenshots, and recordings contain no secrets or personal data.
- [ ] Provider changes honor the adapter boundary and can be tested without paid credentials.

## UI evidence

<!-- Add a screenshot or short recording for visible changes; otherwise write "Not applicable". -->
