import Anthropic from "@anthropic-ai/sdk"
import fs from "fs"

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const SYSTEM_PROMPT = `You are an automated QA bot that checks Shopify checkout pages for e-commerce stores selling research compounds.

You will receive a full screenshot of a checkout page.

Your job is to detect anything that would prevent a CUSTOMER from completing a purchase:
- Error messages or warnings visible to the shopper
- Broken or missing layout sections
- Missing or broken payment options (credit card fields, etc.)
- reCAPTCHA or bot-detection blocks
- Blank white sections where content should be
- "Cart is empty" or redirect pages (not a real checkout)
- Any JavaScript errors or broken UI components
- Age verification popups stuck open
- Spinner/loading states that never resolved

IGNORE (do NOT report these — they are internal to our monitor):
- Anything referring to draft orders, draft order invoices, or draft order IDs
- Admin-only messages, internal SKUs, or test line items
- The fact that the cart contains a monitor-generated test product
- Discount / invoice-link banners that are expected on draft-order checkouts
- Price being low or showing placeholder-like values

Reply with ONLY one of these two formats — nothing else:
OK
PROBLEM: [concise description of the issue in under 20 words]`

export async function analyzeCheckout(store, topPath, bottomPath) {
  const toBase64 = (path) => fs.readFileSync(path).toString("base64")
  const isSameFile = topPath === bottomPath

  const images = isSameFile
    ? [{ type: "image", source: { type: "base64", media_type: "image/png", data: toBase64(topPath) } }]
    : [
        { type: "image", source: { type: "base64", media_type: "image/png", data: toBase64(topPath) } },
        { type: "image", source: { type: "base64", media_type: "image/png", data: toBase64(bottomPath) } },
      ]

  const response = await client.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 100,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Store: ${store.name}\nCheckout URL: ${store.storeUrl}/checkout\n\nHere is the full page screenshot of the checkout:`,
          },
          ...images,
        ],
      },
    ],
  })

  const result = response.content[0].text.trim()
  const isOk = result.toUpperCase().startsWith("OK")

  return {
    isOk,
    result,
    detail: isOk ? "No issues were found. All good." : result.replace(/^PROBLEM:\s*/i, "").trim(),
  }
}
