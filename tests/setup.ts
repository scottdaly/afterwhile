import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { APP_NAME } from "../shared/src/index.ts";
import { envName } from "../helper/src/paths.ts";

// Keep helper logs and default paths in a synthetic test home too.
const root = mkdtempSync(path.join(tmpdir(), `${APP_NAME}-tests-`));
process.env[envName("DATA_DIR")] = path.join(root, "data");
process.env[envName("FILES_DIR")] = path.join(root, "files");
process.env[envName("HOME")] = root;
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
