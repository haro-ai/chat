/**
 * UUID helpers (conversation ids are client-generated, ARCH §3).
 *
 * `crypto.randomUUID()` is only exposed in secure contexts (https or
 * localhost) — Safari on plain-HTTP tailnet IPs doesn't have it — so fall
 * back to getRandomValues, which is available everywhere.
 */
export function uuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}` +
    `-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  );
}

export function newConvId(): string {
  return uuid();
}

export function newClientId(): string {
  return uuid();
}