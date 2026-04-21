import { chromium } from "playwright-extra"
import StealthPlugin from "puppeteer-extra-plugin-stealth"

chromium.use(StealthPlugin())

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
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 900 },
      locale: "en-CA",
    })

    const page = await context.newPage()

    // Step 1 — Call the bridge to get a draft order invoice URL
    const bridgeRes = await fetch(store.bridgeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": store.storeUrl,
        "Referer": store.storeUrl + "/",
      },
      body: JSON.stringify(store.bridgePayload),
      redirect: "manual",
    })

    const invoiceUrl = bridgeRes.headers.get("location")

    if (!invoiceUrl) {
      const body = await bridgeRes.text()
      return {
        success: false,
        error: `Bridge returned no invoice URL. Status: ${bridgeRes.status}. Body: ${body.slice(0, 200)}`,
      }
    }

    console.log(`  → Invoice: ${invoiceUrl.substring(0, 70)}...`)

    // Step 2 — Navigate to the checkout invoice
await page.goto(invoiceUrl, { waitUntil: "domcontentloaded", timeout: 40000 })
await page.waitForTimeout(5000)

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
