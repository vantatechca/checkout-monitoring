import { chromium } from "playwright-extra"
import StealthPlugin from "puppeteer-extra-plugin-stealth"

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

export async function captureCheckout(store) {
  let browser
  let page

  try {
    const launchOptions = {
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
      launchOptions.proxy = {
        server: process.env.PROXY_SERVER,
        username: process.env.PROXY_USER || undefined,
        password: process.env.PROXY_PASS || undefined,
      }
    }

    browser = await chromium.launch(launchOptions)

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 900 },
      locale: "en-CA",
    })

    page = await context.newPage()

    // Step 1 — Call the bridge to get a draft order invoice URL
    let invoiceUrl = null
    let bridgeStatus = null
    let bridgeBody = ""
    let bridgeError = null

    try {
      const bridgeRes = await fetch(store.bridgeUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: store.storeUrl,
          Referer: store.storeUrl + "/",
        },
        body: JSON.stringify(store.bridgePayload),
        redirect: "manual",
      })
      bridgeStatus = bridgeRes.status
      invoiceUrl = bridgeRes.headers.get("location")
      if (!invoiceUrl) {
        bridgeBody = (await bridgeRes.text()).trim()
        bridgeError = classifyBridgeFailure(bridgeRes.status, bridgeBody)
      }
    } catch (e) {
      bridgeError = `Bridge request failed: ${e.message}`
    }

    // Step 2 — Decide what URL to navigate to. Always navigate to SOMETHING so
    // we get a screenshot regardless of what went wrong upstream.
    const targetUrl = invoiceUrl || bridgeErrorDataUrl(bridgeError, bridgeBody)
    if (invoiceUrl) {
      console.log(`  → Invoice: ${invoiceUrl.substring(0, 70)}...`)
    } else {
      console.log(`  ⚠ Bridge error — rendering diagnostic page for screenshot: ${bridgeError}`)
    }

    try {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 40_000 })

      // Only run the "wait for Shopify checkout" choreography if we navigated
      // to a real invoice URL. For bridge-error data URLs, just a brief pause.
      if (invoiceUrl) {
        await waitForAny(page, CHECKOUT_ROOT_SELECTORS, 20_000)

        await page.evaluate(async () => {
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
        }).catch(() => {})

        await waitForAny(page, PAYMENT_SECTION_SELECTORS, 15_000)
        await waitForAny(page, PAY_BUTTON_SELECTORS, 10_000)
        await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {})
        await page.waitForTimeout(2500)
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
    const fullPath = `/tmp/${store.id}_${timestamp}_full.png`

    let screenshotOk = false
    try {
      await page.screenshot({ path: fullPath, fullPage: true })
      screenshotOk = true
    } catch (e) {
      console.error("  ✗ Screenshot failed:", e.message)
    }

    return {
      success: !bridgeError,
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
