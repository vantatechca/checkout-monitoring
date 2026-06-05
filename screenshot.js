import { chromium } from "playwright-extra"
import StealthPlugin from "puppeteer-extra-plugin-stealth"
import os from "os"
import path from "path"

chromium.use(StealthPlugin())

// Turn the bridge's non-redirect response into a human-readable reason.
function classifyBridgeFailure(status, body) {
  const text = (body || "").toLowerCase()

  if (text.includes("daily checkout limit reached") || text.includes("try again after midnight")) {
    return "Bridge daily checkout limit reached (resets at midnight EDT)"
  }
  if (text.includes("error 1101") || text.includes("worker threw exception")) {
    return `Bridge worker threw exception (Cloudflare Error 1101) — check Workers Logs`
  }
  if (text.includes("error 1102") || text.includes("worker exceeded cpu")) {
    return "Bridge worker hit CPU limit (Cloudflare Error 1102)"
  }
  if (status === 404 || text === "not found" || text.includes("not found")) {
    return "Bridge endpoint not found (404) — check bridgeUrl and worker route"
  }
  if (status === 429 || text.includes("rate limit")) {
    return "Bridge rate-limited (429)"
  }
  if (status === 503) {
    return "Bridge temporarily unavailable (503) — deploy in progress or outage"
  }
  if (status >= 500) {
    return `Bridge server error (${status}): ${body.slice(0, 160)}`
  }
  return `Bridge returned no invoice URL (${status}): ${body.slice(0, 200)}`
}

// Selectors that signal different parts of a Shopify checkout are rendered.
const CHECKOUT_ROOT_SELECTORS = [
  '[data-checkout-rendered="true"]',
  'form[action*="checkouts"]',
  '[data-testid="checkout"]',
  "#checkout-main",
  ".step__sections",
]

const PAYMENT_SECTION_SELECTORS = [
  '[data-payment-section]',
  '[data-testid="payment-section"]',
  'iframe[name^="card-fields"]',
  'iframe[src*="checkout.shopify.com"][src*="card"]',
  'iframe[src*="spreedly"]',
  'iframe[title*="card" i]',
  "#payment-method",
  ".payment-method",
]

const PAY_BUTTON_SELECTORS = [
  'button[type="submit"][name="button"]',
  'button#checkout-pay-button',
  'button[data-testid="pay-button"]',
  'button:has-text("Pay now")',
  'button:has-text("Complete order")',
  'button:has-text("Pay with")',
]

async function waitForAny(page, selectors, timeout) {
  return Promise.race(
    selectors.map((sel) =>
      page.waitForSelector(sel, { timeout, state: "attached" }).catch(() => null)
    )
  )
}

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

function buildLaunchOptions() {
  const opts = {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1280,900",
    ],
  }
  if (process.env.PROXY_SERVER) {
    opts.proxy = {
      server: process.env.PROXY_SERVER,
      username: process.env.PROXY_USER || undefined,
      password: process.env.PROXY_PASS || undefined,
    }
  }
  return opts
}

// Wait for a Shopify checkout to fully render: root → scroll to lazy-load every
// section → payment section → pay button → network idle. Best-effort throughout.
async function waitForCheckoutToRender(page) {
  await waitForAny(page, CHECKOUT_ROOT_SELECTORS, 20_000)

  await page
    .evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const height = document.body.scrollHeight
      let y = 0
      while (y < height) {
        y += 400
        window.scrollTo(0, y)
        await sleep(150)
      }
      window.scrollTo(0, document.body.scrollHeight)
      await sleep(500)
      window.scrollTo(0, 0)
    })
    .catch(() => {})

  await waitForAny(page, PAYMENT_SECTION_SELECTORS, 15_000)
  await waitForAny(page, PAY_BUTTON_SELECTORS, 10_000)
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {})
  await page.waitForTimeout(2500)
}

