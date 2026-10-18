import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { listWorkspaceEntries, resolveInsideWorkspace } from "./workspace-tree.js";

describe("resolveInsideWorkspace", () => {
  const root = path.resolve(os.tmpdir(), "office-ws-root");

  it("空路径是工作区根，拒绝越界", () => {
    assert.equal(resolveInsideWorkspace(root, ""), path.resolve(root));
    assert.equal(resolveInsideWorkspace(root, "backend/app"), path.join(path.resolve(root), "backend", "app"));
    assert.equal(resolveInsideWorkspace(root, "../secrets"), undefined);
    assert.equal(resolveInsideWorkspace(root, "backend/../../secrets"), undefined);
    assert.equal(resolveInsideWorkspace(root, "/etc/passwd"), undefined);
  });
});

describe("listWorkspaceEntries", () => {
  it("文件夹排在文件前，并跳过 node_modules", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "office-ws-"));
    fs.mkdirSync(path.join(root, "backend"));
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, "架构图.md"), "# x");
    fs.writeFileSync(path.join(root, "node_modules", "skip.txt"), "no");
    const { entries } = listWorkspaceEntries(root, "");
    assert.deepEqual(
      entries.map((item) => item.name),
      ["backend", "架构图.md"]
    );
    assert.equal(entries[0]?.folder, true);
    assert.equal(entries[1]?.folder, false);
  });
});
