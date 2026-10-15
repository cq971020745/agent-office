import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "office-grants-test-"));

const { migrate } = await import("./db.js");
migrate();
const {
  grantSessionTool,
  hasSessionGrant,
  listSessionGrants,
  parseToolDecision,
  requestToolApproval,
  resolveToolApproval,
  revokeSessionGrant,
} = await import("./tool-approval.js");

describe("会话工具授权", () => {
  it("授权可持久化、重复授权不报错，撤销后不再命中", () => {
    grantSessionTool("task-1", "terminal");
    grantSessionTool("task-1", "terminal");
    grantSessionTool("task-1", "workspace_write");
    assert.deepEqual(listSessionGrants("task-1"), ["terminal", "workspace_write"]);
    assert.equal(hasSessionGrant("task-1", "terminal"), true);
    assert.equal(revokeSessionGrant("task-1", "terminal"), true);
    assert.equal(hasSessionGrant("task-1", "terminal"), false);
    assert.equal(revokeSessionGrant("task-1", "terminal"), false);
  });

  it("兼容旧的 approved 布尔值，本会话允许会记下工具名", async () => {
    assert.equal(parseToolDecision({ approved: true }), "allow_once");
    assert.equal(parseToolDecision({ approved: false }), "deny");
    assert.equal(parseToolDecision({ decision: "allow_session" }), "allow_session");
    assert.equal(parseToolDecision({}), undefined);

    const taskId = "task-approve";
    const first = requestToolApproval(taskId, "terminal", { command: "Get-Location" });
    assert.equal(resolveToolApproval(taskId, "allow_session"), true);
    assert.equal(await first, true);
    assert.equal(hasSessionGrant(taskId, "terminal"), true);

    const second = requestToolApproval(taskId, "workspace_write", { path: "a.txt" });
    assert.equal(resolveToolApproval(taskId, parseToolDecision({ approved: false })!), true);
    assert.equal(await second, false);
    assert.equal(hasSessionGrant(taskId, "workspace_write"), false);
    assert.equal(resolveToolApproval(taskId, "allow_once"), false);
  });
});
