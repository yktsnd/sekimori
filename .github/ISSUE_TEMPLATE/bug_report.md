---
name: Bug report
about: Something behaves differently from the documented behavior
labels: bug
---

**What happened / what did you expect?**

**Is this a fail-open?** (Does the bug let a request through that should
have been blocked — auth, budget, rate limit, model allowlist? If it also
exposes secrets, please use private vulnerability reporting instead — see
SECURITY.md.)

- [ ] Yes — sekimori allowed something it should have blocked
- [ ] No / not sure

**How to reproduce**

Ideally against the offline mock upstream (`node examples/mock-upstream.mjs`),
so no API key is involved:

```bash
# commands / config (redact any secrets)
```

**Environment**

- sekimori version / commit:
- Node.js version:
- OS:
