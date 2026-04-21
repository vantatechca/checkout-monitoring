import { google } from "googleapis"

let sheetsClient = null

async function getClient() {
  if (sheetsClient) return sheetsClient

  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  })

  sheetsClient = google.sheets({ version: "v4", auth })
  return sheetsClient
}

export async function logToSheets(store, status, detail = "", screenshotUrl = "") {
  if (!process.env.SHEETS_ID) return // skip if not configured

  try {
    const sheets = await getClient()

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SHEETS_ID,
      range: "Monitor!A:F",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [
          [
            new Date().toISOString(),
            store.name,
            store.id,
            status,
            detail,
            screenshotUrl,
          ],
        ],
      },
    })
  } catch (err) {
    // Don't let sheets errors break the monitor
    console.error("Google Sheets logging failed:", err.message)
  }
}

export async function ensureSheetHeaders() {
  if (!process.env.SHEETS_ID) return

  try {
    const sheets = await getClient()

    // Check if headers already exist
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEETS_ID,
      range: "Monitor!A1:F1",
    })

    if (existing.data.values?.length) return

    // Write headers
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.SHEETS_ID,
      range: "Monitor!A1:F1",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [["Timestamp", "Store Name", "Store ID", "Status", "Detail", "Screenshot URL"]],
      },
    })
  } catch (err) {
    console.error("Failed to set sheet headers:", err.message)
  }
}
