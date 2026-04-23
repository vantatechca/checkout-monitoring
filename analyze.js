import Anthropic from "@anthropic-ai/sdk"
import fs from "fs"
import path from "path"

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ─── Reference examples ──────────────────────────────────────────────────────
// Drop PNG/JPG files into examples/ok/ and examples/problem/ — they're loaded
// on boot and attached to every Vision call as few-shot context.

const EXAMPLES_DIR = path.join(process.cwd(), "examples")

function loadExamples(dir) {
  try {
    if (!fs.existsSync(dir)) return []
    return fs
      .readdirSync(dir)
      .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
      .map((f) => {
        const full = path.join(dir, f)
        const ext = f.toLowerCase().split(".").pop()
        const mediaType =
          ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg"
        return { name: f, base64: fs.readFileSync(full).toString("base64"), mediaType }
      })
  } catch (e) {
    console.error("Failed to load examples from", dir, ":", e.message)
    return []
  }
}

const okExamples = loadExamples(path.join(EXAMPLES_DIR, "ok"))
const problemExamples = loadExamples(path.join(EXAMPLES_DIR, "problem"))

console.log(
  `📚 Reference examples loaded: ${okExamples.length} OK, ${problemExamples.length} PROBLEM`
)

// ─── Fast text-based pre-check ───────────────────────────────────────────────
// If the live page's visible text matches any of these patterns we short-circuit
// to PROBLEM without even calling Vision. Catches obvious failures for free.

