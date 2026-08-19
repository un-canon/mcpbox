// Cross-platform `node --check` over src/ and test/ (shell globs are not portable).
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

let failed = false;
for (const dir of ["src", "test"]) {
  for (const file of readdirSync(dir).filter(f => f.endsWith(".mjs"))) {
    try {
      execFileSync(process.execPath, ["--check", join(dir, file)], { stdio: "inherit" });
    } catch {
      failed = true;
    }
  }
}
process.exit(failed ? 1 : 0);
