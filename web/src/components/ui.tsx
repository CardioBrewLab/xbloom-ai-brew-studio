/**
 * 共享 UI 基元：卡片、分区标题、输入控件、按钮、状态灯、Modal、Toggle、Slider、空状态。
 * 全部基于 index.css 中的主题变量（亮色默认 / 暗色可选），不写死色值。
 * 规范：控件 44px / 圆角 8；卡片 12px；弹层 16px；主按钮黑白系。
 */
import { useEffect, type CSSProperties, type ReactNode } from "react";

/** 输入控件统一样式：高 44px、白底 1px 描边、focus 黑色边框 + 3px 黑色 8% 光环 */
export const inputCls =
  "h-11 w-full rounded-lg border border-[var(--line)] bg-[var(--bg-card)] px-3.5 text-sm text-[var(--tx-1)] " +
  "placeholder:text-[var(--tx-3)] outline-none transition-[border-color,box-shadow] duration-150 " +
  "hover:border-[var(--line-strong)] focus:border-[var(--tx-1)] focus:ring-[3px] focus:ring-[var(--ring)]";

/** 主按钮：黑底白字（暗色反白），hover 上浮 1px + 金光（任务 #108） */
export const btnPrimary =
  "inline-flex h-12 items-center justify-center gap-2 rounded-lg bg-[var(--btn-bg)] px-5 text-sm font-medium " +
  "text-[var(--btn-fg)] transition-all duration-150 ease-out " +
  "hover:bg-[var(--btn-bg-hover)] hover:-translate-y-px hover:shadow-[0_8px_24px_-12px_var(--acc-glow)] " +
  "active:translate-y-0 disabled:pointer-events-none disabled:opacity-40";

/** 小号主按钮（黑色）：弹层内"新建"等场景 */
export const btnPrimarySm =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-[var(--btn-bg)] px-3.5 text-xs font-medium " +
  "text-[var(--btn-fg)] transition-all duration-150 ease-out hover:bg-[var(--btn-bg-hover)] hover:-translate-y-px " +
  "active:translate-y-0 disabled:pointer-events-none disabled:opacity-40";

/** 次级按钮：白底 1px 描边，hover 加深底色 */
export const btnGhost =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-[var(--line-strong)] " +
  "bg-[var(--bg-card)] px-3.5 text-xs font-medium text-[var(--tx-2)] transition-colors duration-150 " +
  "hover:bg-[var(--bg-inset)] disabled:pointer-events-none disabled:opacity-40";

/** 文字按钮：hover 下划线 */
export const btnText =
  "inline-flex items-center gap-1 text-xs font-medium text-[var(--tx-2)] underline-offset-4 " +
  "transition-colors duration-150 hover:text-[var(--tx-1)] hover:underline " +
  "disabled:pointer-events-none disabled:opacity-40";

/** 语义成功按钮（已发布 / 云端同步） */
export const btnSage =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-[color-mix(in_srgb,var(--ok)_40%,transparent)] " +
  "bg-[var(--sage-soft)] px-3.5 text-xs font-medium text-[var(--sage-deep)] transition-colors duration-150 " +
  "hover:bg-[color-mix(in_srgb,var(--ok)_16%,transparent)] disabled:pointer-events-none disabled:opacity-40";

/** 危险按钮 */
export const btnDanger =
  "inline-flex h-9 items-center justify-center rounded-lg border border-[color-mix(in_srgb,var(--bad)_40%,transparent)] " +
  "px-3.5 text-xs text-[var(--bad)] transition-colors duration-150 " +
  "hover:bg-[color-mix(in_srgb,var(--bad)_10%,transparent)]";

/** 小徽标 */
export const chipCls =
  "inline-flex items-center gap-1 rounded-full border border-[var(--line)] bg-[var(--bg-inset)] " +
  "px-2 py-0.5 text-[11px] leading-4 text-[var(--tx-2)]";

