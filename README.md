# Checkout Monitor — Full Setup Guide

Automated Shopify checkout health monitor. Runs every 15 minutes, screenshots each store's checkout, uses Claude Vision to detect issues, and sends WhatsApp alerts with screenshots via Twilio.

---

## What You'll Need Accounts For
- **Render** — runs the cron job (free tier works)
- **Anthropic** — Claude Vision API (you already have this)
- **Twilio** — WhatsApp alerts (you already have this)
- **Cloudinary** — hosts screenshots so Twilio can attach them (free tier: 25GB)
- **Google Cloud** — for Sheets logging (optional but recommended)
- **GitHub** — to deploy to Render

---

## Step 1 — Get the Code on GitHub

1. Go to [github.com](https://github.com) and click **New repository**
2. Name it `checkout-monitor`, set it to **Private**, click **Create repository**
3. On your local machine, open a terminal in the project folder:
   ```bash
   git init
   git add .
   git commit -m "initial commit"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/checkout-monitor.git
   git push -u origin main
   ```

---

## Step 2 — Configure Your Stores

Open `stores.js` and fill in your store details.

**How to find a Variant ID:**
1. Go to your Shopify Admin → **Products**
2. Click on a product (e.g. BPC-157)
3. Click on a specific variant (e.g. "5mg")
4. Look at the URL — it ends with something like `/variants/12345678901`
5. That number after `/variants/` is your variant ID

**Example stores.js entry:**
```js
{
  id: "toronto-peptides",           // unique slug — no spaces
  name: "Toronto Peptides",         // shown in alerts
  storeUrl: "https://torontopeptides.com",
  productUrl: "https://torontopeptides.com/products/bpc-157",
  variantId: "44123456789012",      // from Shopify Admin URL
}
```

Add one entry per store. Copy the pattern for as many as you have.

---

## Step 3 — Cloudinary Setup (Screenshot Hosting)

Twilio needs a **public URL** to attach images to WhatsApp messages. Cloudinary provides this for free.

1. Go to [cloudinary.com](https://cloudinary.com) and create a free account
2. After logging in, you'll see your **Dashboard** — note your **Cloud Name** (top left, e.g. `dxyz1234`)
3. Go to **Settings** (gear icon, top right) → **Upload** tab
4. Scroll down to **Upload presets** → click **Add upload preset**
5. Set these fields:
   - **Preset name**: `checkout-monitor` (or anything you want)
   - **Signing Mode**: change to **Unsigned** ← this is critical
   - **Folder**: `checkout-monitor`
6. Click **Save**
7. Note the **Preset name** you just created

**Your Cloudinary env vars will be:**
```
CLOUDINARY_CLOUD_NAME=dxyz1234
CLOUDINARY_UPLOAD_PRESET=checkout-monitor
```

---

## Step 4 — Twilio WhatsApp Setup

You already use Twilio in your bridge workers, so you have the SID and Token. You just need to confirm WhatsApp is set up.

**If using the Twilio Sandbox (testing):**
1. Go to [console.twilio.com](https://console.twilio.com) → **Messaging** → **Try it out** → **Send a WhatsApp message**
2. Each phone number that should receive alerts needs to join the sandbox:
   - They send `join <sandbox-word>` to `+1 415 523 8886`
3. Your `TWILIO_WHATSAPP_FROM` = `+14155238886`

**If using an approved WhatsApp Business number:**
1. Go to **Messaging** → **Senders** → **WhatsApp Senders**
2. Use your approved sender number as `TWILIO_WHATSAPP_FROM`

**Your Twilio env vars:**
```
TWILIO_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_TOKEN=your_auth_token
TWILIO_WHATSAPP_FROM=+14155238886
ALERT_WHATSAPP_NUMBERS=+19171234567,+16471234567,+63917123456
```

Format `ALERT_WHATSAPP_NUMBERS` as a comma-separated list of full international numbers (with `+` and country code). No spaces between entries.

---

## Step 5 — Google Sheets Setup (Optional but Recommended)

This gives you a permanent log of every monitor run.

### 5a — Create the Sheet
1. Go to [sheets.google.com](https://sheets.google.com) → create a **New spreadsheet**
2. Name the first tab exactly: `Monitor`
3. Copy the Sheet ID from the URL:
   - URL looks like: `https://docs.google.com/spreadsheets/d/`**`1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms`**`/edit`
   - The bold part is your `SHEETS_ID`

### 5b — Create a Google Cloud Service Account
1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (or use an existing one) → name it `checkout-monitor`
3. In the left menu go to **APIs & Services** → **Library**
4. Search for **Google Sheets API** → click it → click **Enable**
5. Go to **APIs & Services** → **Credentials**
6. Click **+ Create Credentials** → **Service account**
7. Fill in:
   - **Service account name**: `checkout-monitor`
   - Click **Create and continue** → **Done**
8. Click on the service account you just created
9. Go to the **Keys** tab → **Add Key** → **Create new key** → **JSON** → **Create**
10. A JSON file downloads to your computer — open it in a text editor

### 5c — Share the Sheet with the Service Account
1. Open the downloaded JSON file — find the `client_email` field (looks like `checkout-monitor@your-project.iam.gserviceaccount.com`)
2. Go to your Google Sheet → click **Share** (top right)
3. Paste that email address → give it **Editor** access → click **Send**

### 5d — Prepare the JSON for the env var
The JSON file needs to go into a single env var. You need to minify it (remove line breaks):

**On Mac/Linux:**
```bash
cat ~/Downloads/your-service-account-file.json | tr -d '\n'
```

**On Windows (PowerShell):**
```powershell
(Get-Content "C:\Users\You\Downloads\your-service-account-file.json") -join ''
```

Copy that entire output — that's your `GOOGLE_SERVICE_ACCOUNT_JSON` value.

---

## Step 6 — Proxy Setup (Optional but Recommended)

Without a proxy, requests come from Render's datacenter IPs which Shopify/Cloudflare may flag. Using a residential proxy makes requests look like real customers.

**Using Webshare (you already have an account):**
1. Log into Webshare → go to **Proxy** → **List**
2. Click **Download** → select format: `host:port:username:password`
3. Pick any proxy from the list. Your env vars:
   ```
   PROXY_SERVER=http://proxy.webshare.io:80
   PROXY_USER=your-webshare-username
   PROXY_PASS=your-webshare-password
   ```

**Using Decodo/Smartproxy:**
1. Log into your dashboard → **Residential Proxies** → **Endpoint generator**
2. Select **Canada** as the country (for your CA stores)
3. Copy the endpoint, username, and password

If you skip the proxy, just leave the three `PROXY_*` vars empty in Render — the monitor will still work but may be blocked by some stores.

---

## Step 7 — Deploy to Render

### 7a — Create the Cron Job
1. Go to [render.com](https://render.com) and log in
2. Click **New +** → **Cron Job**
3. Connect your GitHub account if not already done
4. Select the `checkout-monitor` repository
5. Render will detect `render.yaml` automatically — click **Apply**
6. Review the settings:
   - **Name**: `checkout-monitor`
   - **Schedule**: `*/15 * * * *` (every 15 min)
   - **Runtime**: Node
   - **Build Command**: `npm install && npx playwright install chromium --with-deps`
   - **Start Command**: `node monitor.js`

### 7b — Set Environment Variables
1. In Render, go to your cron job → **Environment** tab
2. Add each variable one by one:

| Variable | Value | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-...` | From console.anthropic.com |
| `TWILIO_SID` | `ACxxx...` | From Twilio Console |
| `TWILIO_TOKEN` | `xxx...` | From Twilio Console |
| `TWILIO_WHATSAPP_FROM` | `+14155238886` | Sandbox or your approved number |
| `ALERT_WHATSAPP_NUMBERS` | `+1917...,+1647...,+639...` | Comma-separated, no spaces |
| `CLOUDINARY_CLOUD_NAME` | `dxyz1234` | From Cloudinary dashboard |
| `CLOUDINARY_UPLOAD_PRESET` | `checkout-monitor` | The unsigned preset name |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | `{"type":"service_account"...}` | Minified JSON from Step 5 |
| `SHEETS_ID` | `1BxiMVs0XRA...` | From Google Sheet URL |
| `PROXY_SERVER` | `http://proxy.webshare.io:80` | Optional |
| `PROXY_USER` | `your-proxy-user` | Optional |
| `PROXY_PASS` | `your-proxy-pass` | Optional |

3. Click **Save Changes**

### 7c — Trigger a Manual Run to Test
1. Go to your cron job in Render
2. Click **Trigger Run** (top right)
3. Click **Logs** to watch it run in real time
4. You should see output like:
   ```
   → Checking: Toronto Peptides
     ✓ Screenshots captured
     ✓ OK
   Monitor run complete.
   ```
5. Check your WhatsApp — if any store has a problem you'll get a message with a screenshot

---

## Step 8 — Test Locally First (Recommended)

Before deploying, test on your own machine to catch config issues early.

1. Install Node.js if you don't have it: [nodejs.org](https://nodejs.org) (v18+)

2. Install dependencies:
   ```bash
   npm install
   npx playwright install chromium --with-deps
   ```

3. Create your `.env` file:
   ```bash
   cp .env.example .env
   ```
   Open `.env` in a text editor and fill in all values.

4. Test a single store (fastest):
   ```bash
   node -e "import('./monitor.js').then(m => m.runSingle('toronto-peptides'))"
   ```
   Replace `toronto-peptides` with one of your store IDs from `stores.js`.

5. Run all stores at once:
   ```bash
   node monitor.js
   ```

6. Watch the terminal output — screenshots save to `/tmp/` and are deleted after analysis. If a problem is found you'll get a WhatsApp message and a row in Sheets.

---

## How Alerts Work

| Situation | What Happens |
|---|---|
| Store checkout looks broken | Alert sent to all numbers with screenshot attached |
| Store is still broken on next run | No repeat alert — silent until it changes |
| Store recovers | Recovery notification sent to all numbers |
| Page fails to load entirely | Alert sent with the error message (no screenshot) |
| Unexpected crash | Logged to Sheets only — no alert to avoid noise |

---

## Adding More Stores Later

Just add another entry to `stores.js` and push to GitHub. Render auto-deploys on push:

```js
{
  id: "vancouver-peptides",
  name: "Vancouver Peptides",
  storeUrl: "https://vancouverpeptides.com",
  productUrl: "https://vancouverpeptides.com/products/bpc-157",
  variantId: "44123456789099",
}
```

---

## Sending Alerts to Different Numbers Per Store

In `stores.js`, add an `alertNumbers` array to any store to override the global list:

```js
{
  id: "toronto-peptides",
  name: "Toronto Peptides",
  storeUrl: "https://torontopeptides.com",
  productUrl: "https://torontopeptides.com/products/bpc-157",
  variantId: "44123456789012",
  alertNumbers: ["+19171234567"],   // only this number for this store
}
```

Stores without `alertNumbers` fall back to the global `ALERT_WHATSAPP_NUMBERS` env var.

---

## Troubleshooting

**"Add to cart failed"**
- Double-check the `variantId` in `stores.js` — must match an active, in-stock variant
- Navigate to the product URL manually to confirm the product exists

**"Redirected away from checkout"**
- The store may have password protection enabled in Shopify Admin
- Check if the store requires an account login before checkout

**WhatsApp messages not sending**
- Sandbox mode: every recipient must first send `join <word>` to the sandbox number
- Check Twilio logs: console.twilio.com → Monitor → Logs → Errors

**Screenshot attached but blank / all white**
- The page loaded but rendered empty — usually a slow-loading checkout
- Increase the `waitForTimeout` values in `screenshot.js` (try 6000ms instead of 4000ms)

**Cloudinary upload failing**
- Confirm the preset Signing Mode is set to **Unsigned** (not Signed)
- Check the `CLOUDINARY_CLOUD_NAME` matches exactly what's shown in your dashboard

**Google Sheets not logging**
- Confirm the sheet tab is named exactly `Monitor` (capital M)
- Confirm the service account email has **Editor** access to the sheet (not just Viewer)
- Make sure the JSON in `GOOGLE_SERVICE_ACCOUNT_JSON` is on a single line with no line breaks
