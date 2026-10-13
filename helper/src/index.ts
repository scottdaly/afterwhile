import { APP_NAME } from "../../shared/src/index.ts";
import { runHost } from "./host.ts";
import { runInstall, runUninstall } from "./install.ts";
import { runMcp } from "./mcp.ts";

export function helpText(): string {
  return [
    `${APP_NAME} host      read captured records from the browser (Chrome starts this)`,
    `${APP_NAME} mcp       answer search from an AI client over stdio`,
    `${APP_NAME} install   register the native host and print MCP config`,
    `${APP_NAME} uninstall remove the native host registration`,
    "",
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0];
  if (!command) {
    if (!process.stdin.isTTY) {
      runHost();
      return;
    }
    process.stdout.write(helpText());
    return;
  }
  // Chrome supplies its origin, and Windows also supplies a parent window handle.
  if (command === "host" || /^chrome-extension:\/\/[a-p]{32}\/$/.test(command)) {
    runHost();
    return;
  }
  if (command === "mcp") {
    await runMcp();
    return;
  }
  if (command === "install") {
    runInstall();
    return;
  }
  if (command === "uninstall") {
    runUninstall();
    return;
  }
  process.stderr.write(helpText());
  process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
