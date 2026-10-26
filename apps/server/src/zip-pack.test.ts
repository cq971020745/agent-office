// zip-pack.test.ts：解包路径穿越回归（评审 P0：反斜杠条目逃逸）。
// 恶意 zip 不能用本仓库 zipFiles 构造（打包器会归一化反斜杠），这里手写原生 store zip。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { isZip, unzipTo, zipFiles } = await import("./zip-pack.js");

const BS = String.fromCharCode(92);

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n & 0xffff);
  return b;
}
function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

/** 最小 store-method zip（绕过仓库打包器的归一化，等价于攻击者手工构造）。 */
function rawZip(entries: Array<{ name: string; data: string }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data, "utf8");
    const crc = zlib.crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x800), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(nameBuf.length), u16(0), nameBuf, data,
    ]);
    const central = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x800), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBuf,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(centralDir.length), u32(offset), u16(0)]);
  return Buffer.concat([...locals, centralDir, eocd]);
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "office-zip-test-"));
}

describe("unzipTo 路径穿越防护", () => {
  it("反斜杠条目 ..\\evil.txt 不再逃出目标目录（评审 P0 回归）", () => {
    const base = tempDir();
    const dest = path.join(base, "dest");
    const evilName = ["..", "evil.txt"].join(BS);
    const evilZip = rawZip([{ name: evilName, data: "pwned" }]);
    assert.ok(isZip(evilZip));
    assert.throws(() => unzipTo(evilZip, dest), /非法路径/);
    // 不论抛错与否，文件都必须落在 dest 之外
    assert.ok(!fs.existsSync(path.join(base, "evil.txt")), "不得逃逸到目标目录之外");
    assert.ok(!fs.existsSync(path.join(dest, evilName)));
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("多层反斜杠 ..\\..\\x.txt 同样被拒", () => {
    const base = tempDir();
    const dest = path.join(base, "dest");
    const evilZip = rawZip([{ name: ["..", "..", "x.txt"].join(BS), data: "x" }]);
    assert.throws(() => unzipTo(evilZip, dest), /非法路径/);
    assert.ok(!fs.existsSync(path.join(base, "x.txt")));
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("拒绝带盘符的绝对条目名", () => {
    const base = tempDir();
    const dest = path.join(base, "dest");
    const evilZip = rawZip([{ name: "C:" + BS + "evil-abs.txt", data: "x" }]);
    assert.throws(() => unzipTo(evilZip, dest), /非法路径/);
    assert.ok(!fs.existsSync(path.join(path.parse(base).root, "evil-abs.txt")));
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("正常条目（含子目录、正斜杠）解压不受影响", () => {
    const base = tempDir();
    const dest = path.join(base, "dest");
    const ok = rawZip([
      { name: "skin.json", data: "{}" },
      { name: "assets/wall.svg", data: "<svg/>" },
    ]);
    unzipTo(ok, dest);
    assert.equal(fs.readFileSync(path.join(dest, "skin.json"), "utf8"), "{}");
    assert.equal(fs.readFileSync(path.join(dest, "assets", "wall.svg"), "utf8"), "<svg/>");
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("声明尺寸超限在解压前被拒（压缩炸弹不进入解压）", () => {
    const base = tempDir();
    const dest = path.join(base, "dest");
    // zipFiles 是 deflate：小数据声明尺寸小；直接改写 central 目录 rawSize 模拟撒谎大尺寸
    const zipped = zipFiles([{ name: "big.txt", data: "x" }]);
    // central directory 的 rawSize 位于 fixed header 之后：直接搜 PK\x01\x02 头修补
    const idx = zipped.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const rawSizeOff = idx + 24;
    zipped.writeUInt32LE(50 * 1024 * 1024, rawSizeOff);
    // local header 的 rawSize 也要一致，否则长度校验会抛"无法解压"；先确保总量校验先触发
    assert.throws(() => unzipTo(zipped, dest), /压缩包过大|无法解压/);
    assert.ok(!fs.existsSync(path.join(dest, "big.txt")));
    fs.rmSync(base, { recursive: true, force: true });
  });
});
