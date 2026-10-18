import { createApp } from "vue";
import App from "./App.vue";
import { router } from "./router";
import { bootstrapTheme } from "./composables/useTheme";
import "./style.css";

// 挂载前应用模式 + 主色，避免首帧闪烁
bootstrapTheme();

createApp(App).use(router).mount("#app");
