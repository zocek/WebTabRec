## Summary
Briefly describe what this Pull Request changes.

## Related Issue / ADR
- Fixes # (if applicable)

## Checklist
- [ ] Follows [AGENTS.md](AGENTS.md) constraints (single purpose, zero external network calls, minimal permissions).
- [ ] Updated both `_locales/en/messages.json` and `_locales/cs/messages.json` for any UI text changes and verified `npm run check` (`validate-locales` + unit & E2E tests) and `npm run package`.
- [ ] Updated relevant Layer 1 (`docs/*.md`, zero Mermaid) and Layer 2 (`docs/specs/*.spec.md`) documentation if behavior or contracts changed.
- [ ] Manually smoke-tested in Google Chrome (`chrome://extensions` → Load unpacked).
