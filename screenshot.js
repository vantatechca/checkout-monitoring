import { chromium } from "playwright-extra"
import StealthPlugin from "puppeteer-extra-plugin-stealth"

chromium.use(StealthPlugin())

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
      const body = await bridgeRes.text()
      return {
        success: false,
        error: `Bridge returned no invoice URL. Status: ${bridgeRes.status}. Body: ${body.slice(
          0,
          200
        )}`,
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
