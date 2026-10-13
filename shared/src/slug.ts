const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Filesystem-safe source id. No colons, slashes, or Windows reserved names. */
export function sourceSlug(sourceId: string): string {
  const slug = sourceId
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!slug || RESERVED.test(slug)) return `source-${slug || "unknown"}`;
  return slug;
}
