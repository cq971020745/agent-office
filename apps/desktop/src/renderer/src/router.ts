import { createRouter, createWebHashHistory } from "vue-router";
import { getRole, getToken } from "./api";
import AdminView from "./views/AdminView.vue";
import ExpertDetailView from "./views/ExpertDetailView.vue";
import ExpertsView from "./views/ExpertsView.vue";
import HomeView from "./views/HomeView.vue";
import KnowledgeView from "./views/KnowledgeView.vue";
import LoginView from "./views/LoginView.vue";
import ProjectFilesView from "./views/ProjectFilesView.vue";
import TasksView from "./views/TasksView.vue";
import TaskDetailView from "./views/TaskDetailView.vue";

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/login", component: LoginView },
    { path: "/", component: HomeView },
    { path: "/experts", component: ExpertsView },
    { path: "/experts/:id", component: ExpertDetailView },
    { path: "/tasks", component: TasksView },
    { path: "/tasks/:id", component: TaskDetailView },
    { path: "/projects/:taskId/files", component: ProjectFilesView },
    { path: "/kb", component: KnowledgeView },
    { path: "/models", component: AdminView },
    { path: "/admin", component: AdminView },
  ],
});

router.beforeEach((to) => {
  if (to.path === "/login") return getToken() ? "/" : undefined;
  if (!getToken()) return "/login";
  if (to.path === "/admin" && getRole() !== "admin") return "/";
});
