import fs from "fs"

const STATE_FILE = "/tmp/monitor-state.json"

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

// Returns true if we should send an alert (status changed or first run)
export function shouldAlert(storeId, isOk) {
  const state = loadState()
  const prev = state[storeId]

  const statusChanged = prev === undefined || prev.isOk !== isOk
  const isNewProblem = !isOk && statusChanged
  const isRecovery = isOk && prev?.isOk === false

  // Update state
  state[storeId] = { isOk, lastChecked: new Date().toISOString() }
  saveState(state)

  return { isNewProblem, isRecovery }
}
