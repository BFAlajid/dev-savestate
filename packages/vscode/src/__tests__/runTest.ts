import * as path from "path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  try {
    // The extension manifest + entry lives at the package root (two dirs up
    // from out-test/__tests__/). @vscode/test-electron copies this into the
    // test Electron instance so the extension activates under test.
    const extensionDevelopmentPath = path.resolve(__dirname, "../../");

    // Compiled Mocha entry (see ./suite/index.ts). The runner downloads the
    // pinned VS Code version, launches Electron, and requires this file.
    const extensionTestsPath = path.resolve(__dirname, "./suite/index.js");

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      // --disable-extensions keeps the user's installed extensions out of
      // the test host. Our own extension under development is *not* affected
      // by this flag — it is loaded via extensionDevelopmentPath.
      launchArgs: ["--disable-extensions"],
    });
  } catch (err) {
    console.error("Failed to run tests:", err);
    process.exit(1);
  }
}

main();
