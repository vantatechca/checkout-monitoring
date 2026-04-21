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

async function checkStore(store) {
  console.log(`\n→ Checking: ${store.name}`)

  let topPath, bottomPath

  try {
    // 1. Screenshot the checkout
    const shot = await captureCheckout(store)

    if (!shot.success) {
      console.error(`  ✗ Screenshot failed: ${shot.error}`)
      const { isNewProblem } = shouldAlert(store.id, false)
      if (isNewProblem) {
        await sendAlert(store, `Could not load checkout: ${shot.error}`)
      }
      await logToSheets(store, "ERROR", shot.error)
      return
    }

    topPath = shot.topPath
    bottomPath = shot.bottomPath
    console.log(`  ✓ Screenshots captured`)

    // 2. Analyze with Claude Vision
    const { isOk, result, detail } = await analyzeCheckout(store, topPath, bottomPath)
    console.log(`  ${isOk ? "✓ OK" : `✗ ${result}`}`)

    const { isNewProblem, isRecovery } = shouldAlert(store.id, isOk)

    if (isNewProblem) {
      // 3. Upload screenshot to Cloudinary
      let screenshotUrl = null
      try {
        const publicId = `${store.id}_${Date.now()}_top`
        screenshotUrl = await uploadToCloudinary(topPath, publicId)
        console.log(`  ✓ Screenshot uploaded: ${screenshotUrl}`)
      } catch (e) {
        console.warn(`  ⚠ Screenshot upload failed: ${e.message}`)
      }

      // 4. Send WhatsApp alerts
      await sendAlert(store, detail, screenshotUrl, shot.pageUrl)
      console.log(`  ✓ Alerts sent`)

      // 5. Log to Sheets
      await logToSheets(store, "PROBLEM", detail, screenshotUrl)
    } else if (isRecovery) {
      await sendRecoveryAlert(store)
      await logToSheets(store, "RECOVERED", "Checkout back to normal")
      console.log(`  ✓ Recovery alert sent`)
    } else {
      await logToSheets(store, isOk ? "OK" : "PROBLEM (ongoing)", detail || "")
    }
  } catch (err) {
    console.error(`  ✗ Unhandled error: ${err.message}`)
    await logToSheets(store, "CRASH", err.message)
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

  for (const store of stores) {
    await checkStore(store)

    // Stagger between stores to avoid triggering bot detection
    if (stores.indexOf(store) < stores.length - 1) {
      await new Promise((r) => setTimeout(r, 8000))
    }
  }

  console.log(`\n${"=".repeat(50)}`)
  console.log("Monitor run complete.")
  console.log("=".repeat(50))
}

// Run a single store by ID (for testing)
export async function runSingle(storeId) {
  const store = stores.find((s) => s.id === storeId)
  if (!store) {
    console.error(`Store not found: ${storeId}`)
    process.exit(1)
  }
  await ensureSheetHeaders()
  await checkStore(store)
}

// Entry point
runMonitor().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
