import fs from "fs"

const STATE_FILE = "/tmp/monitor-state.json"

// Cooldown — don't re-alert for the same ongoing problem within this window.
// Default 1 hour; override with env ALERT_COOLDOWN_MS.
const ALERT_COOLDOWN_MS = Number(process.env.ALERT_COOLDOWN_MS) || 60 * 60 * 1000

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
    }
  } catch {}
  return {}
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  } catch {}
}

// Returns { isNewProblem, isRecovery, shouldRepeatAlert } so callers can decide.
// - isNewProblem: transitioned from ok→problem (or first ever check)
// - isRecovery:    transitioned from problem→ok
// - shouldRepeatAlert: still a problem and cooldown has elapsed since last alert
export function shouldAlert(storeId, isOk, { force = false } = {}) {
  const state = loadState()
  const prev = state[storeId] || {}

  const statusChanged = prev.isOk === undefined || prev.isOk !== isOk
  const isNewProblem = !isOk && statusChanged
  const isRecovery = isOk && prev.isOk === false

  const now = Date.now()
  const sinceLast = prev.lastAlertAt ? now - prev.lastAlertAt : Infinity
  const shouldRepeatAlert = !isOk && !statusChanged && sinceLast >= ALERT_COOLDOWN_MS

  const willAlert = force || isNewProblem || isRecovery || shouldRepeatAlert

  state[storeId] = {
    isOk,
    lastChecked: new Date().toISOString(),
    lastAlertAt: willAlert && !isOk ? now : prev.lastAlertAt || null,
  }
  saveState(state)

  return { isNewProblem, isRecovery, shouldRepeatAlert, willAlert }
}

// Wipe cooldown state — useful for the /clear-cooldowns endpoint.
export function clearCooldowns() {
  try {
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE)
  } catch {}
}