// Render a bridge-error reason as an HTML page so even when the bridge
// returned no invoice URL, we still produce a visual screenshot.
function bridgeErrorDataUrl(reason, body) {
  const safe = (s) => String(s || "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]))
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Bridge error</title><style>
body{font:16px/1.5 -apple-system,system-ui,monospace;padding:40px;color:#fff;background:#1a1823}
h1{color:#ff6b6b;font-size:22px;margin:0 0 12px}
pre{background:#0f0d16;border:1px solid #2a2635;padding:16px;border-radius:8px;white-space:pre-wrap;word-wrap:break-word;font-size:13px;color:#d8d3e8;max-height:400px;overflow:hidden}
small{color:#8f8aa0}
</style></head><body>
<h1>Bridge error</h1>
<p><strong>${safe(reason)}</strong></p>
<small>Raw body:</small>
<pre>${safe((body || "").slice(0, 1500))}</pre>
</body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

// A non-redirect bridge response can still be a SUCCESSFUL checkout. Some stores
// route through a hosted processor (e.g. Helcim Pay) that returns a JSON payload
// with a checkout token instead of 302-ing to a Shopify invoice URL. Detect those
// so the monitor doesn't false-alarm with "Bridge returned no invoice URL (200)".
// Returns a descriptor when recognised, or null to let classifyBridgeFailure run.
export function detectAltCheckout(status, body) {
  if (status < 200 || status >= 300) return null

  let data
  try {
    data = JSON.parse(body)
  } catch {
    return null
  }
  if (!data || typeof data !== "object" || data.error) return null

  // Helcim Pay hosted checkout — recognised by its explicit markers.
  const isHelcim =
    data.helcim_pay === true ||
    data.helcim_account_id != null ||
    data.helcim_worker_url != null
  if (isHelcim && (data.checkout_token || data.pending_id)) {
    const token = data.checkout_token || data.pending_id
    const amount =
      data.amount != null ? `${data.amount} ${data.currency || ""}`.trim() : null
    const parts = ["Helcim Pay checkout created"]
    if (token) parts.push(`token ${token}`)
    if (amount) parts.push(amount)
    return {
      processor: "helcim",
      detail: parts.join(" · "),
      token,
      amount: data.amount ?? null,
      currency: data.currency ?? null,
    }
  }

  return null
}

// Render a verified-OK hosted-processor checkout as a green confirmation page so
// we still produce a screenshot for the alert/Sheets even though there's no
// Shopify checkout to capture.
function altCheckoutDataUrl(alt) {
  const safe = (s) =>
    String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]))
  const rows = [
    ["Processor", alt.processor === "helcim" ? "Helcim Pay (hosted)" : alt.processor],
    ["Checkout token", alt.token],
    ["Amount", alt.amount != null ? `${alt.amount} ${alt.currency || ""}`.trim() : null],
  ]
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `<tr><th>${safe(k)}</th><td>${safe(v)}</td></tr>`)
    .join("")
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Checkout OK</title><style>
body{font:16px/1.5 -apple-system,system-ui,monospace;padding:40px;color:#fff;background:#141a16}
h1{color:#46d369;font-size:22px;margin:0 0 4px}
p{color:#8faf97;margin:0 0 20px}
table{border-collapse:collapse;background:#0d130f;border:1px solid #263528;border-radius:8px;overflow:hidden}
th,td{padding:10px 16px;text-align:left;font-size:14px;border-bottom:1px solid #1c281e}
th{color:#8faf97;font-weight:600}td{color:#e3f0e6}
</style></head><body>
<h1>✓ Checkout created</h1>
<p>Bridge returned a valid hosted-processor checkout (no Shopify invoice redirect).</p>
<table>${rows}</table>
</body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

async function captureBridgeCheckout(store) {
  let browser
  let page

  try {
    browser = await chromium.launch(buildLaunchOptions())

    const context = await browser.newContext({
      userAgent: BROWSER_UA,
      viewport: { width: 1280, height: 900 },
      locale: "en-CA",
    })

    page = await context.newPage()

    // Step 1 — Call the bridge to get a draft order invoice URL
    let invoiceUrl = null
    let bridgeStatus = null
    let bridgeBody = ""
    let bridgeError = null
    let altCheckout = null

    try {
      const bridgeHeaders = {
        "Content-Type": "application/json",
        Origin: store.storeUrl,
        Referer: store.storeUrl + "/",
      }
      // When MONITOR_SECRET is set, the bridge worker recognises this request
      // as a synthetic health probe and forces routing to Shopify stores only
      // (skipping Stripe/Whop rotations) so we always land on an invoice URL
      // that the visual checks can verify.
      if (process.env.MONITOR_SECRET) {
        bridgeHeaders["X-Monitor-Key"] = process.env.MONITOR_SECRET
      }

      const bridgeRes = await fetch(store.bridgeUrl, {
        method: "POST",
        headers: bridgeHeaders,
        body: JSON.stringify(store.bridgePayload),
        redirect: "manual",
      })
      bridgeStatus = bridgeRes.status
      invoiceUrl = bridgeRes.headers.get("location")
      if (!invoiceUrl) {
        bridgeBody = (await bridgeRes.text()).trim()
        // A 200 with a hosted-processor payload (Helcim Pay, etc.) is a SUCCESS,
        // not a failure — the bridge created a valid checkout, it just didn't
        // 302 to a Shopify invoice URL. Only fall through to an error otherwise.
        altCheckout = detectAltCheckout(bridgeRes.status, bridgeBody)
        if (!altCheckout) {
          bridgeError = classifyBridgeFailure(bridgeRes.status, bridgeBody)
        }
      }
    } catch (e) {
      bridgeError = `Bridge request failed: ${e.message}`
    }

    // Step 2 — Decide what URL to navigate to. Always navigate to SOMETHING so
    // we get a screenshot regardless of what went wrong upstream.
    let targetUrl
    if (invoiceUrl) {
      targetUrl = invoiceUrl
      console.log(`  → Invoice: ${invoiceUrl.substring(0, 70)}...`)
    } else if (altCheckout) {
      targetUrl = altCheckoutDataUrl(altCheckout)
      console.log(`  ✓ ${altCheckout.detail} (hosted processor — no Shopify redirect)`)
    } else {
      targetUrl = bridgeErrorDataUrl(bridgeError, bridgeBody)
      console.log(`  ⚠ Bridge error — rendering diagnostic page for screenshot: ${bridgeError}`)
    }

    try {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 40_000 })

      // Only run the "wait for Shopify checkout" choreography if we navigated
      // to a real invoice URL. For bridge-error data URLs, just a brief pause.
      if (invoiceUrl) {
        await waitForCheckoutToRender(page)
      } else {
        await page.waitForTimeout(500)
      }
    } catch (navErr) {
      // Navigation failed — keep going and try to screenshot whatever is on-page.
      console.warn("  ⚠ Navigation issue, still attempting screenshot:", navErr.message)
    }

    // Step 3 — Always extract visible text (for the text-check path in analyze.js).
    const pageText = await page
      .evaluate(() => document.body?.innerText || "")
      .catch(() => "")

    // Step 4 — Always screenshot whatever we ended up on.
    const currentUrl = page.url()
    const timestamp = Date.now()
    const fullPath = path.join(os.tmpdir(), `${store.id}_${timestamp}_full.png`)

    let screenshotOk = false
    try {
      await page.screenshot({ path: fullPath, fullPage: true })
      screenshotOk = true
    } catch (e) {
      console.error("  ✗ Screenshot failed:", e.message)
    }

    return {
      success: !bridgeError,
      altCheckout,
      error: bridgeError,
      topPath: screenshotOk ? fullPath : null,
      bottomPath: screenshotOk ? fullPath : null,
      pageUrl: currentUrl,
      pageText,
      bridgeStatus,
      bridgeBody: bridgeBody || null,
    }
  } catch (err) {
    return { success: false, error: err.message, pageText: "" }
  } finally {
    if (browser) await browser.close()
  }
}

// Pull the store's public products.json and return the first in-stock variant,
// so the checkout probe self-heals when a product sells out.
async function pickFirstAvailableVariant(storeUrl) {
  const res = await fetch(`${storeUrl}/products.json?limit=250`, {
    headers: { Accept: "application/json" },
  })
  if (!res.ok) throw new Error(`products.json HTTP ${res.status}`)
  const data = await res.json()
  const products = Array.isArray(data?.products) ? data.products : []
  for (const p of products) {
    for (const v of p.variants || []) {
      if (v.available !== false) {
        const variantTitle =
          v.title && v.title !== "Default Title" ? ` — ${v.title}` : ""
        return { variantId: String(v.id), title: `${p.title}${variantTitle}`, price: v.price }
      }
    }
  }
  throw new Error("No in-stock variant found in products.json")
}

// Dismiss a storefront age-verification overlay (common on these stores) so it
// doesn't intercept the checkout click. Best-effort; a no-op if none is present.
async function dismissAgeGate(page) {
  try {
    const yes = page
      .locator(
        '#ageVerifyYes, .age-verify-yes, button:has-text("Yes, I\'m 18"), button:has-text("I am 18"), button:has-text("Enter Site"), button:has-text("Agree")'
      )
      .first()
    if (await yes.count()) {
      await yes.click({ timeout: 6000 }).catch(() => {})
      await page.waitForTimeout(800)
      return
    }
  } catch {}
  // Fallback: strip any obvious age/overlay element that could block clicks.
  await page
    .evaluate(() => {
      for (const sel of ["#ageVerifyOverlay", ".age-verify-overlay", ".age-gate", ".age-gate-overlay"]) {
        document.querySelectorAll(sel).forEach((el) => el.remove())
      }
    })
    .catch(() => {})
}

// Wait for a checkout page to settle, whether it's Shopify-native or a custom
// hosted portal. Scrolls to lazy-load, waits for payment/place-order cues.
async function waitForAnyCheckoutToRender(page) {
  await page
    .waitForFunction(
      () => /place order|complete order|pay now|payment|e-transfer|checkout/i.test(document.body?.innerText || ""),
      { timeout: 15_000 }
    )
    .catch(() => {})
  await page
    .evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const height = document.body.scrollHeight
      let y = 0
      while (y < height) {
        y += 400
        window.scrollTo(0, y)
        await sleep(120)
      }
      window.scrollTo(0, 0)
    })
    .catch(() => {})
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {})
  await page.waitForTimeout(2500)
}

// Simulates a REAL customer checkout end-to-end: add a variant to the cart,
// dismiss the age gate, and click the storefront's own "Check out" button —
// then follow wherever it redirects (these stores route to a custom hosted
// checkout portal, NOT Shopify's native /checkout) and screenshot that page.
// No payment is submitted and no order is placed. "success" means we landed on
// a real checkout page; whether it's healthy is decided downstream by analyze.js.
async function captureStorefrontCheckout(store) {
  let browser
  try {
    browser = await chromium.launch(buildLaunchOptions())
    const context = await browser.newContext({
      userAgent: BROWSER_UA,
      viewport: { width: 1280, height: 900 },
      locale: "en-CA",
    })
    const page = await context.newPage()
    const storeUrl = store.storeUrl.replace(/\/+$/, "")

    // 1 — Resolve the variant: explicit override, else first in-stock product.
    let variantId = store.variantId ? String(store.variantId) : null
    let productLabel = null
    if (!variantId) {
      const picked = await pickFirstAvailableVariant(storeUrl)
      variantId = picked.variantId
      productLabel = picked.title
      console.log(`  → Probe product: ${picked.title} (variant ${variantId}, $${picked.price})`)
    }

    let captureError = null
    let cartUrl = null
    try {
      // 2 — Add the item to the cart (AJAX add keeps us on the storefront; the
      //     /cart/{id}:1 permalink would jump straight to Shopify's native
      //     checkout and bypass the store's real checkout button).
      await page.goto(`${storeUrl}/cart/add?id=${variantId}&quantity=1`, {
        waitUntil: "domcontentloaded",
        timeout: 40_000,
      })
      // 3 — Land on the cart page.
      await page.goto(`${storeUrl}/cart`, { waitUntil: "domcontentloaded", timeout: 40_000 })
      await page.waitForTimeout(1200)
      cartUrl = page.url()

      // 4 — Clear the age-verification gate that otherwise blocks the click.
      await dismissAgeGate(page)

      // 5 — Click the store's own checkout button and follow the redirect to
      //     whatever real checkout it routes to (custom portal or otherwise).
      const checkoutBtn = page
        .locator('button[name="checkout"]:visible, a[href*="checkout"]:visible')
        .first()
      if (await checkoutBtn.count()) {
        await checkoutBtn.click({ timeout: 15_000 }).catch((e) =>
          console.warn(`  ⚠ checkout click: ${e.message}`)
        )
      } else {
        await page.goto(`${storeUrl}/checkout`, { waitUntil: "domcontentloaded", timeout: 40_000 }).catch(() => {})
      }

      await page.waitForLoadState("networkidle", { timeout: 25_000 }).catch(() => {})
      await waitForAnyCheckoutToRender(page)
    } catch (navErr) {
      captureError = `Could not reach checkout: ${navErr.message}`
      console.warn(`  ⚠ ${captureError}`)
    }

    const currentUrl = page.url()
    // Still parked on the cart → the checkout button never proceeded. That's a
    // real customer-facing failure worth flagging.
    if (!captureError && cartUrl && currentUrl === cartUrl) {
      captureError = "Checkout did not proceed — still on the cart page"
      console.warn(`  ⚠ ${captureError}`)
    }
    if (!captureError) console.log(`  → Real checkout: ${currentUrl.slice(0, 90)}`)

    const pageText = await page.evaluate(() => document.body?.innerText || "").catch(() => "")

    const fullPath = path.join(os.tmpdir(), `${store.id}_${Date.now()}_full.png`)
    let screenshotOk = false
    try {
      await page.screenshot({ path: fullPath, fullPage: true })
      screenshotOk = true
    } catch (e) {
      console.error("  ✗ Screenshot failed:", e.message)
    }

    return {
      success: !captureError,
      error: captureError,
      via: captureError ? "checkout-error" : undefined,
      topPath: screenshotOk ? fullPath : null,
      bottomPath: screenshotOk ? fullPath : null,
      pageUrl: currentUrl,
      pageText,
      productLabel,
    }
  } catch (err) {
    return { success: false, error: err.message, via: "checkout-error", pageText: "" }
  } finally {
    if (browser) await browser.close()
  }
}

// Dispatch: stores configured for the storefront flow simulate the real customer
// checkout (add-to-cart → click "Check out" → follow redirect to the real
// checkout); everything else uses the bridge probe.
export async function captureCheckout(store) {
  if (store.checkout === "storefront" || (!store.bridgeUrl && store.storeUrl)) {
    return captureStorefrontCheckout(store)
  }
  return captureBridgeCheckout(store)
}
