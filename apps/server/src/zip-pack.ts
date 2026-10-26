import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";

/** 解压后总体积上限，挡住异常包把磁盘写满。 */
const MAX_UNZIP_BYTES = 40 * 1024 * 1024;

export interface ZipFile {
  name: string;
  data: Buffer;
}

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

/** 把若干文件打成 zip（UTF-8 文件名，deflate）。供专家包导出。 */
export function zipFiles(files: ZipFile[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = file.name.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!name || name.split("/").includes("..")) throw new Error(`非法打包路径：${file.name}`);
    // 字符串统一先转 Buffer：多字节字符的 .length 是字符数，直接用会写错声明尺寸
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
    const nameBuf = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(data);
    const sum = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0x800),
      u16(8),
      u16(0),
      u16(0),
      u32(sum),
      u32(compressed.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      nameBuf,
      compressed,
    ]);
    const central = Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0x800),
      u16(8),
      u16(0),
      u16(0),
      u32(sum),
      u32(compressed.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBuf,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralDir.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...locals, centralDir, eocd]);
}

export function isZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50;
}

/** 解压本模块打出的 zip，以及常规 deflate/store zip。路径不允许逃出 dest。 */
export function unzipTo(buf: Buffer, dest: string): void {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let cursor = buf.readUInt32LE(eocd + 16);
  let total = 0;
  fs.mkdirSync(dest, { recursive: true });
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(cursor) !== 0x02014b50) throw new Error("压缩包内容损坏");
    const method = buf.readUInt16LE(cursor + 10);
    const compSize = buf.readUInt32LE(cursor + 20);
    const rawSize = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localOff = buf.readUInt32LE(cursor + 42);
    const rawName = buf.slice(cursor + 46, cursor + 46 + nameLen).toString("utf8");
    cursor += 46 + nameLen + extraLen + commentLen;
    if (!rawName || rawName.endsWith("/")) continue;
    // 条目名统一按 / 处理：zip 条目名可以含反斜杠（Windows 打包器产物或恶意构造），
    // "..\x" 作为单段能绕过下面的 ".." 检查，而 path.join 在 Windows 上会把它当父目录
    const name = rawName.replace(/\\/g, "/");
    const parts = name.split("/");
    if (parts.some((p) => p === ".." || p === "" || p.includes(":") || /^[a-zA-Z]:/.test(p))) {
      throw new Error(`压缩包含非法路径：${rawName}`);
    }
    const target = path.join(dest, ...parts);
    // 双保险：归一化后仍复核目标没有落在 dest 之外
    const relToDest = path.relative(path.resolve(dest), path.resolve(target));
    if (!relToDest || relToDest.startsWith("..") || path.isAbsolute(relToDest)) {
      throw new Error(`压缩包含非法路径：${rawName}`);
    }
    total += rawSize;
    if (total > MAX_UNZIP_BYTES) throw new Error("压缩包过大");
    const localNameLen = buf.readUInt16LE(localOff + 26);
    const localExtraLen = buf.readUInt16LE(localOff + 28);
    const dataOff = localOff + 30 + localNameLen + localExtraLen;
    const compressed = buf.slice(dataOff, dataOff + compSize);
    const data = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null;
    if (!data || data.length !== rawSize) throw new Error(`无法解压：${rawName}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }
}

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error("不是有效的 zip 压缩文件");
}
