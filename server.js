import http from "node:http"
import { runMonitor } from "./monitor.js"
import { broadcast } from "./notify.js"
import { getRouterStatus } from "./workerStatus.js"

const PORT = Number(process.env.PORT) || 3000
const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS) || 30 * 60 * 1000
const TRIGGER_TOKEN = process.env.TRIGGER_TOKEN || ""
// Optional shared secret the bridge worker sends in X-Alert-Secret so random
// internet traffic can't spam /alert. Leave unset during early testing.
const BRIDGE_ALERT_SECRET = process.env.BRIDGE_ALERT_SECRET || ""

// ─── Guard against overlapping runs ──────────────────────────────────────────
let running = null

async function safeRun({ force = false } = {}) {
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

// Read and JSON-parse a request body. Caps at 1MB to avoid abuse.
async function readJson(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > 1_000_000) throw new Error("Body too large")
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString("utf8")
  if (!raw) return {}
  return JSON.parse(raw)
}

// Format an inbound alert from the bridge worker into a human message.
function formatBridgeAlert(alert) {
  if (!alert || typeof alert !== "object") return null

  if (alert.type === "limit_exceeded") {
    return [
      `⚠️ *LIMIT EXCEEDED*`,
      `*Store:* ${alert.store || "unknown"}`,
      `*Volume:* $${alert.volume ?? "?"} / $${alert.limit ?? "?"}`,
      alert.source ? `*Source:* ${alert.source}` : null,
      `Still accepting orders.`,
    ]
      .filter(Boolean)
      .join("\n")
  }

  if (alert.type === "checkout_error") {
    return [
      `🚨 *CHECKOUT ERROR*`,
      `*Store:* ${alert.store || "unknown"}${alert.shop ? ` (${alert.shop})` : ""}`,
      alert.error_code ? `*Code:* ${alert.error_code}` : null,
      alert.error_detail ? `*Detail:* ${alert.error_detail}` : null,
      alert.source ? `*Source:* ${alert.source}` : null,
    ]
      .filter(Boolean)
      .join("\n")
  }

  if (alert.type === "worker_exception") {
    return [
      `🔥 *WORKER EXCEPTION*`,
      alert.worker ? `*Worker:* ${alert.worker}` : null,
      alert.error_code ? `*Code:* ${alert.error_code}` : null,
      alert.error_detail ? `*Detail:* ${alert.error_detail}` : null,
      alert.ray_id ? `*Ray ID:* ${alert.ray_id}` : null,
    ]
      .filter(Boolean)
      .join("\n")
  }

  if (alert.type === "volume_reset") {
    // Flatten the stores list. The bridge sometimes wraps it as [[...]] when
    // using stores.map() directly inside an array literal — handle both.
    let storeList = "(none)"
    if (Array.isArray(alert.stores)) {
      const flat = alert.stores.flat ? alert.stores.flat(Infinity) : [].concat(...alert.stores)
      if (flat.length) storeList = flat.join(", ")
    }

    // If the worker sent a custom 'message' string, use it as the body.
    // Otherwise fall back to the default copy.
    const body = alert.message
      ? alert.message
      : [
          `All store volumes cleared to $0.`,
          `Card payments are now active.`,
        ].join("\n")

    return [
      `🔄 *MIDNIGHT RESET*`,
      body,
      `*Stores:* ${storeList}`,
    ].join("\n")
  }

  // Fallback — dump the object so we can see what came in
  return [`ℹ️ *BRIDGE ALERT* (\`${alert.type || "unknown"}\`)`, "```", JSON.stringify(alert, null, 2).slice(0, 1500), "```"].join(
    "\n"
  )
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
          "  GET  /check         — run all checks now, respect throttle (like the 30-min scheduled cycle)",
          "  GET  /trigger       — force-run + force-send: bypasses 2h OK + 4h router throttles",
          "  GET  /test-alert    — send a test message to WhatsApp, Telegram, Discord",
          "  GET  /router-status — fetch bridge router status and broadcast to Telegram + Discord",
          "  POST /alert         — inbound alerts from the bridge Cloudflare Worker",
          "",
          `Auto-runs every ${Math.round(CHECK_INTERVAL_MS / 60000)} min.`,
          `Every run: per-store screenshot + alert (OK every 2h, PROBLEM every 30min).`,
          `Router status digest broadcasts every 4h (or on demand via /router-status).`,
          TRIGGER_TOKEN ? "Protected endpoints require ?token=<TRIGGER_TOKEN>." : "",
          BRIDGE_ALERT_SECRET ? "POST /alert requires X-Alert-Secret header." : "",
        ].join("\n")
      )
    }

    // /check — runs a cycle respecting throttles (matches the 30-min behavior)
    if (path === "/check" && req.method === "GET") {
      if (!authorized(url)) return text(res, 401, "Unauthorized")
      const summary = await safeRun({ force: false })
      return json(res, 200, summary)
    }

    // /trigger — runs a cycle and forces sends, bypassing the 2h OK throttle
    // and 4h router-status throttle. Use this for manual testing.
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

    if (path === "/router-status" && req.method === "GET") {
      if (!authorized(url)) return text(res, 401, "Unauthorized")
      const status = await getRouterStatus()
      if (status.message) {
        await broadcast(status.message, null, ["telegram", "discord"])
      }
      return json(res, 200, status)
    }

    // Inbound alerts pushed by the bridge Cloudflare Worker.
    // Bridge should POST JSON like:
    //   { type: "limit_exceeded", store, volume, limit, source }
    //   { type: "checkout_error", store, shop, error_code, error_detail, source }
    //   { type: "worker_exception", worker, error_code, error_detail, ray_id }
    // and include header X-Alert-Secret: <BRIDGE_ALERT_SECRET> if configured.
    if (path === "/alert" && req.method === "POST") {
      if (BRIDGE_ALERT_SECRET && req.headers["x-alert-secret"] !== BRIDGE_ALERT_SECRET) {
        return text(res, 401, "Unauthorized")
      }
      let alert
      try {
        alert = await readJson(req)
      } catch (e) {
        return json(res, 400, { error: "Invalid JSON", detail: e.message })
      }
      const message = formatBridgeAlert(alert)
      if (!message) return json(res, 400, { error: "Empty or unrecognized alert body" })

      const delivery = await broadcast(message, null, ["telegram", "discord"])
      return json(res, 200, { received: true, delivery })
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
    safeRun().catch((e) => console.error("Boot run failed:", e))
  }, 5_000)

  setInterval(() => {
    safeRun().catch((e) => console.error("Scheduled run failed:", e))
  }, CHECK_INTERVAL_MS)
})
