import { chmodSync, mkdirSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { allExtensionIds, APP_NAME, NATIVE_HOST_ID } from "../../shared/src/index.ts";
import { dataDir, resolveHome } from "./paths.ts";

export interface InstallTarget {
  platform: string;
  home: string;
  localAppData?: string;
  hostPath: string;
  extensionIds: string[];
}

export interface InstallFile {
  path: string;
  contents: string;
}

export interface InstallPlan {
  platform: string;
  files: InstallFile[];
  registry: Array<{ key: string; data: string }>;
}

const HOST_DESCRIPTION = "Saves web-app pages you read on this computer for local search.";

export function browserManifestDirs(platform: string, home: string): string[] {
  if (platform === "darwin") {
    return [
      path.posix.join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts"),
      path.posix.join(home, "Library", "Application Support", "Microsoft Edge", "NativeMessagingHosts"),
      path.posix.join(home, "Library", "Application Support", "Chromium", "NativeMessagingHosts"),
    ];
  }
  if (platform === "win32") {
    return [];
  }
  return [
    path.posix.join(home, ".config", "google-chrome", "NativeMessagingHosts"),
    path.posix.join(home, ".config", "microsoft-edge", "NativeMessagingHosts"),
    path.posix.join(home, ".config", "chromium", "NativeMessagingHosts"),
  ];
}

export function windowsRegistryKeys(): string[] {
  return [
    `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_ID}`,
    `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NATIVE_HOST_ID}`,
    `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${NATIVE_HOST_ID}`,
  ];
}

export function hostManifest(hostPath: string, extensionIds: string[]): string {
  return `${JSON.stringify(
    {
      name: NATIVE_HOST_ID,
      description: HOST_DESCRIPTION,
      path: hostPath,
      type: "stdio",
      allowed_origins: extensionIds.map((id) => `chrome-extension://${id}/`),
    },
    null,
    2,
  )}\n`;
}

export function planInstall(target: InstallTarget): InstallPlan {
  const contents = hostManifest(target.hostPath, target.extensionIds);
  if (target.platform === "win32") {
    const local = target.localAppData || path.win32.join(target.home, "AppData", "Local");
    const manifestPath = path.win32.join(local, APP_NAME, "native-host", `${NATIVE_HOST_ID}.json`);
    return {
      platform: target.platform,
      files: [{ path: manifestPath, contents }],
      registry: windowsRegistryKeys().map((key) => ({ key, data: manifestPath })),
    };
  }
  const files = browserManifestDirs(target.platform, target.home).map((dir) => ({
    path: path.posix.join(dir, `${NATIVE_HOST_ID}.json`),
    contents,
  }));
  return { platform: target.platform, files, registry: [] };
}

export function applyInstall(plan: InstallPlan): void {
  for (const file of plan.files) {
    mkdirSync(path.dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.contents);
  }
  if (plan.platform === "win32") {
    for (const entry of plan.registry) {
      const result = spawnSync("reg", ["add", entry.key, "/ve", "/d", entry.data, "/f"], { encoding: "utf8" });
      if (result.status !== 0) {
        throw new Error(result.stderr || `reg add failed for ${entry.key}`);
      }
    }
  }
}

export function applyUninstall(plan: InstallPlan): void {
  for (const file of plan.files) rmSync(file.path, { force: true });
  if (plan.platform === "win32") {
    for (const entry of plan.registry) {
      spawnSync("reg", ["delete", entry.key, "/f"], { encoding: "utf8" });
    }
  }
}

export function mcpSnippets(command: string, args: string[]): string {
  const argList = args.map((arg) => JSON.stringify(arg)).join(", ");
  const tomlArgs = args.map((arg) => JSON.stringify(arg)).join(", ");
  return [
    "Claude Code (project .mcp.json or Claude config):",
    JSON.stringify(
      {
        mcpServers: {
          [APP_NAME]: { command, args },
        },
      },
      null,
      2,
    ),
    "",
    "OpenAI Codex (~/.codex/config.toml):",
    `[mcp_servers.${APP_NAME}]`,
    `command = ${JSON.stringify(command)}`,
    `args = [${tomlArgs}]`,
    "",
    "These snippets match the public stdio config for those clients.",
    "This machine did not verify them inside Claude Code or Codex.",
    "",
    `Command check: ${command} ${args.join(" ")}`,
    `JSON args: [${argList}]`,
  ].join("\n");
}

export interface Invocation {
  hostPath: string;
  cliPath: string;
  mcpCommand: string;
  mcpArgs: string[];
}

function entrypoint(): { bun: string; script: string } | null {
  const exec = process.execPath;
  const base = path.basename(exec).toLowerCase();
  if (base === APP_NAME || base === `${APP_NAME}.exe`) return null;
  const script = fileURLToPath(new URL("./index.ts", import.meta.url));
  return { bun: exec, script };
}

export function cliLauncher(bun: string, script: string): string {
  return `#!/bin/sh\nexec ${shellQuote(bun)} ${shellQuote(script)} "$@"\n`;
}

