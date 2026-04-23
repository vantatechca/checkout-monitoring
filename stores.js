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
    bridgeUrl: "https://bridge-7.flystarcafe7.workers.dev/s2s",
    bridgePayload: {
      source_store: "torontopeptides.com",
      currency: "CAD",
      lines: [
        {
          title: "BPC-157 5mg",
          price: "49.99",
          quantity: 1,
        }
      ]
    }
  },
  
]
