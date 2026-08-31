export const SPICE_RECEIPT_COMPONENT_KEYS = {
  receipt: "spice.receipt",
  identities: "spice.receipt-identities",
  runtimeIdentity: "spice.runtime-identity",
  normalizedRequest: "spice.normalized-request",
} as const;

export const SPICE_RECEIPT_SURFACE = {
  layout: { type: "stack", gap: "sm" },
  components: [
    { id: "receipt", component: SPICE_RECEIPT_COMPONENT_KEYS.receipt },
  ],
} as const;
