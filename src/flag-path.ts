import { createHash } from "node:crypto";

// The URL carries a hash rather than the key, so the key stays out of access logs and bucket listings.
export function flagFilePath(secret: string): string {
  const pathId = createHash("sha256").update(`satee-flags-v1:${secret}`).digest("hex").slice(0, 32);
  return `/v1/${pathId}/flags.json`;
}
