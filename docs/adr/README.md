# Architecture decision records

One file per decision, Nygard format (`0000-template.md`). Number in order; never renumber. To change a decision, write a new ADR and mark the old one "Superseded by NNNN". `docs/DECISIONS.md` keeps the short dated log; ADRs hold the reasoning.

| ADR | Title | Status |
|---|---|---|
| 0001 | Read-only Shopify via client credentials + Key Vault | Accepted |
| 0002 | No connection to the dev team's database | Accepted |
| 0003 | JSON-file store now, move on a measured trigger | Accepted |
| 0004 | What counts as a sale | Accepted |
| 0005 | Sales rate = demand per in-stock day | Accepted (amended by SW-003) |
| 0006 | Simple default UI, detail on demand, role views subtract | Accepted |
| 0007 | Five critics every dev cycle | Accepted |
| 0008 | Shared packages for multi-module logic | Proposed |
| 0009 | One authoritative data source per store | Accepted |
| 0010 | Current-stock snapshot separate from change history | Proposed |
| 0011 | Auth: one admin password, signed cookie, hardened | Accepted |
| 0012 | Single instance on Railway, deploy from a clean main | Accepted |
| 0013 | Performity look and feel | Accepted |