const FAILURE_PATTERNS = [
  { re: /\bpage\s+not\s+found\b/i, tag: "Page not found" },
  { re: /\b404\b[^\n]{0,40}(not\s+found|page)/i, tag: "404 Not Found" },
  { re: /\bstore\s+(is\s+)?(unavailable|suspended|locked)\b/i, tag: "Store unavailable/suspended" },
  { re: /\bthis\s+shop\s+is\s+unavailable\b/i, tag: "Shop unavailable" },
  { re: /\btemporarily\s+unavailable\b/i, tag: "Temporarily unavailable" },
  { re: /\bpassword\s+protected\b/i, tag: "Password protected" },
  { re: /\benter\s+password\b/i, tag: "Password page blocking access" },
  { re: /\byour\s+cart\s+is\s+empty\b/i, tag: "Cart is empty" },
  { re: /\bdaily\s+checkout\s+limit\s+reached\b/i, tag: "Bridge daily checkout limit reached" },
  { re: /\bcheckout\s+(is\s+)?unavailable\b/i, tag: "Checkout unavailable" },
  { re: /\bno\s+(available\s+)?payment\s+(methods|gateways)\b/i, tag: "No payment methods available" },
  { re: /\bchecking\s+your\s+browser\b/i, tag: "Cloudflare bot challenge" },
  { re: /\bverify\s+you\s+are\s+human\b/i, tag: "Bot verification blocking" },
  { re: /\bsomething\s+went\s+wrong\b/i, tag: "Generic error ('Something went wrong')" },
  { re: /\bworker\s+threw\s+exception\b/i, tag: "Cloudflare Error 1101 — worker threw exception" },
  { re: /\berror\s+1101\b/i, tag: "Cloudflare Error 1101" },
  { re: /\bservice\s+unavailable\b/i, tag: "Service unavailable (503)" },
  { re: /\bbad\s+gateway\b/i, tag: "Bad gateway (502)" },
  { re: /\bunable\s+to\s+process\s+(your\s+)?(payment|request)\b/i, tag: "Unable to process payment/request" },
  { re: /\border\s+cannot\s+be\s+(completed|processed)\b/i, tag: "Order cannot be completed" },
  { re: /\bwe'?re\s+sorry,?\s+but\s+something\s+went\s+wrong\b/i, tag: "'Sorry, something went wrong'" },
]

export function quickTextCheck(pageText) {
  if (!pageText) return null
  for (const { re, tag } of FAILURE_PATTERNS) {
    const match = pageText.match(re)
    if (match) return { isOk: false, detail: tag, matchedText: match[0] }
  }
  return null
}

// ─── System prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an automated QA bot that inspects Shopify checkout screenshots for e-commerce stores selling research compounds.

Your mindset: you are a real shopper who wants to buy something. If anything would make you hesitate, give up, or think "this store is broken" — flag it.

═══════════════════════════════════════════════════════════════════════
INPUTS YOU WILL RECEIVE
═══════════════════════════════════════════════════════════════════════
You will receive, in order:
  1. Zero or more HEALTHY reference screenshots (labeled below). These show
     what a working checkout looks like for these stores.
  2. Zero or more BROKEN reference screenshots. These show failures we have
     seen before — bridge errors, store-suspended pages, payment-section
     empty, bot challenges, etc.
  3. The LIVE screenshot to classify.
  4. Optionally, a text snippet of the visible text on the live page.

Compare the live screenshot against the reference sets. If the live page
looks visually similar to any BROKEN reference, or matches the failure
criteria below, return PROBLEM. Use the HEALTHY references as your anchor
for what "normal" looks like.

═══════════════════════════════════════════════════════════════════════
WHAT A HEALTHY CHECKOUT LOOKS LIKE
═══════════════════════════════════════════════════════════════════════
LEFT column (top → bottom): Contact (email) → Delivery (address) →
Shipping method → Payment (card fields OR Shop Pay/Apple Pay/PayPal
buttons, fully rendered) → Billing → Pay-now button.
RIGHT column: Order summary with currency symbol + totals.

═══════════════════════════════════════════════════════════════════════
WHAT A BROKEN CHECKOUT LOOKS LIKE — CRITERIA
═══════════════════════════════════════════════════════════════════════
- Payment section empty, spinner, or skeleton placeholder
- "No payment methods available" / "payment unavailable" text
- "Store unavailable" / "suspended" / "404" / "password protected" / "coming soon" / "maintenance"
- Cloudflare "Error 1101 — Worker threw exception" page
- Bridge "Daily checkout limit reached" plain-text response
- "Cart is empty" or redirected to home/product page instead of checkout
- reCAPTCHA or Cloudflare "Checking your browser" or age-gate stuck on screen
- Red/yellow error banner with "something went wrong", "sorry", "invalid", etc.
- Broken layout (overlapping text, unstyled content, cut-off buttons)
- Multiple sections still showing skeleton/loading bars
- Broken/missing images for logo, product, or payment provider icons

Bias: if in doubt, flag PROBLEM. A false alarm is cheap; a missed outage is expensive.

═══════════════════════════════════════════════════════════════════════
IGNORE (internal to our monitor, don't report)
═══════════════════════════════════════════════════════════════════════
- Draft order IDs, invoice-link banners, test line items in the cart
- Placeholder / zero / low prices
- The specific product in the cart not matching the store's usual catalog

═══════════════════════════════════════════════════════════════════════
OUTPUT
═══════════════════════════════════════════════════════════════════════
Reply with EXACTLY one line — no preamble, no explanation:

  OK

  PROBLEM: <under 20 words, name the region and what's wrong>`

// ─── Main analyzer ───────────────────────────────────────────────────────────

export async function analyzeCheckout(store, topPath, bottomPath, pageText = "") {
  // 1. Fast text check first — obvious failures never reach Vision.
  const textResult = quickTextCheck(pageText)
  if (textResult) {
    console.log(`  🔍 Text check fired: ${textResult.detail}`)
    return {
      isOk: false,
      result: `PROBLEM: ${textResult.detail}`,
      detail: textResult.detail,
      via: "text-check",
    }
  }

  // 2. Vision check with few-shot references.
  if (!topPath) {
    // No screenshot available — can't run Vision. Treat as PROBLEM with the
    // upstream error text if the caller passed one via pageText.
    return {
      isOk: false,
      result: "PROBLEM: no screenshot available",
      detail: "No screenshot available from this cycle",
      via: "no-screenshot",
    }
  }

  const toBase64 = (p) => fs.readFileSync(p).toString("base64")
  const isSameFile = topPath === bottomPath
  const livePngs = isSameFile ? [toBase64(topPath)] : [toBase64(topPath), toBase64(bottomPath)]

  const content = []

  content.push({
    type: "text",
    text: `Store: ${store.name}\nCheckout URL: ${store.storeUrl}/checkout`,
  })

  if (okExamples.length) {
    content.push({
      type: "text",
      text: `────────────────────────────────────────────\nHEALTHY reference examples (${okExamples.length}) — these are what working checkouts look like:`,
    })
    for (const ex of okExamples) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: ex.mediaType, data: ex.base64 },
      })
    }
  }

  if (problemExamples.length) {
    content.push({
      type: "text",
      text: `────────────────────────────────────────────\nBROKEN reference examples (${problemExamples.length}) — these are failures we have seen before:`,
    })
    for (const ex of problemExamples) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: ex.mediaType, data: ex.base64 },
      })
    }
  }

  content.push({
    type: "text",
    text: `────────────────────────────────────────────\nLIVE screenshot to classify:`,
  })
  for (const img of livePngs) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: img },
    })
  }

  if (pageText) {
    const snippet = pageText.replace(/\s+/g, " ").trim().slice(0, 1500)
    content.push({
      type: "text",
      text: `Visible text extracted from the live page (use to disambiguate):\n---\n${snippet}\n---\n\nNow classify the LIVE screenshot as OK or PROBLEM.`,
    })
  } else {
    content.push({
      type: "text",
      text: `Now classify the LIVE screenshot as OK or PROBLEM.`,
    })
  }

  const response = await client.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 120,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
  })

  const result = response.content[0].text.trim()
  const isOk = result.toUpperCase().startsWith("OK")

  return {
    isOk,
    result,
    detail: isOk ? "No issues were found. All good." : result.replace(/^PROBLEM:\s*/i, "").trim(),
    via: "vision",
  }
}
