import fs from "fs"

const STATE_FILE = "/tmp/monitor-state.json"

// How often to send an OK heartbeat for a healthy store.
// Default 2h — override with OK_ALERT_INTERVAL_MS env var.
const OK_ALERT_INTERVAL_MS =
  Number(process.env.OK_ALERT_INTERVAL_MS) || 2 * 60 * 60 * 1000

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
  } catch {}
  return {}
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  } catch {}
}

/**
 * Decide whether to fire an alert for this store's current status.
 *
 *   - PROBLEM (isOk === false) → always send (every cycle until fixed)
 *   - Recovery (was broken, now OK) → always send, regardless of throttle
 *   - OK heartbeat (was OK, still OK) → only every OK_ALERT_INTERVAL_MS (2h default)
 *
 * Returns { send, reason } and persists updated state.
 */
export function shouldSendAlert(storeId, isOk) {
  const state = loadState()
  const prev = state[storeId] || {}
  const now = Date.now()

  let send = false
  let reason = ""

  if (!isOk) {
    send = true
    reason = "problem"
  } else if (prev.isOk === false) {
    send = true
    reason = "recovery"
  } else {
    const sinceLast = prev.lastAlertAt ? now - prev.lastAlertAt : Infinity
    if (sinceLast >= OK_ALERT_INTERVAL_MS) {
      send = true
      reason = prev.lastAlertAt ? "heartbeat" : "first-ok"
    } else {
      send = false
      reason = "throttled"
    }
  }

  state[storeId] = {
    isOk,
    lastChecked: now,
    lastAlertAt: send ? now : prev.lastAlertAt || null,
  }
  saveState(state)

  return { send, reason }
}

// Utility — exposed in case you want a /clear-state admin endpoint later.
export function clearState() {
  try {
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE)
  } catch {}
}

// ─── Router status throttle ──────────────────────────────────────────────────
// The router status digest is informational, not urgent — throttle broadcasts
// to every ROUTER_STATUS_INTERVAL_MS (default 4h).
const ROUTER_STATUS_INTERVAL_MS =
  Number(process.env.ROUTER_STATUS_INTERVAL_MS) || 4 * 60 * 60 * 1000

export function shouldSendRouterStatus() {
  const state = loadState()
  const now = Date.now()
  const last = state._routerStatusAt || 0

  if (now - last >= ROUTER_STATUS_INTERVAL_MS) {
    state._routerStatusAt = now
    saveState(state)
    return { send: true, reason: last ? "interval" : "first-run" }
  }
  return { send: false, reason: "throttled" }
}
