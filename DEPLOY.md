# Deploy

| Field | Value |
|---|---|
| Production URL | _set after first deploy_ |
| Visibility | metalab-org |
| Vercel team | mylesmetalab |
| First deployed | _pending_ |
| Last deployed | _pending_ |

> The `Production URL` row is filled in by the tools-hub on first
> successful `/publish`.

## Required env vars

| Var | Where to set | Notes |
|---|---|---|
| `GEMINI_API_KEY` | `vercel env add GEMINI_API_KEY production` | Get at <https://aistudio.google.com/apikey> |
| `METALAB_HUB_TOKEN` | Auto-injected by hub on every deploy | Don't set manually |

## Re-deploy

Use `/publish inflated-scene-composer` — routes through the hub.

## Audit status

Pending — run through `docs/before-designer-pairing.md` (in
generative-shell) before showing to a designer.
