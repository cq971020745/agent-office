// 验收截图：派发页模型下拉（应只含对话模型）
const { app, BrowserWindow } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

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
  const win = new BrowserWindow({ width: 1240, height: 820, show: true });
  await win.loadFile(path.join(__dirname, "out", "renderer", "index.html"));
  await win.webContents.executeJavaScript(`
    localStorage.setItem("agent-office-token", ${JSON.stringify(signToken(admin.id, admin.role))});
    localStorage.setItem("agent-office-username", "admin");
    "ok"`);
  win.webContents.executeJavaScript(`location.hash = "#/"; void 0;`);
  await new Promise((r) => setTimeout(r, 2200));
  // 点开模型选择气泡
  const clickRes = await win.webContents.executeJavaScript(`
    (function(){
      const btn = document.querySelector('.model-select button');
      if (!btn) return 'NO_BTN';
      btn.click();
      return 'clicked';
    })()`);
  console.log("model picker:", clickRes);
  await new Promise((r) => setTimeout(r, 800));
  const items = await win.webContents.executeJavaScript(
    `JSON.stringify(Array.from(document.querySelectorAll('.model-select .pop-item, .model-select [class*=pop] , .model-pop *')).slice(0,0))`
  );
  fs.mkdirSync(path.join(process.cwd(), "out", "shots"), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), "out", "shots", "dispatch-models.png"), (await win.webContents.capturePage()).toPNG());
  console.log("SHOT DONE");
  app.quit();
}
app.whenReady().then(main).catch((e) => { console.error(e); app.exit(1); });
