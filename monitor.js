import fs from "fs"
import { stores } from "./stores.js"
import { captureCheckout } from "./screenshot.js"
import { analyzeCheckout } from "./analyze.js"
import { uploadToCloudinary } from "./upload.js"
import { sendStatus, broadcast } from "./notify.js"
import { logToSheets, ensureSheetHeaders } from "./sheets.js"
import { getRouterStatus } from "./workerStatus.js"

function cleanup(...paths) {
  for (const p of paths) {
    try {
      if (p && fs.existsSync(p)) fs.unlinkSync(p)
    } catch {}
  }
}

async function checkStore(store) {
  console.log(`\n→ Checking: ${store.name}`)

  const outcome = { id: store.id, name: store.name, isOk: null, detail: null, alerted: false }
  let topPath, bottomPath

  try {
    const shot = await captureCheckout(store)

    if (!shot.success) {
      console.error(`  ✗ Screenshot failed: ${shot.error}`)
      outcome.isOk = false
      outcome.detail = `Could not load checkout: ${shot.error}`
      await sendStatus(store, { isOk: false, detail: outcome.detail })
      outcome.alerted = true
      await logToSheets(store, "ERROR", shot.error)
      return outcome
    }

    topPath = shot.topPath
    bottomPath = shot.bottomPath
    console.log(`  ✓ Screenshots captured`)

    const { isOk, result, detail } = await analyzeCheckout(store, topPath, bottomPath)
    console.log(`  ${isOk ? "✓ OK" : `✗ ${result}`}`)
    outcome.isOk = isOk
    outcome.detail = detail

    // Always upload screenshot so the heartbeat message has an image attached
    let screenshotUrl = null
    try {
      const publicId = `${store.id}_${Date.now()}_top`
      screenshotUrl = await uploadToCloudinary(topPath, publicId)
      console.log(`  ✓ Screenshot uploaded: ${screenshotUrl}`)
    } catch (e) {
      console.warn(`  ⚠ Screenshot upload failed: ${e.message}`)
    }
    outcome.screenshotUrl = screenshotUrl

    // Always fan out: OK → ✅ heartbeat, not OK → 🚨 alert. Both carry the screenshot.
    await sendStatus(store, { isOk, detail, screenshotUrl, pageUrl: shot.pageUrl })
    outcome.alerted = true

    await logToSheets(store, isOk ? "OK" : "PROBLEM", detail || "", screenshotUrl)

    return outcome
  } catch (err) {
    console.error(`  ✗ Unhandled error: ${err.message}`)
    outcome.isOk = false
    outcome.detail = err.message
    try {
      await sendStatus(store, { isOk: false, detail: err.message })
      outcome.alerted = true
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

  // Router status digest — sent to Telegram + Discord only (WhatsApp is costly
  // and these are routine informational updates, not urgent alerts).
  let router = null
  try {
    router = await getRouterStatus()
    if (router?.message) {
      await broadcast(router.message, null, ["telegram", "discord"])
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
