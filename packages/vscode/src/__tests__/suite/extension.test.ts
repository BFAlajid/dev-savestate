import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";

// Smoke coverage only: activation + contribution integrity. Behavioral tests
// (command execution, tree data, SCM interaction) require workspace fixtures
// and are deliberately a follow-up — see package README / test harness notes.

// Extension ID follows `<publisher>.<name>` from packages/vscode/package.json.
const EXTENSION_ID = "bunji.dev-savestate-vscode";

// Load the manifest from disk rather than `require`ing package.json as a
// module — keeps tsconfig.test.json honest (no rootDir escape) and avoids
// bundler surprises when the test JS is shipped.
// From out-test/__tests__/suite/extension.test.js the package root is
// three parents up.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const manifest = require(path.resolve(__dirname, "../../../package.json")) as {
  contributes: {
    commands: Array<{ command: string }>;
    views: Record<string, Array<{ id: string }>>;
  };
};

suite("Extension smoke tests", () => {
  test("extension is registered", () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(
      ext,
      `Extension '${EXTENSION_ID}' is not visible to the test host — check publisher + name in package.json.`
    );
  });

  test("extension activates without throwing", async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, "extension not found");
    // activate() is a no-op when no workspace folder is present (see
    // extension.ts), but it must still not throw and must not reject the
    // promise. That is the real smoke signal: the module loads + exports
    // an activation function cleanly.
    await ext!.activate();
    assert.strictEqual(ext!.isActive, true, "extension did not become active");
  });

  test("manifest declares the expected dvs commands", () => {
    const declared = manifest.contributes.commands.map((c) => c.command);
    assert.ok(
      declared.length > 0,
      "manifest declares zero commands — did the test read the wrong package.json?"
    );
    // Any new/removed dvs command will trip one of these, giving us a
    // regression gate without needing a live workspace fixture.
    const expected = [
      "dvs.save",
      "dvs.quickSave",
      "dvs.load",
      "dvs.delete",
      "dvs.inspect",
      "dvs.back",
      "dvs.archive",
      "dvs.unarchive",
      "dvs.refresh",
    ];
    for (const cmd of expected) {
      assert.ok(
        declared.includes(cmd),
        `package.json no longer declares command: ${cmd}`
      );
    }
  });

  test("savestate tree view is contributed to explorer", () => {
    const explorerViews = manifest.contributes.views.explorer ?? [];
    const found = explorerViews.find((v) => v.id === "dvs.savestateView");
    assert.ok(
      found,
      "expected explorer view 'dvs.savestateView' in package.json contributes.views"
    );
  });
});
