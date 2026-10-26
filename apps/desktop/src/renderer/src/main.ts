import { createApp } from "vue";
import App from "./App.vue";
import { router } from "./router";
import { bootstrapTheme } from "./composables/useTheme";
import { bootstrapSkin } from "./composables/useSkin";
import { getServerBase } from "./api";
import "./style.css";

/** 配置了中心服务端时，把该源动态加进 CSP 的四个指令（首次加载的资源不受影响，后续 API/iframe/字体即可用） */
function bootstrapCspForServer(): void {
  const base = getServerBase();
  if (base === "http://127.0.0.1:38617" || base === "http://localhost:38617") return;
  const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  if (!meta) return;
  const content = meta.getAttribute("content") ?? "";
  meta.setAttribute(
    "content",
    content.replace(/(connect-src|img-src|frame-src|font-src)([^;]*)/g, `$1$2 ${base}`)
  );
}

bootstrapCspForServer();
// 挂载前应用模式 + 主色，避免首帧闪烁
bootstrapTheme();
// 皮肤包是异步拉取的覆盖层，不阻塞首帧
bootstrapSkin();

createApp(App).use(router).mount("#app");