export function hostLauncher(bun: string, script: string): string {
  return `#!/bin/sh\nexec ${shellQuote(bun)} ${shellQuote(script)} host\n`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function prepareInvocation(platform = process.platform, env = process.env): Invocation {
  const compiled = entrypoint();
  if (!compiled) {
    return {
      hostPath: process.execPath,
      cliPath: process.execPath,
      mcpCommand: process.execPath,
      mcpArgs: ["mcp"],
    };
  }
  if (platform === "win32") {
    throw new Error(
      `Build the ${APP_NAME}.exe with bun build --compile on Windows, then run install again. Chrome on Windows needs an .exe native host.`,
    );
  }
  const bin = path.join(dataDir({ platform, env }), "bin");
  mkdirSync(bin, { recursive: true });
  const cliPath = path.join(bin, APP_NAME);
  const hostPath = path.join(bin, `${APP_NAME}-host`);
  writeFileSync(cliPath, cliLauncher(compiled.bun, compiled.script));
  writeFileSync(hostPath, hostLauncher(compiled.bun, compiled.script));
  chmodSync(cliPath, 0o755);
  chmodSync(hostPath, 0o755);
  return { hostPath, cliPath, mcpCommand: cliPath, mcpArgs: ["mcp"] };
}

export function runInstall(): void {
  const invocation = prepareInvocation();
  const home = resolveHome(process.platform);
  const plan = planInstall({
    platform: process.platform,
    home,
    localAppData: process.env.LOCALAPPDATA,
    hostPath: invocation.hostPath,
    extensionIds: allExtensionIds(),
  });
  applyInstall(plan);
  process.stdout.write(
    [
      `Registered ${NATIVE_HOST_ID}`,
      ...plan.files.map((file) => `manifest ${file.path}`),
      ...plan.registry.map((entry) => `registry ${entry.key}=${entry.data}`),
      `host ${invocation.hostPath}`,
      `command ${invocation.cliPath}`,
      "",
      mcpSnippets(invocation.mcpCommand, invocation.mcpArgs),
      "",
    ].join("\n"),
  );
}

export function runUninstall(): void {
  const home = resolveHome(process.platform);
  const invocation = entrypoint();
  const hostPath = invocation ? path.join(dataDir(), "bin", `${APP_NAME}-host`) : process.execPath;
  const plan = planInstall({
    platform: process.platform,
    home,
    localAppData: process.env.LOCALAPPDATA,
    hostPath,
    extensionIds: allExtensionIds(),
  });
  applyUninstall(plan);
  if (invocation) {
    rmSync(path.join(dataDir(), "bin", APP_NAME), { force: true });
    rmSync(hostPath, { force: true });
  }
  process.stdout.write("Removed native host registration. Saved records were left in place.\n");
}

