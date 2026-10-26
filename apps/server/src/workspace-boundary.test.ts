// workspace-boundary.test.ts：用户自选工作目录边界（评审 P0-1 回归）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "office-boundary-test-"));

const { resolveUserWorkspaceDir, isStrictlyInsidePlatformWorkspace } = await import("./workspace-boundary.js");
const { config, paths } = await import("./config.js");

describe("resolveUserWorkspaceDir", () => {
  it("接受 DATA_DIR 之外的真实目录", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "boundary-ok-"));
    const picked = resolveUserWorkspaceDir(outside);
    assert.ok(picked.ok);
    assert.equal(picked.ok && picked.dir, path.resolve(outside));
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("拒绝 DATA_DIR 本身与其内部（app.db / 会话 / 他人工作区都在里面）", () => {
    for (const candidate of [config.dataDir, paths.workspaces, path.join(config.dataDir, "app.db"), paths.agentDir]) {
      fs.mkdirSync(candidate, { recursive: true });
      const picked = resolveUserWorkspaceDir(candidate);
      assert.ok(!picked.ok, `应拒绝 ${candidate}`);
    }
  });

  it("拒绝平台工作区根（曾可经删除任务 rmSync 整个根）", () => {
    fs.mkdirSync(paths.workspaces, { recursive: true });
    const picked = resolveUserWorkspaceDir(paths.workspaces);
    assert.ok(!picked.ok);
  });

  it("拒绝不存在的路径与符号链接目录", () => {
    const missing = resolveUserWorkspaceDir(path.join(os.tmpdir(), `boundary-missing-${Date.now()}`));
    assert.ok(!missing.ok);

    const base = fs.mkdtempSync(path.join(os.tmpdir(), "boundary-link-"));
    const real = path.join(base, "real");
    fs.mkdirSync(real);
    const link = path.join(base, "link");
    // Windows 无开发者模式建不了软链接，目录用 junction（Node lstat 同样识别为符号链接）
    fs.symlinkSync(real, link, "junction");
    const picked = resolveUserWorkspaceDir(link);
    assert.ok(!picked.ok, "符号链接目录应被拒绝");
    fs.rmSync(base, { recursive: true, force: true });
  });
});

describe("isStrictlyInsidePlatformWorkspace", () => {
  it("根本身不算「内部」，内部路径算", () => {
    fs.mkdirSync(paths.workspaces, { recursive: true });
    assert.equal(isStrictlyInsidePlatformWorkspace(paths.workspaces), false);
    const inner = path.join(paths.workspaces, "task-1");
    fs.mkdirSync(inner, { recursive: true });
    assert.equal(isStrictlyInsidePlatformWorkspace(inner), true);
    assert.equal(isStrictlyInsidePlatformWorkspace(config.dataDir), false);
  });
});
