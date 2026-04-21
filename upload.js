import fs from "fs"

export async function uploadToCloudinary(filePath, publicId) {
  const fileBuffer = fs.readFileSync(filePath)
  const blob = new Blob([fileBuffer], { type: "image/png" })

  const form = new FormData()
  form.append("file", blob, "screenshot.png")
  form.append("upload_preset", process.env.CLOUDINARY_UPLOAD_PRESET)
  form.append("public_id", publicId)
  form.append("folder", "checkout-monitor")

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload`,
    {
      method: "POST",
      body: form,
      // No headers — let fetch set Content-Type with boundary automatically
    }
  )

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Cloudinary upload failed (${res.status}): ${err}`)
  }

  const data = await res.json()
  return data.secure_url
}