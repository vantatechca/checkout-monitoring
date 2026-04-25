// Fetches router-state JSON from the bridge worker and formats it for chat.
// Matches the shape returned by bridge-7.flystarcafe7.workers.dev/router/status.

const DEFAULT_ROUTER_STATUS_URL =
  process.env.BRIDGE_ROUTER_STATUS_URL ||
  "https://bridge-7.flystarcafe7.workers.dev/router/status"

export async function getRouterStatus(url = DEFAULT_ROUTER_STATUS_URL) {
  try {
    const resp = await fetch(url, { redirect: "manual" })
    if (!resp.ok) {
      return {
        ok: false,
        message: `⚠️ *ROUTER STATUS UNAVAILABLE*\nBridge returned HTTP ${resp.status}`,
      }
    }

    const data = await resp.json()
    const stores = Array.isArray(data?.stores) ? data.stores : []

    const lines = ["📊 *ROUTER STATUS*"]
    for (const store of stores) {
      const volume = Number(store.volume) || 0
      const limit = Number(store.limit) || 0
      const pct = limit > 0 ? ((volume / limit) * 100).toFixed(0) : "0"
      const bar =
        store.status === "exhausted" ? "🔴" : Number(pct) >= 80 ? "🟡" : "🟢"
      const shop = store.shop ? ` (${store.shop})` : ""
      lines.push(`${bar} ${store.name}${shop}: $${volume.toFixed(0)} / $${limit} (${pct}%)`)
    }

    if (data.resets_at) {
      lines.push(``)
      lines.push(`⏰ Resets: ${data.resets_at}`)
    }

    const exhausted = Number(data.exhausted) || 0
    const available = Number(data.available) || stores.length - exhausted
    if (exhausted > 0) {
      if (available > 0) {
        // Some stores at limit, others have room — orders route to the ones with room.
        lines.push(
          `🟡 ${exhausted} store(s) at daily limit — orders routing to ${available} remaining store(s)`
        )
      } else {
        // ALL stores at limit — bridge falls back to first store and keeps accepting.
        lines.push(
          `🔴 ALL stores at daily limit — bridge falling back to first store, still accepting`
        )
      }
    }

    return { ok: true, message: lines.join("\n"), data }
  } catch (e) {
    return {
      ok: false,
      message: `⚠️ *ROUTER STATUS UNAVAILABLE*\nError fetching: ${e.message}`,
    }
  }
}
