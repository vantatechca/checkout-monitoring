import twilio from "twilio"

const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN)

// Global alert numbers from env — comma-separated
// e.g. ALERT_WHATSAPP_NUMBERS="+19171234567,+16471234567,+63917123456"
const GLOBAL_NUMBERS = (process.env.ALERT_WHATSAPP_NUMBERS || "")
  .split(",")
  .map((n) => n.trim())
  .filter(Boolean)

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ""
const TELEGRAM_CHAT_IDS = (process.env.TELEGRAM_CHAT_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || ""

function getNumbers(store) {
  // Store can override with its own alertNumbers array
  return store?.alertNumbers?.length ? store.alertNumbers : GLOBAL_NUMBERS
}

// ─── WhatsApp ────────────────────────────────────────────────────────────────
async function sendWhatsApp(numbers, body, screenshotUrl) {
  if (!numbers.length) {
    console.warn("No alert numbers configured — skipping WhatsApp notification")
    return { ok: false, reason: "no_numbers" }
  }

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
      console.error(`✗ WhatsApp failed to ${numbers[i]}:`, result.reason?.message)
    } else {
      console.log(`✓ WhatsApp sent to ${numbers[i]} — SID: ${result.value.sid}`)
    }
  })

  return { ok: results.some((r) => r.status === "fulfilled") }
}

// ─── Telegram ────────────────────────────────────────────────────────────────
async function sendTelegram(body, screenshotUrl) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_IDS.length) {
    console.warn("Telegram not configured — skipping")
    return { ok: false, reason: "not_configured" }
  }

  const results = await Promise.allSettled(
    TELEGRAM_CHAT_IDS.map(async (chatId) => {
      if (screenshotUrl) {
        const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            photo: screenshotUrl,
            caption: body,
            parse_mode: "Markdown",
          }),
        })
        const data = await resp.json()
        if (!data.ok) throw new Error(data.description)
        return data
      }

      const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: body,
          parse_mode: "Markdown",
        }),
      })
      const data = await resp.json()
      if (!data.ok) throw new Error(data.description)
      return data
    })
  )

  results.forEach((result, i) => {
    if (result.status === "rejected") {
      console.error(`✗ Telegram failed to chat ${TELEGRAM_CHAT_IDS[i]}:`, result.reason?.message)
    } else {
      console.log(`✓ Telegram sent to chat ${TELEGRAM_CHAT_IDS[i]}`)
    }
  })

  return { ok: results.some((r) => r.status === "fulfilled") }
}

// ─── Discord ─────────────────────────────────────────────────────────────────
async function sendDiscord(body, screenshotUrl) {
  if (!DISCORD_WEBHOOK_URL) {
    console.warn("Discord not configured — skipping")
    return { ok: false, reason: "not_configured" }
  }

  try {
    // Discord content limit is 2000 chars — chunk if needed
    const chunks = []
    if (body.length > 1900) {
      let remaining = body
      while (remaining.length > 0) {
        chunks.push(remaining.slice(0, 1900))
        remaining = remaining.slice(1900)
      }
    } else {
      chunks.push(body)
    }

    for (let i = 0; i < chunks.length; i++) {
      const payload = {
        content: chunks[i],
        username: "Checkout Monitor",
      }

      // Attach screenshot as an embed on the first chunk only
      if (i === 0 && screenshotUrl) {
        payload.embeds = [{ image: { url: screenshotUrl } }]
      }

      const resp = await fetch(DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })

      if (!resp.ok && resp.status !== 204) {
        const text = await resp.text()
        console.error(`✗ Discord failed: ${resp.status} ${text}`)
        return { ok: false }
      }
    }

    console.log("✓ Discord alert sent")
    return { ok: true }
  } catch (e) {
    console.error("✗ Discord error:", e.message)
    return { ok: false }
  }
}

// ─── Fan-out helpers ─────────────────────────────────────────────────────────
async function fanOut(numbers, body, screenshotUrl) {
  const [whatsapp, telegram, discord] = await Promise.all([
    sendWhatsApp(numbers, body, screenshotUrl),
    sendTelegram(body, screenshotUrl),
    sendDiscord(body, screenshotUrl),
  ])
  const summary = { whatsapp: whatsapp.ok, telegram: telegram.ok, discord: discord.ok }
  console.log("📢 Alert delivery:", JSON.stringify(summary))
  return summary
}

// Heartbeat-style status: always sent each cycle, OK or not.
export async function sendStatus(store, { isOk, detail, screenshotUrl = null, pageUrl = null }) {
  const header = isOk ? `✅ *Checkout OK*` : `🚨 *Checkout Alert*`
  const statusLine = isOk
    ? `*Status:* No issues detected`
    : `*Issue:* ${detail || "Unknown problem"}`

  const body = [
    header,
    ``,
    `*Store:* ${store.name}`,
    statusLine,
    `*Checkout:* ${pageUrl || store.storeUrl + "/checkout"}`,
    `*Time:* ${new Date().toLocaleString("en-CA", { timeZone: "America/Toronto" })} ET`,
  ].join("\n")

  return fanOut(getNumbers(store), body, screenshotUrl)
}

// Kept for backwards compatibility — thin wrappers around sendStatus.
export async function sendAlert(store, problem, screenshotUrl = null, checkoutStore = null) {
  return sendStatus(store, { isOk: false, detail: problem, screenshotUrl, pageUrl: checkoutStore })
}

export async function sendRecoveryAlert(store) {
  return sendStatus(store, { isOk: true })
}

// Generic broadcast — used for digest/test alerts
export async function broadcast(message, screenshotUrl = null) {
  return fanOut(GLOBAL_NUMBERS, message, screenshotUrl)
}
