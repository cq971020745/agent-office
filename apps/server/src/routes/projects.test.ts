import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import { workspaceKey } from "./projects.js";

describe("workspaceKey", () => {
  it("strips trailing separators and normalizes slashes", () => {
    const a = workspaceKey(path.join("D:", "proj", "ocr") + path.sep);
    const b = workspaceKey(path.join("D:", "proj", "ocr"));
    assert.equal(a, b);
  });

  it("matches equivalent absolute paths", () => {
    const root = path.resolve("tmp-project-key");
    assert.equal(workspaceKey(root), workspaceKey(root + path.sep));
  });
});
