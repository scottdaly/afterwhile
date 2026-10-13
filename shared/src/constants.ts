/** Product name. Runtime code reads it from here. */
export const APP_NAME = "afterwhile";

export const NATIVE_HOST_ID = `com.everydaystudio.${APP_NAME}`;

/**
 * Unpacked MV3 public key (SPKI, base64). Pins the extension id so the
 * native-host allowed_origins stay stable. No private key is in the repo.
 */
export const UNPACKED_EXTENSION_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxo7AdCG+N2Xec4Gt1Ve1joQUwentBbbm+y2B1Xq1j/InBCtq1zmUXX84XkerOUO2xi1ZhfDEhvyEbOsd+5Y5Q273L8ZGzSjMoFuFdS78a+e4a9DH7KHROLXiUQ2YBcXmgBnPW6P48LsQZ2ampJ5yecOCCDxawCuM8UnBF8x1wKxrdVvvkxXaP6Pb1QXeRKFOhd01O48PZjZlhlOeMgZESuNM9BwfbtTRkusWpxWSjABsE6CqnD85A9ysfFhiFwmwgDOwq5cigdzVK2uteE/7UwN5XIei537l65kpEohe39Pa+g1mjVPiWZXWcfH97WvdwuOK9KZzvZ2Y5Cr6zCQvYwIDAQAB";

export const UNPACKED_EXTENSION_ID = "kkfafeljlbmkedmgblfbaefpngdomlah";

/** Chrome Web Store and Edge Add-ons ids, added when those listings exist. */
export const STORE_EXTENSION_IDS: readonly string[] = [];

export function allExtensionIds(): string[] {
  return [UNPACKED_EXTENSION_ID, ...STORE_EXTENSION_IDS];
}

export const NATIVE_MESSAGE_MAX_BYTES = 1024 * 1024;
export const RECORD_BATCH_MAX_COUNT = 20;
export const RECORD_BATCH_MAX_BYTES = 256 * 1024;
