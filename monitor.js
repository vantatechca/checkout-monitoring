import fs from "fs"
import { stores } from "./stores.js"
import { captureCheckout } from "./screenshot.js"
import { analyzeCheckout } from "./analyze.js"
import { uploadToCloudinary } from "./upload.js"
import { sendAlert, sendRecoveryAlert } from "./notify.js"
import { logToSheets, ensureSheetHeaders } from "./sheets.js"
import { shouldAlert } from "./state.js"

function cleanup(...paths) {
  for (const p of paths) {
    try {
      if (p && fs.existsSync(p)) fs.unlinkSync(p)
    } catch {}
  }
}

async function checkStore(store, { force = false } = {}) {
  console.log(`\n→ Checking: ${store.name}`)

  const outcome = { id: store.id, name: store.name, isOk: null, detail: null, alerted: false }
  let topPath, bottomPath

  try {
    // 1. Screenshot the checkout
    const shot = await captureCheckout(store)

    if (!shot.success) {
      console.error(`  ✗ Screenshot failed: ${shot.error}`)
      outcome.isOk = false
      outcome.detail = `Could not load checkout: ${shot.error}`
      const decision = shouldAlert(store.id, false, { force })
      if (decision.willAlert) {
        await sendAlert(store, outcome.detail)
        outcome.alerted = true
      }
      await logToSheets(store, "ERROR", shot.error)
      return outcome
    }

    topPath = shot.topPath
    bottomPath = shot.bottomPath
    console.log(`  ✓ Screenshots captured`)

    // 2. Analyze with Claude Vision
    const { isOk, result, detail } = await analyzeCheckout(store, topPath, bottomPath)
    console.log(`  ${isOk ? "✓ OK" : `✗ ${result}`}`)
    outcome.isOk = isOk
    outcome.detail = detail

    const decision = shouldAlert(store.id, isOk, { force })

    if (!isOk && decision.willAlert) {
      // 3. Upload screenshot to Cloudinary
      let screenshotUrl = null
      try {
        const publicId = `${store.id}_${Date.now()}_top`
        screenshotUrl = await uploadToCloudinary(topPath, publicId)
        console.log(`  ✓ Screenshot uploaded: ${screenshotUrl}`)
      } catch (e) {
        console.warn(`  ⚠ Screenshot upload failed: ${e.message}`)
      }

      // 4. Fan out to WhatsApp + Telegram + Discord
      await sendAlert(store, detail, screenshotUrl, shot.pageUrl)
      outcome.alerted = true
      outcome.screenshotUrl = screenshotUrl

      const tag = decision.isNewProblem ? "PROBLEM" : "PROBLEM (repeat)"
      await logToSheets(store, tag, detail, screenshotUrl)
    } else if (isOk && decision.isRecovery) {
      await sendRecoveryAlert(store)
      outcome.alerted = true
      await logToSheets(store, "RECOVERED", "Checkout back to normal")
    } else {
      await logToSheets(store, isOk ? "OK" : "PROBLEM (ongoing)", detail || "")
    }

    return outcome
  } catch (err) {
    console.error(`  ✗ Unhandled error: ${err.message}`)
    outcome.isOk = false
    outcome.detail = err.message
    await logToSheets(store, "CRASH", err.message)
    return outcome
  } finally {
    cleanup(topPath, bottomPath)
  }
}

export async function runMonitor({ force = false } = {}) {
  console.log(`\n${"=".repeat(50)}`)
  console.log(`Checkout Monitor — ${new Date().toISOString()}${force ? " (forced)" : ""}`)
  console.log(`Checking ${stores.length} store(s)`)
  console.log("=".repeat(50))

  await ensureSheetHeaders()

  const results = []
  for (const store of stores) {
    const outcome = await checkStore(store, { force })
    results.push(outcome)

    // Stagger between stores to avoid triggering bot detection
    if (stores.indexOf(store) < stores.length - 1) {
      await new Promise((r) => setTimeout(r, 8000))
    }
  }

  const summary = {
    checked_at: new Date().toISOString(),
    total: results.length,
    healthy: results.filter((r) => r.isOk).length,
    issues: results.filter((r) => r.isOk === false).length,
    alerted: results.filter((r) => r.alerted).length,
    stores: results,
  }

  console.log(`\n${"=".repeat(50)}`)
  console.log(`Monitor run complete — ${summary.healthy}/${summary.total} healthy, ${summary.alerted} alert(s) sent.`)
  console.log("=".repeat(50))

  return summary
}

// Run a single store by ID (for testing)
export async function runSingle(storeId, { force = false } = {}) {
  const store = stores.find((s) => s.id === storeId)
  if (!store) {
    throw new Error(`Store not found: ${storeId}`)
  }
  await ensureSheetHeaders()
  return checkStore(store, { force })
}
