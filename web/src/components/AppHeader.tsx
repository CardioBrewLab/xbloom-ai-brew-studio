import { useEffect, useRef, useState } from "react";
import type { AuthSession, CloudStatus } from "../lib/api.js";
import type { InterfaceMode } from "../lib/interface-mode.js";
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
  interfaceMode: InterfaceMode;
  onInterfaceModeChange: (mode: InterfaceMode) => void;
  mobileUi: boolean;
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
  interfaceMode,
  onInterfaceModeChange,
  mobileUi,
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

  if (mobileUi) {
    return (
      <>
        <header className="sticky top-0 z-40 border-b border-[var(--line)] bg-[color-mix(in_srgb,var(--bg-card)_94%,transparent)] backdrop-blur-xl">
          <div className="flex h-14 items-center justify-between gap-2 px-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <BrandMark />
              <div className="min-w-0">
                <h1 className="truncate font-display text-sm font-semibold tracking-[-0.015em] text-[var(--tx-1)]">
                  xBloom Brew Studio
                </h1>
                <p className="truncate text-[10px] text-[var(--tx-3)]">
                  {backendUp ? "服务已连接" : "服务连接中"} ·{" "}
                  {TABS.find((tab) => tab.id === activeTab)?.label}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <XhsAccount expiredAlert={xhsExpired} onClearExpired={onClearXhsExpired} compact />
              {hosted && (
                <button
                  type="button"
                  onClick={onOpenAccount}
                  aria-label={account?.authenticated ? "个人账号" : "注册或登录"}
                  title={account?.authenticated ? account.user?.displayName : "注册或登录"}
                  className="flex h-11 w-11 items-center justify-center rounded-lg border border-[var(--line)] text-[var(--tx-2)]"
                >
                  <IconAccount />
                </button>
              )}
              <button
                type="button"
                onClick={onOpenSettings}
                aria-label="模型接口设置"
                className="flex h-11 w-11 items-center justify-center rounded-lg border border-[var(--line)] text-[var(--tx-2)]"
              >
                <IconSettings />
              </button>
            </div>
          </div>
          <div className="flex items-center justify-between border-t border-[var(--line)] px-3 py-1.5">
            <span className="flex items-center gap-1.5 text-[10px] text-[var(--tx-3)]">
              <StatusDot tone={backendUp ? "ok" : "warn"} pulse={backendUp} />
              {cloud?.loggedIn ? "xBloom App 已登录" : "生成后上传到手机 App"}
            </span>
            <InterfaceModeControl value={interfaceMode} onChange={onInterfaceModeChange} compact />
          </div>
        </header>
        <nav
          aria-label="移动端主导航"
          className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--line)] bg-[color-mix(in_srgb,var(--bg-card)_96%,transparent)] px-[max(0.5rem,env(safe-area-inset-left))] pb-[max(0.35rem,env(safe-area-inset-bottom))] pt-1 backdrop-blur-xl"
        >
          <div className="grid grid-cols-4 gap-1">
            {TABS.map((tab) => {
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => onTabChange(tab.id)}
                  aria-current={active ? "page" : undefined}
                  className={`flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-xl text-[10px] font-medium transition-colors ${
                    active
                      ? "bg-[var(--acc-soft)] text-[var(--acc)]"
                      : "text-[var(--tx-3)] active:bg-[var(--bg-inset)]"
                  }`}
                >
                  <TabIcon tab={tab.id} />
                  <span>
                    {tab.label}
                    {tab.id === "compare" && compareCount > 0 ? ` ${compareCount}` : ""}
                  </span>
                </button>
              );
            })}
          </div>
        </nav>
      </>
    );
  }

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

        <nav aria-label="桌面端主导航" className="min-w-0 flex-1 overflow-x-auto">
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
                  aria-current={active ? "page" : undefined}
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
          <InterfaceModeControl value={interfaceMode} onChange={onInterfaceModeChange} />
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

function BrandMark() {
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--btn-bg)] shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]">
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
  );
}

function InterfaceModeControl({
  value,
  onChange,
  compact = false,
}: {
  value: InterfaceMode;
  onChange: (mode: InterfaceMode) => void;
  compact?: boolean;
}) {
  return (
    <label className="flex items-center gap-1.5 text-[10px] text-[var(--tx-3)]">
      {!compact && <span className="hidden xl:inline">界面</span>}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as InterfaceMode)}
        aria-label="界面版本"
        className={`${compact ? "h-11" : "h-8"} rounded-lg border border-[var(--line)] bg-[var(--bg-card)] px-2 text-[11px] font-medium text-[var(--tx-2)] outline-none`}
      >
        <option value="auto">自动</option>
        <option value="mobile">手机版</option>
        <option value="desktop">电脑版</option>
      </select>
    </label>
  );
}

function TabIcon({ tab }: { tab: AppTab }) {
  const paths: Record<AppTab, string> = {
    workbench: "M4 6h16M7 3v6M17 3v6M5 11h14v9H5z",
    beans: "M12 3c4 0 7 3 7 7s-3 9-7 11c-4-2-7-7-7-11s3-7 7-7Zm0 1c0 7-2 11-6 14",
    cloud: "M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 8a5 5 0 0 0 1 10Z",
    compare: "M8 4H4v16h4M16 4h4v16h-4M9 8l3-3 3 3M12 5v14M9 16l3 3 3-3",
  };
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden
    >
      <path d={paths[tab]} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconAccount() {
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
      <circle cx="12" cy="8" r="3" />
      <path d="M5 20c.7-4 3-6 7-6s6.3 2 7 6" strokeLinecap="round" />
    </svg>
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
