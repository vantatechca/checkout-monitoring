// ─────────────────────────────────────────────
//  Store Configurations
//  Add / remove stores here. Each store needs:
//    id          – unique slug (used in filenames + logs)
//    name        – human-readable (used in alerts)
//    storeUrl    – base domain
//    productUrl  – any product page to trigger add-to-cart
//    variantId   – Shopify variant ID of that product
//    alertNumbers – override global numbers for this store (optional)
// ─────────────────────────────────────────────

export const stores = [
  {
    id: "toronto-peptides",
    name: "Toronto Peptides",
    storeUrl: "https://torontopeptides.ca",
    // "storefront" = simulate the real customer checkout (add-to-cart → /checkout)
    // and screenshot the live checkout page. Omit `variantId` to auto-pick the
    // first in-stock product from /products.json each run.
    checkout: "storefront",
  },
]