export function Card({
  children,
  className = "",
  style,
}: {
  children: ReactNode;
  className?: string;
  /** 供结果揭示 stagger 等场景传 animationDelay（任务 #108 P2） */
  style?: CSSProperties;
}) {
  return (
    <section
      className={
        "card-surface animate-fade-up rounded-xl border border-[var(--line)] bg-[var(--bg-card)] " +
        "transition-[background-color,border-color] duration-150 " +
        className
      }
      style={style}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  icon,
  title,
  sub,
  right,
}: {
  icon?: ReactNode;
  title: string;
  sub?: string;
  right?: ReactNode;
}) {
  return (
    <header className="flex min-h-14 items-center justify-between gap-3 border-b border-[var(--line)] px-4 py-3">
      <div className="flex items-center gap-2.5">
        {icon && <span className="text-[var(--tx-3)]">{icon}</span>}
        <div>
          <h2 className="font-display text-sm font-semibold leading-5 tracking-[-0.01em] text-[var(--tx-1)]">
            {title}
          </h2>
          {sub && <p className="mt-0.5 text-xs leading-4 text-[var(--tx-3)]">{sub}</p>}
        </div>
      </div>
      {right}
    </header>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-baseline justify-between text-[13px] font-medium leading-4 text-[var(--tx-2)]">
        {label}
        {hint && <span className="text-[11px] font-normal text-[var(--tx-3)]">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

/** 状态灯：ok=绿、warn=金、off=灰、bad=红（无光晕） */
export function StatusDot({
  tone,
  pulse = false,
}: {
  tone: "ok" | "warn" | "off" | "bad";
  pulse?: boolean;
}) {
  const color = {
    ok: "bg-[var(--ok)]",
    warn: "bg-[var(--warn)]",
    bad: "bg-[var(--bad)]",
    off: "bg-[var(--tx-3)]",
  }[tone];
  return (
    <span className="relative inline-flex h-2 w-2">
      {pulse && (
        <span
          className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-50 ${color}`}
        />
      )}
      <span className={`relative inline-flex h-2 w-2 rounded-full ${color}`} />
    </span>
  );
}

/** 环形 spinner：16px / 2px 边 / 0.6s */
export function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`h-4 w-4 animate-spin [animation-duration:0.6s] ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path
        d="M22 12a10 10 0 0 0-10-10"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** 开关：选中态为黑色（暗色反白） */
export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-[22px] w-10 shrink-0 items-center rounded-full border transition-colors duration-150 ${
        checked
          ? "border-[var(--btn-bg)] bg-[var(--btn-bg)]"
          : "border-[var(--line-strong)] bg-[var(--bg-inset)]"
      }`}
    >
      <span
        className={`absolute h-4 w-4 rounded-full transition-all duration-150 ${
          checked ? "left-[22px] bg-[var(--btn-fg)]" : "left-1 bg-[var(--tx-3)]"
        }`}
      />
    </button>
  );
}

/** 带填充进度的滑杆（--fill 变量驱动轨道着色） */
export function Slider({
  min,
  max,
  step = 1,
  value,
  onChange,
  disabled,
}: {
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  const fill = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <input
      type="range"
      className="xslider disabled:opacity-40"
      style={{ ["--fill" as never]: `${fill}%` }}
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}

/** 模态框（任务 #108 P2）：遮罩 blur + 240ms 淡入；卡片 translateY(8px) scale(0.98) 入场 ease-lux；圆角 16 */
export function Modal({
  open,
  onClose,
  title,
  sub,
  children,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  sub?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="animate-veil-in fixed inset-0 z-50 flex items-center justify-center bg-[rgba(10,8,6,0.5)] p-4 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`animate-modal-in card-surface max-h-[88vh] w-full overflow-y-auto rounded-2xl border border-[var(--line)] bg-[var(--bg-card)] ${
          wide ? "max-w-3xl" : "max-w-lg"
        }`}
        role="dialog"
        aria-modal="true"
      >
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-[var(--line)] bg-[var(--bg-card)] px-6 py-4">
          <div>
            {/* Modal 标题（任务 #108 P1）：display-2 展示衬线 */}
            <h3 className="font-display text-xl font-semibold tracking-[-0.01em] text-[var(--tx-1)]">
              {title}
            </h3>
            {sub && <p className="mt-0.5 text-xs text-[var(--tx-3)]">{sub}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--line)] text-[var(--tx-3)] transition-colors duration-150 hover:bg-[var(--bg-inset)] hover:text-[var(--tx-1)]"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden
            >
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}

/** 空状态统一模板：40px 单色线性图标 + 主文案 + 解释 + 次级动作 */
export function EmptyState({
  icon,
  title,
  desc,
  action,
}: {
  icon: ReactNode;
  title: string;
  desc?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 p-12 text-center">
      <span className="text-[var(--tx-3)]">{icon}</span>
      <p className="text-sm font-medium text-[var(--tx-1)]">{title}</p>
      {desc && <p className="max-w-sm text-xs leading-relaxed text-[var(--tx-2)]">{desc}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
