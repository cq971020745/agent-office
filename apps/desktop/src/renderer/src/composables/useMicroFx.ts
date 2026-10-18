/**
 * 微特效：由 html[data-fx="on"] 开关；用 GSAP 做轻量动效。
 * 关闭时立即 kill 所有相关 tween，不留残留 transform。
 */
import gsap from "gsap";
import { onBeforeUnmount, watch, type Ref } from "vue";

const FX_SCOPE = "ao-micro-fx";

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function killScoped(): void {
  gsap.killTweensOf(`[data-fx-anim], .fx-orb, .logo, .brand-name, .theme-panel, .box, .view-enter`);
  document.querySelectorAll<HTMLElement>("[data-fx-anim]").forEach((el) => {
    gsap.set(el, { clearProps: "transform,opacity,filter" });
  });
}

/** 漂浮光斑（FxLayer 内的 .fx-orb） */
function startOrbDrift(): gsap.core.Tween[] {
  const orbs = Array.from(document.querySelectorAll<HTMLElement>(".fx-orb"));
  return orbs.map((orb, i) =>
    gsap.to(orb, {
      x: gsap.utils.random(-48, 48),
      y: gsap.utils.random(-36, 36),
      scale: gsap.utils.random(0.85, 1.2),
      duration: gsap.utils.random(6, 11),
      ease: "sine.inOut",
      yoyo: true,
      repeat: -1,
      delay: i * 0.35,
    })
  );
}

/** Logo / 品牌名轻微呼吸 */
function startBrandBreath(): gsap.core.Tween[] {
  const logos = Array.from(document.querySelectorAll<HTMLElement>(".logo"));
  return logos.map((el) =>
    gsap.to(el, {
      y: -2,
      duration: 2.6,
      ease: "sine.inOut",
      yoyo: true,
      repeat: -1,
    })
  );
}

/** 卡片 / 主按钮悬停抬起（事件委托，避免反复绑定） */
function bindHoverLift(root: HTMLElement): () => void {
  const enter = (e: Event) => {
    // 不碰 .nav-item / RouterLink，避免 transform 干扰侧栏导航点击
    const t = (e.target as HTMLElement | null)?.closest?.(
      "button.primary, .card, .prompt-card, .mode-card"
    ) as HTMLElement | null;
    if (!t || t.dataset.fxHover === "1") return;
    t.dataset.fxHover = "1";
    gsap.to(t, {
      y: -2,
      scale: 1.012,
      duration: 0.22,
      ease: "power2.out",
      overwrite: "auto",
    });
  };
  const leave = (e: Event) => {
    const t = (e.target as HTMLElement | null)?.closest?.(
      "button.primary, .card, .prompt-card, .mode-card"
    ) as HTMLElement | null;
    if (!t) return;
    delete t.dataset.fxHover;
    gsap.to(t, {
      y: 0,
      scale: 1,
      duration: 0.28,
      ease: "power2.out",
      overwrite: "auto",
      clearProps: "transform",
    });
  };
  root.addEventListener("pointerenter", enter, true);
  root.addEventListener("pointerleave", leave, true);
  return () => {
    root.removeEventListener("pointerenter", enter, true);
    root.removeEventListener("pointerleave", leave, true);
  };
}

/** 视图进场：加强 .view-enter */
function enhanceViewEnter(): MutationObserver {
  const run = (el: HTMLElement) => {
    if (el.dataset.fxAnim === "view") return;
    el.dataset.fxAnim = "view";
    gsap.fromTo(
      el,
      { opacity: 0, y: 10, filter: "blur(4px)" },
      {
        opacity: 1,
        y: 0,
        filter: "blur(0px)",
        duration: 0.38,
        ease: "power3.out",
        clearProps: "filter",
      }
    );
  };
  document.querySelectorAll<HTMLElement>(".view-enter").forEach(run);
  const mo = new MutationObserver((list) => {
    for (const m of list) {
      m.addedNodes.forEach((n) => {
        if (!(n instanceof HTMLElement)) return;
        if (n.classList.contains("view-enter")) run(n);
        n.querySelectorAll?.(".view-enter").forEach((c) => run(c as HTMLElement));
      });
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });
  return mo;
}

/** 外观面板打开时的 stagger */
export function playThemePanelIn(panel: HTMLElement): void {
  if (document.documentElement.dataset.fx !== "on" || prefersReducedMotion()) return;
  const bits = panel.querySelectorAll(".block, .panel-head, .mode-card, .swatch, .depth-row, .fx-toggle");
  gsap.fromTo(
    bits,
    { opacity: 0, y: 8 },
    {
      opacity: 1,
      y: 0,
      duration: 0.32,
      stagger: 0.028,
      ease: "power2.out",
      overwrite: "auto",
    }
  );
}

export function useMicroFx(fxEnabled: Ref<boolean>): void {
  let unbindHover: (() => void) | undefined;
  let viewMo: MutationObserver | undefined;
  let running = false;

  function stop(): void {
    running = false;
    unbindHover?.();
    unbindHover = undefined;
    viewMo?.disconnect();
    viewMo = undefined;
    killScoped();
  }

  function start(): void {
    if (running || prefersReducedMotion()) return;
    running = true;
    startOrbDrift();
    startBrandBreath();
    unbindHover = bindHoverLift(document.body);
    viewMo = enhanceViewEnter();
  }

  watch(
    fxEnabled,
    (on) => {
      stop();
      if (on) start();
    },
    { immediate: true }
  );

  onBeforeUnmount(stop);

  // 标记作用域，便于调试
  document.documentElement.dataset.fxScope = FX_SCOPE;
}
