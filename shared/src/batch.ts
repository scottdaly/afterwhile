import { RECORD_BATCH_MAX_BYTES, RECORD_BATCH_MAX_COUNT } from "./constants.ts";

export function chunkRecords<T>(
  items: T[],
  maxCount = RECORD_BATCH_MAX_COUNT,
  maxBytes = RECORD_BATCH_MAX_BYTES,
): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let size = 2;
  for (const item of items) {
    const encoded = JSON.stringify(item).length;
    if (current.length > 0 && (current.length >= maxCount || size + encoded + 1 > maxBytes)) {
      chunks.push(current);
      current = [];
      size = 2;
    }
    current.push(item);
    size += encoded + 1;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
