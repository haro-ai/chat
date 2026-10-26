/** Client-side id helpers (conversation ids are client-generated, ARCH §3). */

export function newConvId(): string {
  return crypto.randomUUID();
}

export function newClientId(): string {
  return crypto.randomUUID();
}
