# Portal Source Provenance

This app was imported for the Mastra candidate from the only authorized Portal
source repository:

```text
/Users/combo/MyFile/projects/invest-agent-portal
commit: 5c35f0ec6e70cd736b98f504e75d2e860956728e
subject: fix portal conversation mirror recovery
```

The import excludes `.git/`, `node_modules/`, `.next*`, `data/`, logs, and all
`.env*` files. The source repository remains the release source until the
Mastra candidate passes its isolated local acceptance gate. This app runs as a
separate Next.js + Relay process and owns its own Portal SQLite mirror; it does
not share a database with `apps/runtime`.
