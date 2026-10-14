// 审批流截图：任务详情审批面板 + 专家卡片高风险徽标 + 配置对话框开关
// token 与用户名由外部签名后经 argv 传入（better-sqlite3 无法从 desktop cwd 解析）
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const TOKEN = process.argv[2];
const USERNAME = process.argv[3] || "admin";
const user = { username: USERNAME };
const taskId = process.argv[4];
const shotDir = path.join(__dirname, "shots");
fs.mkdirSync(shotDir, { recursive: true });

async function shoot(win, name) {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(shotDir, name), img.toPNG());
  console.log("saved", name);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1560,
    height: 980,
    show: true,
    webPreferences: { contextIsolation: true },
  });
  await win.loadFile(path.join(__dirname, "out", "renderer", "index.html"));
  await win.webContents.executeJavaScript(
    `localStorage.setItem("agent-office-token", ${JSON.stringify(TOKEN)});
     localStorage.setItem("agent-office-username", ${JSON.stringify(user.username)});`
  );

  // 1. 任务详情审批面板
  await win.webContents.executeJavaScript(`location.hash = "#/tasks/${taskId}";`);
  await new Promise((r) => setTimeout(r, 4000));
  await shoot(win, "approve-panel.png");

  // 2. 专家列表：高风险徽标
  await win.webContents.executeJavaScript(`location.hash = "#/experts";`);
  await new Promise((r) => setTimeout(r, 2500));
  await shoot(win, "experts-badge.png");

  // 3. 编辑对话框：高风险开关
  await win.webContents.executeJavaScript(`location.hash = "#/experts";`);
  await new Promise((r) => setTimeout(r, 800));
  const clicked = await win.webContents.executeJavaScript(`
    (() => {
      const cards = [...document.querySelectorAll(".expert-card")];
      const card = cards.find((c) => c.textContent.includes("C盘清理"));
      if (!card) return "card-not-found";
      const more = card.querySelector(".more-btn");
      if (!more) return "no-more-btn";
      more.click();
      return "menu-opened";
    })()
  `);
  console.log("menu:", clicked);
  await new Promise((r) => setTimeout(r, 600));
  const editClicked = await win.webContents.executeJavaScript(`
    (() => {
      const items = [...document.querySelectorAll(".card-menu .menu-item")];
      const edit = items.find((b) => b.textContent.includes("编辑专家"));
      if (!edit) return "no-edit";
      edit.click();
      return "edit-opened";
    })()
  `);
  console.log("edit:", editClicked);
  await new Promise((r) => setTimeout(r, 2000));
  await shoot(win, "edit-dialog-risk.png");

  app.exit(0);
});
