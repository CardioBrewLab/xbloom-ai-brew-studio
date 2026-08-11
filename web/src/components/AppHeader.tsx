import { useEffect, useRef, useState } from "react";
import type { AuthSession, CloudStatus } from "../lib/api.js";
import XhsAccount from "./XhsAccount.js";
import { StatusDot } from "./ui.js";

export type AppTab = "workbench" | "beans" | "cloud" | "compare";

const TABS: { id: AppTab; label: string }[] = [
  { id: "workbench", label: "工作台" },
  { id: "beans", label: "豆库" },
  { id: "cloud", label: "云端配方" },
  { id: "compare", label: "对比" },
];

export interface AppHeaderProps {
  activeTab: AppTab;
  onTabChange: (tab: AppTab) => void;
  compareCount: number;
  backendUp: boolean;
  cloud: CloudStatus | null;
  xhsExpired: boolean;
  onClearXhsExpired: () => void;
  onOpenSettings: () => void;
  hosted: boolean;
  account: AuthSession | null;
  onOpenAccount: () => void;
  theme: "dark" | "light";
  onToggleTheme: () => void;
}

/** Stable desktop chrome kept separate from the recipe orchestration component. */
export default function AppHeader({
  activeTab,
  onTabChange,
  compareCount,
  backendUp,
  cloud,
  xhsExpired,
  onClearXhsExpired,
  onOpenSettings,
  hosted,
  account,
  onOpenAccount,
  theme,
  onToggleTheme,
}: AppHeaderProps) {
  const tabButtonRefs = useRef<Partial<Record<AppTab, HTMLButtonElement | null>>>({});
  const [tabInk, setTabInk] = useState<{ left: number; width: number } | null>(null);

  useEffect(() => {
    const update = () => {
      const element = tabButtonRefs.current[activeTab];
      if (element) {
        setTabInk({ left: element.offsetLeft + 12, width: Math.max(0, element.offsetWidth - 24) });
      }
    };
    update();
    document.fonts?.ready.then(update).catch(() => undefined);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [activeTab]);

  return (
    <header className="sticky top-0 z-40 border-b border-[var(--line)] bg-[color-mix(in_srgb,var(--bg-card)_92%,transparent)] backdrop-blur-xl">
      <div className="flex h-14 w-full items-center justify-between gap-4 px-4">
        <div className="flex shrink-0 items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--btn-bg)] shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--btn-fg)"
              strokeWidth="1.7"
              aria-hidden
            >
              <path
                d="M5 11h11v5a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4v-5zM16 12h1.5a2.5 2.5 0 0 1 0 5H16"
                strokeLinecap="round"
              />
              <path
                d="M9 7c0-1.2 1-1.5 1-2.5M12.5 7c0-1.2 1-1.5 1-2.5"
                strokeLinecap="round"
                opacity="0.6"
              />
            </svg>
          </div>
          <h1 className="font-display text-sm font-semibold tracking-[-0.015em] text-[var(--tx-1)]">
            xBloom <span className="font-medium text-[var(--tx-3)]">Brew Studio</span>
          </h1>
        </div>

        <nav className="min-w-0 flex-1 overflow-x-auto">
          <div className="relative mx-auto flex w-fit items-center gap-0.5 rounded-lg border border-[var(--line)] bg-[var(--bg-inset)] p-0.5">
            {TABS.map((tab) => {
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  ref={(element) => {
                    tabButtonRefs.current[tab.id] = element;
                  }}
                  onClick={() => onTabChange(tab.id)}
                  className={`relative shrink-0 rounded-md px-3 py-1.5 text-xs font-medium transition-colors duration-150 ${
                    active
                      ? "bg-[var(--bg-card)] text-[var(--tx-1)] shadow-sm"
                      : "text-[var(--tx-3)] hover:text-[var(--tx-1)]"
                  }`}
                >
                  {tab.label}
                  {tab.id === "compare" && compareCount > 0 && (
                    <span className="tnum ml-1 text-[var(--acc)]">{compareCount}</span>
                  )}
                </button>
              );
            })}
            {tabInk && (
              <span
                aria-hidden
                className="absolute -bottom-[3px] h-0.5 rounded-full bg-[var(--acc)] transition-[left,width] duration-200 [transition-timing-function:var(--ease-snap)]"
                style={{ left: tabInk.left, width: tabInk.width }}
              />
            )}
          </div>
        </nav>

        <div className="flex shrink-0 items-center gap-2 text-[11px] text-[var(--tx-3)]">
          <span className="hidden items-center gap-3 rounded-lg border border-[var(--line)] bg-[var(--bg-inset)] px-2.5 py-1.5 lg:flex">
            <span className="flex items-center gap-1.5">
              <StatusDot tone={backendUp ? "ok" : "bad"} pulse={backendUp} />
              {hosted ? "云端" : "本地"}
              {backendUp ? "已连接" : "已离线"}
            </span>
            <span className="h-3 w-px bg-[var(--line-strong)]" aria-hidden />
            <span className="flex items-center gap-1.5">
              <StatusDot
                tone={!cloud ? "off" : cloud.loggedIn ? "ok" : cloud.reachable ? "warn" : "bad"}
                pulse={cloud?.loggedIn ?? false}
              />
              xBloom{" "}
              {!cloud
                ? "检测中"
                : cloud.loggedIn
                  ? "已登录"
                  : cloud.workspaceLoginRequired
                    ? "先登录工作台"
                    : cloud.reachable
                      ? "待登录"
                      : "离线"}
            </span>
          </span>
          <span className="hidden md:block">
            <XhsAccount expiredAlert={xhsExpired} onClearExpired={onClearXhsExpired} />
          </span>
          {hosted && (
            <button
              type="button"
              onClick={onOpenAccount}
              className="hidden h-8 max-w-28 items-center rounded-lg border border-[var(--line)] px-2.5 text-xs font-medium text-[var(--tx-2)] transition-colors hover:border-[var(--line-strong)] hover:text-[var(--tx-1)] sm:flex"
              title={account?.authenticated ? "个人账号" : "注册或登录"}
            >
              <span className="truncate">
                {account?.authenticated ? account.user?.displayName : "登录"}
              </span>
            </button>
          )}
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label="模型接口设置"
            title="模型接口设置"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--line)] text-[var(--tx-2)] transition-colors duration-150 hover:border-[var(--line-strong)] hover:bg-[var(--bg-inset)] hover:text-[var(--tx-1)]"
          >
            <IconSettings />
          </button>
          <button
            type="button"
            onClick={onToggleTheme}
            aria-label="切换主题"
            title={theme === "dark" ? "切换到亮色主题" : "切换到暗色主题"}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--line)] text-[var(--tx-2)] transition-colors duration-150 hover:border-[var(--line-strong)] hover:bg-[var(--bg-inset)] hover:text-[var(--tx-1)]"
          >
            {theme === "dark" ? <IconSun /> : <IconMoon />}
          </button>
        </div>
      </div>
    </header>
  );
}

function IconSun() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden
    >
      <circle cx="12" cy="12" r="4" />
      <path
        d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconMoon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden
    >
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" strokeLinejoin="round" />
    </svg>
  );
}

function IconSettings() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden
    >
      <circle cx="12" cy="12" r="3" />
      <path
        d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H9.6v-.1A1.7 1.7 0 0 0 8 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 3.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H2V9.6h.1A1.7 1.7 0 0 0 3.6 8a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 8 3.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V2h4v.1A1.7 1.7 0 0 0 15 3.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 8a1.7 1.7 0 0 0 .6 1 1.7 1.7 0 0 0 1.1.4h.1v4h-.1a1.7 1.7 0 0 0-1.7 1.6Z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
