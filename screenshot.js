import { chromium } from "playwright-extra"
import StealthPlugin from "puppeteer-extra-plugin-stealth"

chromium.use(StealthPlugin())

// Turn the bridge's non-redirect response into a human-readable reason.
// The bridge returns:
//   • 302 + Location header          → happy path, handled above
//   • 200/4xx body "Daily checkout limit reached..." → limiter hit
//   • 404 body "Not found"           → wrong endpoint / route removed
//   • 5xx body with Cloudflare "Error 1101 — Worker threw exception" HTML
//   • 503 during deploy / outage
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
// We try many because Shopify's checkout markup varies by version (classic vs
// Checkout Extensibility / One Page Checkout).
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

export async function captureCheckout(store) {
  let browser

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

    const page = await context.newPage()

    // Step 1 — Call the bridge to get a draft order invoice URL
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

    const invoiceUrl = bridgeRes.headers.get("location")

    if (!invoiceUrl) {
      const body = (await bridgeRes.text()).trim()
      return {
        success: false,
        bridgeStatus: bridgeRes.status,
        bridgeBody: body,
        error: classifyBridgeFailure(bridgeRes.status, body),
      }
    }

    console.log(`  → Invoice: ${invoiceUrl.substring(0, 70)}...`)

    // Step 2 — Navigate to the checkout
    await page.goto(invoiceUrl, { waitUntil: "domcontentloaded", timeout: 40000 })

    // Step 3 — Wait for the checkout shell to render (any of several selectors)
    await waitForAny(page, CHECKOUT_ROOT_SELECTORS, 20_000)

    // Step 4 — Scroll to the bottom so lazy-rendered payment iframes / summary are forced to render
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
    })

    // Step 5 — Wait for the payment section to actually exist
    await waitForAny(page, PAYMENT_SECTION_SELECTORS, 15_000)

    // Step 6 — Wait for the pay button (final piece of a rendered checkout)
    await waitForAny(page, PAY_BUTTON_SELECTORS, 10_000)

    // Step 7 — Wait for the network to settle so iframes finish loading
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {})

    // Step 8 — Final buffer for any last paint / iframe hydration
    await page.waitForTimeout(2500)

    const currentUrl = page.url()
    const timestamp = Date.now()
    const fullPath = `/tmp/${store.id}_${timestamp}_full.png`

    await page.screenshot({ path: fullPath, fullPage: true })

    return { topPath: fullPath, bottomPath: fullPath, pageUrl: currentUrl, success: true }
  } catch (err) {
    return { success: false, error: err.message }
  } finally {
    if (browser) await browser.close()
  }
}
