import twilio from "twilio"

const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN)

// Global alert numbers from env — comma-separated
// e.g. ALERT_WHATSAPP_NUMBERS="+19171234567,+16471234567,+63917123456"
const GLOBAL_NUMBERS = (process.env.ALERT_WHATSAPP_NUMBERS || "")
  .split(",")
  .map((n) => n.trim())
  .filter(Boolean)

function getNumbers(store) {
  // Store can override with its own alertNumbers array
  return store.alertNumbers?.length ? store.alertNumbers : GLOBAL_NUMBERS
}

export async function sendAlert(store, problem, screenshotUrl = null, checkoutStore = null) {
  const numbers = getNumbers(store)

  if (!numbers.length) {
    console.warn("No alert numbers configured — skipping WhatsApp notification")
    return
  }

  const body = [
    `🚨 *Checkout Monitor Alert*`,
    ``,
    `*Store:* ${store.name}`,
    `*Issue:* ${problem}`,
    `*Checkout:* ${checkoutStore || store.storeUrl + "/checkout"}`,
    `*Time:* ${new Date().toLocaleString("en-CA", { timeZone: "America/Toronto" })} ET`,
  ].join("\n")

  const messageOptions = {
    from: `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`,
    body,
    ...(screenshotUrl ? { mediaUrl: [screenshotUrl] } : {}),
  }

  const results = await Promise.allSettled(
    numbers.map((number) =>
      client.messages.create({
        ...messageOptions,
        to: `whatsapp:${number}`,
      })
    )
  )

  results.forEach((result, i) => {
    if (result.status === "rejected") {
      console.error(`Failed to send WhatsApp alert to ${numbers[i]}:`, result.reason?.message)
    } else {
      console.log(`Alert sent to ${numbers[i]} — SID: ${result.value.sid}`)
    }
  })
}

export async function sendRecoveryAlert(store) {
  const numbers = getNumbers(store)

  if (!numbers.length) return

  const body = [
    `✅ *Checkout Recovered*`,
    ``,
    `*Store:* ${store.name}`,
    `*Status:* Checkout is back to normal`,
    `*Time:* ${new Date().toLocaleString("en-CA", { timeZone: "America/Toronto" })} ET`,
  ].join("\n")

  await Promise.allSettled(
    numbers.map((number) =>
      client.messages.create({
        from: `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`,
        to: `whatsapp:${number}`,
        body,
      })
    )
  )
}
