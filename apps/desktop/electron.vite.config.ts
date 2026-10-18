import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
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
