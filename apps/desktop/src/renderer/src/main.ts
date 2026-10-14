import { createApp } from "vue";
import App from "./App.vue";
import { router } from "./router";
import "./style.css";

// 挂载前应用持久化主题，避免首帧闪烁
const savedTheme = localStorage.getItem("agent-office-theme");
if (savedTheme === "dark" || savedTheme === "light") {
  document.documentElement.dataset.theme = savedTheme;
}

createApp(App).use(router).mount("#app");
