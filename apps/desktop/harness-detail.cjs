// 截图验收 harness：加载打包后的渲染器，注入 token，分别截「专家列表」与「专家详情」两页
const { app, BrowserWindow } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const AGENT = process.env.HARNESS_AGENT || "227043da-b00c-44f0-8426-74638e72caa2";
const OUT_DIR = process.env.HARNESS_OUT || path.join(process.cwd(), "out", "shots");
fs.mkdirSync(OUT_DIR, { recursive: true });

function signToken(sub, role) {
  const b64u = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const h = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64u(JSON.stringify({ sub, role }));
  const s = crypto.createHmac("sha256", process.env.JWT_SECRET ?? "dev-secret-do-not-use-in-production").update(`${h}.${p}`).digest();
  return `${h}.${p}.${b64u(s)}`;
}

async function main() {
  const dbmod = require(path.join(process.cwd(), "..", "server", "node_modules", "better-sqlite3"));
  const db = new dbmod(path.join(process.cwd(), "..", "server", "data", "app.db"), { readonly: true });
  const admin = db.prepare("SELECT id, role FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1").get();
  db.close();
  const token = signToken(admin.id, admin.role);

  const win = new BrowserWindow({ width: 1240, height: 820, show: true });
  await win.loadFile(path.join(__dirname, "out", "renderer", "index.html"));
  await win.webContents.executeJavaScript(`
    localStorage.setItem("agent-office-token", ${JSON.stringify(token)});
    localStorage.setItem("agent-office-username", "admin");
    "ok"`);
  // 专家列表页
  win.webContents.executeJavaScript(`location.hash = "#/experts"; void 0;`);
  await new Promise((r) => setTimeout(r, 2500));
  fs.writeFileSync(path.join(OUT_DIR, "experts-list.png"), (await win.webContents.capturePage()).toPNG());
  // 专家详情页（模拟点击卡片进入的路由）
  win.webContents.executeJavaScript(`(function(){ const card = document.querySelector('.expert-card.clickable'); if (!card) return 'NO_CARD'; card.click(); return location.hash; })()`).then((r) => console.log("click ->", r));
  await new Promise((r) => setTimeout(r, 2500));
  fs.writeFileSync(path.join(OUT_DIR, "expert-detail.png"), (await win.webContents.capturePage()).toPNG());
  // 滚到任务区再补一张
  await win.webContents.executeJavaScript(`document.querySelector(".body")?.scrollTo(0, 400); "ok"`);
  await new Promise((r) => setTimeout(r, 400));
  fs.writeFileSync(path.join(OUT_DIR, "expert-detail-scrolled.png"), (await win.webContents.capturePage()).toPNG());
  console.log("SHOTS DONE:", OUT_DIR);
  app.quit();
}

app.whenReady().then(main).catch((e) => { console.error(e); app.exit(1); });
