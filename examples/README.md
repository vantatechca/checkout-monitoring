# Reference Examples

Drop PNG/JPG screenshots here to teach Claude Vision what a healthy vs. broken checkout looks like for *your* stores.

## Layout

```
examples/
  ok/        ← screenshots of working checkouts
  problem/   ← screenshots of any failure mode
```

No sub-folders, no labels per image — Claude compares the live page against both sets and returns `OK` or `PROBLEM`.

## What to put in `ok/`

A handful of screenshots of your checkouts in their **normal, fully-loaded state**:

- Payment section rendered (card fields, Shop Pay button, etc.)
- Address form filled/empty but visible
- Order summary with currency symbol

2–4 examples is enough. More doesn't help.

## What to put in `problem/`

Any failure you've seen or want to flag in the future:

- Payment section blank / stuck spinner
- Shopify "Store unavailable" / 404 / password-protected pages
- Bridge daily-limit plain-text response
- Cloudflare "Error 1101 — Worker threw exception"
- reCAPTCHA / Cloudflare bot challenge stuck on-screen
- Age verification popup blocking the form
- Half-rendered layouts

4–8 examples covers most cases. Past ~12 you hit diminishing returns and latency climbs.

## Naming

File names are ignored by the monitor — use whatever is memorable to you:

```
ok/
  mpc-2026-04-15.png
  vancouver-loaded.png
problem/
  payment-section-blank-jan.png
  bridge-1101-error.png
  store-suspended.png
```

## Cost

Each reference image you add to the folders gets sent with every check (every 30 min). That means:

- `examples/` total = ~6 images → adds ~$0.02/check → ~$30/month
- 12 images → ~$0.04/check → ~$60/month

The text-check short-circuit keeps cost low: obvious failures (plain "404", "Store unavailable", etc.) never hit Vision at all.

## How to replace images

Just overwrite the file and push to main. Render redeploys; examples load on the next boot. No env-var change needed.
