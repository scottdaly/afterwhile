import { homedir } from "os";
import path from "path";
import { APP_NAME } from "../../shared/src/index.ts";

export function envName(suffix: string): string {
  return `${APP_NAME.toUpperCase()}_${suffix}`;
}

export function resolveHome(platform: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env[envName("HOME")];
  if (override) return override;
  if (platform === "win32") return env.USERPROFILE || env.HOME || homedir();
  return env.HOME || env.USERPROFILE || homedir();
}

export function dataDir(options?: {
  platform?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}): string {
  const env = options?.env ?? process.env;
  const override = env[envName("DATA_DIR")];
  if (override) return override;
  const platform = options?.platform ?? process.platform;
  const home = options?.home ?? resolveHome(platform, env);
  if (platform === "darwin") {
    return path.posix.join(home, "Library", "Application Support", APP_NAME);
  }
  if (platform === "win32") {
    const local = env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local");
    return path.win32.join(local, APP_NAME);
  }
  const xdg = env.XDG_DATA_HOME || path.posix.join(home, ".local", "share");
  return path.posix.join(xdg, APP_NAME);
}

export function filesDir(options?: {
  platform?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}): string {
  const env = options?.env ?? process.env;
  const override = env[envName("FILES_DIR")];
  if (override) return override;
  const platform = options?.platform ?? process.platform;
  const home = options?.home ?? resolveHome(platform, env);
  if (platform === "win32") return path.win32.join(home, APP_NAME);
  return path.posix.join(home, APP_NAME);
}

export function databasePath(options?: {
  platform?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}): string {
  const platform = options?.platform ?? process.platform;
  const root = dataDir(options);
  if (platform === "win32") return path.win32.join(root, "records.db");
  return path.join(root, "records.db");
}
