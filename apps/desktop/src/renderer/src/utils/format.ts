// 展示层的格式化工具：相对时间、文件大小、头像配色。

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 具体日期 */
export function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return sameYear ? `${d.getMonth() + 1} 月 ${d.getDate()} 日` : `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** 文件大小的人类可读形式 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

const AVATAR_COLORS = [
  ["#177e5b", "#2f9d75"],
  ["#2563eb", "#3b82f6"],
  ["#7c3aed", "#a855f7"],
  ["#d97706", "#f59e0b"],
  ["#db2777", "#ec4899"],
  ["#0891b2", "#06b6d4"],
  ["#4d7c0f", "#84cc16"],
  ["#dc2626", "#f87171"],
] as const;

/** 按名称散列出稳定的头像配色 */
export function avatarGradient(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  const [from, to] = AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]!;
  return `linear-gradient(135deg, ${from}, ${to})`;
}

/** 按扩展名判断成果物预览方式 */
export type PreviewKind = "html" | "image" | "pdf" | "audio" | "text" | "download";

export function previewKind(filename: string): PreviewKind {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "html" || ext === "htm") return "html";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"].includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (["mp3", "wav", "m4a", "ogg", "webm", "flac", "aac"].includes(ext)) return "audio";
  if (
    [
      "txt",
      "md",
      "json",
      "csv",
      "tsv",
      "log",
      "xml",
      "yml",
      "yaml",
      "toml",
      "ini",
      "env",
      "js",
      "mjs",
      "cjs",
      "ts",
      "tsx",
      "jsx",
      "vue",
      "css",
      "scss",
      "py",
      "java",
      "go",
      "rs",
      "sh",
      "bash",
      "ps1",
      "psm1",
      "bat",
      "cmd",
      "sql",
      "c",
      "h",
      "cpp",
      "hpp",
      "cs",
      "rb",
      "php",
      "swift",
      "kt",
      "html",
    ].includes(ext)
  )
    return "text";
  return "download";
}
