import http from "node:http"
import { runMonitor } from "./monitor.js"
import { broadcast } from "./notify.js"
import { clearCooldowns } from "./state.js"

const PORT = Number(process.env.PORT) || 3000
const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS) || 30 * 60 * 1000
const TRIGGER_TOKEN = process.env.TRIGGER_TOKEN || ""

// ─── Guard against overlapping runs ──────────────────────────────────────────
let running = null

async function safeRun({ force }) {
  if (running) {
    console.log("⏳ A check is already in progress — awaiting that run.")
    return running
  }
  running = runMonitor({ force }).finally(() => {
    running = null
  })
  return running
}

// ─── Token check for protected endpoints ─────────────────────────────────────
function authorized(url) {
  if (!TRIGGER_TOKEN) return true
  return url.searchParams.get("token") === TRIGGER_TOKEN
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(body, null, 2))
}

function text(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/plain" })
  res.end(body)
}

// ─── HTTP server ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const path = url.pathname

  try {
    if (path === "/" && req.method === "GET") {
      return text(
        res,
        200,
        [
          "Checkout Monitor",
          "",
          "Endpoints:",
          "  GET  /check         — run all checks now, return JSON (respects cooldown)",
          "  GET  /trigger       — run all checks AND force-send alerts (bypasses cooldown)",
          "  GET  /test-alert    — send a test alert to WhatsApp, Telegram, Discord",
          "  POST /clear-cooldowns — reset alert state",
          "",
          `Auto-runs every ${Math.round(CHECK_INTERVAL_MS / 60000)} min.`,
          TRIGGER_TOKEN ? "Protected endpoints require ?token=<TRIGGER_TOKEN>." : "",
        ].join("\n")
      )
    }

    if (path === "/check" && req.method === "GET") {
      if (!authorized(url)) return text(res, 401, "Unauthorized")
      const summary = await safeRun({ force: false })
      return json(res, 200, summary)
    }

    if (path === "/trigger" && req.method === "GET") {
      if (!authorized(url)) return text(res, 401, "Unauthorized")
      const summary = await safeRun({ force: true })
      return json(res, 200, summary)
    }

    if (path === "/test-alert" && req.method === "GET") {
      if (!authorized(url)) return text(res, 401, "Unauthorized")
      const msg = [
        "🧪 *Test Alert*",
        "",
        "If you see this on WhatsApp, Telegram, and Discord — alerts are working.",
        `_Sent ${new Date().toLocaleString("en-CA", { timeZone: "America/Toronto" })} ET_`,
      ].join("\n")
      const delivery = await broadcast(msg)
      return json(res, 200, { sent: true, delivery })
    }

    if (path === "/clear-cooldowns" && req.method === "POST") {
      if (!authorized(url)) return text(res, 401, "Unauthorized")
      clearCooldowns()
      return text(res, 200, "Cooldown state cleared")
    }

    return text(res, 404, "Not Found")
  } catch (err) {
    console.error("Request error:", err)
    return json(res, 500, { error: err.message })
  }
})

server.listen(PORT, () => {
  console.log(`🌐 Checkout Monitor listening on :${PORT}`)
  console.log(`⏱  Auto-check every ${Math.round(CHECK_INTERVAL_MS / 60000)} min`)

  // Fire one shortly after boot so Render health checks pass quickly
  // and you get a baseline run logged.
  setTimeout(() => {
    safeRun({ force: false }).catch((e) => console.error("Boot run failed:", e))
  }, 5_000)

  setInterval(() => {
    safeRun({ force: false }).catch((e) => console.error("Scheduled run failed:", e))
  }, CHECK_INTERVAL_MS)
})
