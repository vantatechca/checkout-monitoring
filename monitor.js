import fs from "fs"
import { stores } from "./stores.js"
import { captureCheckout } from "./screenshot.js"
import { analyzeCheckout } from "./analyze.js"
import { uploadToCloudinary } from "./upload.js"
import { sendStatus, broadcast } from "./notify.js"
import { logToSheets, ensureSheetHeaders } from "./sheets.js"
import { getRouterStatus } from "./workerStatus.js"
import { shouldSendAlert, shouldSendRouterStatus } from "./state.js"

function cleanup(...paths) {
  for (const p of paths) {
    try {
      if (p && fs.existsSync(p)) fs.unlinkSync(p)
    } catch {}
  }
}

async function checkStore(store) {
  console.log(`\n→ Checking: ${store.name}`)

  const outcome = {
    id: store.id,
    name: store.name,
    isOk: null,
    detail: null,
    alerted: false,
    alertReason: null,
  }
  let topPath, bottomPath

  try {
    const shot = await captureCheckout(store)
    topPath = shot.topPath
    bottomPath = shot.bottomPath
    const pageText = shot.pageText || ""

    // If the bridge failed but we still got a diagnostic screenshot, treat the
    // bridge error as the PROBLEM detail and skip the Vision call.
    let isOk, detail, result, via

    if (!shot.success) {
      isOk = false
      detail = shot.error || "Unknown upstream error"
      result = `PROBLEM: ${detail}`
      via = "bridge-error"
      console.log(`  ✗ ${detail}`)
    } else {
      const analysis = await analyzeCheckout(store, topPath, bottomPath, pageText)
      isOk = analysis.isOk
      detail = analysis.detail
      result = analysis.result
      via = analysis.via
      console.log(`  ${isOk ? "✓ OK" : `✗ ${result}`} [via ${via}]`)
    }

    outcome.isOk = isOk
    outcome.detail = detail
    outcome.via = via

    // Always upload screenshot (even for bridge-error diagnostic pages) so
    // Telegram/WhatsApp/Discord have an image to attach.
    let screenshotUrl = null
    if (topPath) {
      try {
        const publicId = `${store.id}_${Date.now()}`
        screenshotUrl = await uploadToCloudinary(topPath, publicId)
        console.log(`  ✓ Screenshot uploaded: ${screenshotUrl}`)
      } catch (e) {
        console.warn(`  ⚠ Screenshot upload failed: ${e.message}`)
      }
    }
    outcome.screenshotUrl = screenshotUrl

    // Decide whether this cycle should actually fire an alert:
    //   - any PROBLEM: always send
    //   - recovery (broken → OK): always send
    //   - steady OK: only every OK_ALERT_INTERVAL_MS (default 2h)
    const { send, reason } = shouldSendAlert(store.id, isOk)
    outcome.alertReason = reason

    if (send) {
      await sendStatus(store, { isOk, detail, screenshotUrl, pageUrl: shot.pageUrl })
      outcome.alerted = true
    } else {
      console.log(`  ⏳ Skipping OK heartbeat (throttled — last alert < 2h ago)`)
    }

    const sheetTag = isOk
      ? reason === "recovery"
        ? "RECOVERED"
        : "OK"
      : via === "bridge-error"
        ? "BRIDGE ERROR"
        : "PROBLEM"
    await logToSheets(store, sheetTag, detail || "", screenshotUrl)

    return outcome
  } catch (err) {
    console.error(`  ✗ Unhandled error: ${err.message}`)
    outcome.isOk = false
    outcome.detail = err.message
    try {
      const { send } = shouldSendAlert(store.id, false)
      if (send) {
        await sendStatus(store, { isOk: false, detail: err.message })
        outcome.alerted = true
      }
    } catch {}
    await logToSheets(store, "CRASH", err.message)
    return outcome
  } finally {
    cleanup(topPath, bottomPath)
  }
}

export async function runMonitor() {
  console.log(`\n${"=".repeat(50)}`)
  console.log(`Checkout Monitor — ${new Date().toISOString()}`)
  console.log(`Checking ${stores.length} store(s)`)
  console.log("=".repeat(50))

  await ensureSheetHeaders()

  const results = []
  for (const store of stores) {
    const outcome = await checkStore(store)
    results.push(outcome)

    // Stagger between stores to avoid triggering bot detection
    if (stores.indexOf(store) < stores.length - 1) {
      await new Promise((r) => setTimeout(r, 8000))
    }
  }

  // Router status digest — throttled to every ROUTER_STATUS_INTERVAL_MS
  // (default 4h). Sent to Telegram + Discord only (routine informational).
  let router = null
  const routerDecision = shouldSendRouterStatus()
  try {
    router = await getRouterStatus()
    if (router?.message && routerDecision.send) {
      await broadcast(router.message, null, ["telegram", "discord"])
      console.log(`📊 Router status broadcast (${routerDecision.reason})`)
    } else if (router?.message) {
      console.log(`⏳ Router status ready but throttled — next digest in <= 4h`)
    }
  } catch (e) {
    console.error("Router status broadcast failed:", e.message)
  }

  const summary = {
    checked_at: new Date().toISOString(),
    total: results.length,
    healthy: results.filter((r) => r.isOk).length,
    issues: results.filter((r) => r.isOk === false).length,
    alerted: results.filter((r) => r.alerted).length,
    stores: results,
    router: router?.data || null,
  }

  console.log(`\n${"=".repeat(50)}`)
  console.log(`Monitor run complete — ${summary.healthy}/${summary.total} healthy, ${summary.alerted} message(s) sent.`)
  console.log("=".repeat(50))

  return summary
}

// Run a single store by ID (for testing)
export async function runSingle(storeId) {
  const store = stores.find((s) => s.id === storeId)
  if (!store) {
    throw new Error(`Store not found: ${storeId}`)
  }
  await ensureSheetHeaders()
  return checkStore(store)
}
