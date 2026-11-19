# Catalys modules

Standalone Catalys tools, one folder per module. Start with [AGENTS.md](AGENTS.md).

| Module | What |
|---|---|
| [modules/stock-watch](modules/stock-watch) | Stock-out Watch web app, live at https://web-production-6dd42b8d.up.railway.app |
| [modules/stock-watch-sheets](modules/stock-watch-sheets) | Google Sheet version, fed by Shopify Flow |

Each module has `AGENTS.md` (context for whoever works on it) and `LOGIC.md` (how every number is worked out, and why).

`npm test` runs every module's tests. `npm start` runs Stock-out Watch locally.
