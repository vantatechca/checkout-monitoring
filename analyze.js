import Anthropic from "@anthropic-ai/sdk"
import fs from "fs"

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const SYSTEM_PROMPT = `You are an automated QA bot that checks Shopify checkout pages for e-commerce stores selling research compounds.

You will receive a full screenshot of a checkout page.

Your job is to detect anything that would prevent a CUSTOMER from completing a purchase.

READ ALL VISIBLE TEXT carefully. Flag as PROBLEM if you see any of the following — case-insensitive, partial matches count:

Payment / gateway failures:
- "No available payment gateways" / "no payment methods" / "payment unavailable"
- "Cannot process payment" / "payment failed" / "unable to process"
- Missing or empty credit card / card number / CVV / expiry fields
- Missing Shop Pay, Apple Pay, Google Pay, PayPal, or generic credit-card option where one should be

Store-level failures:
- "404" / "Page not found" / "This page doesn't exist"
- "Store is suspended" / "Store unavailable" / "This shop is unavailable"
- "This store is temporarily unavailable" / "currently unavailable" / "closed"
- "Coming soon" / "Password protected" / "Enter password"
- "Account locked" / "Access denied" / "Forbidden" / "401" / "403" / "423" / "500" / "502" / "503"
- "Something went wrong" / "An error occurred" / "Sorry, we couldn't ..." / "Oops"
- "We'll be back soon" / "Under maintenance" / "Service unavailable"

Checkout-flow failures:
- "Cart is empty" / "Your cart is empty" / "No items in your cart"
- Redirect to home / cart / product page instead of an actual checkout form
- "This order cannot be completed" / "Order could not be processed"
- "Shipping is not available" / "We don't ship to this location" (when it should be available)
- "Out of stock" / "Sold out" blocking the only line item
- "Invalid" / "Error" / "Failed" text prominently displayed near any form field

Bot-detection / verification:
- reCAPTCHA challenge stuck on screen
- Cloudflare "Checking your browser" / "Just a moment" / "Verify you are human"
- Age verification popup blocking the page

Visual / rendering failures:
- Blank white sections where checkout content should be
- Spinner / skeleton / "Loading..." state that never resolved
- Broken / missing images for logo, product, or payment provider icons
- JavaScript error overlays
- Layout completely broken (overlapping text, cut-off buttons, unstyled content)

Anything else that a regular shopper would look at and think "this is broken" or "I can't buy here."

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
