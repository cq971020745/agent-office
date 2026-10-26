import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    // dev 端口避开 Vite 默认的 5173，防止和其他前端项目抢端口
    server: { port: 38618 },
    build: {
      rollupOptions: {
        output: {
          // 分片产出：单 chunk 控制在 1MB 内。本机 esbuild 服务对 >1.1MB 的
          // 单次转换输入会崩（vite:esbuild-transpile 报 remove temp: Access is denied，
          // 已用 esbuild 0.25.12 JS API 直接复现），整包 1.1MB+ 时构建必挂
          manualChunks(id: string) {
            if (!id.includes("node_modules")) return undefined;
            if (/[\\/](@vue|vue-router|vue)[\\/]/.test(id)) return "vendor-vue";
            if (id.includes("gsap")) return "vendor-gsap";
            return "vendor-misc";
          },
        },
      },
    },
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
