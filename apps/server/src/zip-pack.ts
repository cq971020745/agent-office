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
    const nameBuf = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(file.data);
    const sum = crc32(file.data);
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0x800),
      u16(8),
      u16(0),
      u16(0),
      u32(sum),
      u32(compressed.length),
      u32(file.data.length),
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
      u32(file.data.length),
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
    const name = buf.slice(cursor + 46, cursor + 46 + nameLen).toString("utf8");
    cursor += 46 + nameLen + extraLen + commentLen;
    if (!name || name.endsWith("/")) continue;
    const parts = name.split("/");
    if (parts.some((p) => p === ".." || p === "")) throw new Error(`压缩包含非法路径：${name}`);
    total += rawSize;
    if (total > MAX_UNZIP_BYTES) throw new Error("压缩包过大");
    const localNameLen = buf.readUInt16LE(localOff + 26);
    const localExtraLen = buf.readUInt16LE(localOff + 28);
    const dataOff = localOff + 30 + localNameLen + localExtraLen;
    const compressed = buf.slice(dataOff, dataOff + compSize);
    const data = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null;
    if (!data || data.length !== rawSize) throw new Error(`无法解压：${name}`);
    const target = path.join(dest, ...parts);
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
