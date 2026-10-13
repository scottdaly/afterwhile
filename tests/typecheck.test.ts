import { expect, test } from "bun:test";
import path from "path";

for (const project of ["shared", "helper", "extension"]) {
  test(`${project} passes TypeScript`, async () => {
    const root = path.resolve(import.meta.dir, "..");
    const proc = Bun.spawn([process.execPath, "node_modules/typescript/bin/tsc", "-p", project], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [output, errors, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    expect({ code, output, errors }).toEqual({ code: 0, output: "", errors: "" });
  }, 30_000);
}
