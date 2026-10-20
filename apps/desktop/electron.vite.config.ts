import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    // dev 端口避开 Vite 默认的 5173，防止和其他前端项目抢端口
    server: { port: 38618 },
    plugins: [
      vue({
        template: {
          compilerOptions: {
            // Electron <webview> 是原生自定义元素，勿当 Vue 组件解析
            isCustomElement: (tag) => tag === "webview",
          },
        },
      }),
    ],
  },
});
