/**
 * 豆选择器（自定义 combobox，替代原生 select）：
 * - 触发器 = 标准控件 + chevron；空值显示"选择或输入豆子"
 * - 弹层：顶部搜索框 / 选项 44px（豆名 + 烘焙度徽章 + 选中黑色 check）
 * - 弹层底部固定"手动输入"区：input + 黑色"新建"按钮 —— 不选豆库也能手打豆子信息
 * - 豆库为空时显示虚线框空状态（线性咖啡豆图标 + "去豆库添加"）
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Bean } from "../lib/api.js";
import { btnGhost, btnPrimarySm, inputCls } from "./ui.js";

export interface BeanComboboxProps {
  beans: Bean[];
  /** 选中的豆库豆 ID；"" 表示未选中 */
  value: string;
  onSelect: (beanId: string) => void;
  /** 手动填写的豆子信息文本 */
  manualText: string;
  /** 手动输入提交（同时清除选中豆） */
  onManual: (text: string) => void;
  /** 跳转豆库管理页 */
  onOpenBeans: () => void;
}

export default function BeanCombobox({
  beans,
  value,
  onSelect,
  manualText,
  onManual,
  onOpenBeans,
}: BeanComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState(manualText);
  const rootRef = useRef<HTMLDivElement>(null);

  const selected = beans.find((b) => b.id === value) ?? null;

  // 同步外部手动文本（如高级选项里编辑过）
  useEffect(() => {
    setDraft(manualText);
  }, [manualText]);

  // 点击外部 / ESC 关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return beans;
    return beans.filter((b) =>
      [b.name, b.roaster, b.origin, b.process, b.roastLevel, b.tastingNotes]
        .filter(Boolean)
        .some((s) => (s as string).toLowerCase().includes(q)),
    );
  }, [beans, query]);

  const submitManual = () => {
    const text = draft.trim();
    if (!text) return;
    onManual(text);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      {/* 触发器 */}
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
          setQuery("");
        }}
        className={`${inputCls} flex items-center justify-between gap-2 text-left ${
          open ? "border-[var(--tx-1)] ring-[3px] ring-[var(--ring)]" : ""
        }`}
      >
        {selected ? (
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[var(--tx-1)]">{selected.name}</span>
            {selected.roastLevel && (
              <span className="shrink-0 rounded-full border border-[var(--acc-line)] bg-[var(--acc-soft)] px-2 py-0.5 text-[11px] leading-4 text-[var(--acc)]">
                {selected.roastLevel}
              </span>
            )}
          </span>
        ) : manualText.trim() ? (
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[var(--tx-1)]">{manualText}</span>
            <span className="shrink-0 rounded-full border border-[var(--line-strong)] bg-[var(--bg-inset)] px-2 py-0.5 text-[11px] leading-4 text-[var(--tx-3)]">
              手动
            </span>
          </span>
        ) : (
          <span className="truncate text-[var(--tx-3)]">选择或输入豆子</span>
        )}
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--tx-3)"
          strokeWidth="1.8"
          aria-hidden
          className={`shrink-0 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
        >
          <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {/* 弹层 */}
      {open && (
        <div
          className="animate-pop-in absolute inset-x-0 top-[calc(100%+6px)] z-30 overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--bg-card)] shadow-[var(--shadow-pop)]"
          role="listbox"
        >
          {/* 搜索框 */}
          <div className="border-b border-[var(--line)] p-2">
            <div className="relative">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--tx-3)"
                strokeWidth="1.8"
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="M20 20l-3.5-3.5" strokeLinecap="round" />
              </svg>
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索豆名 / 产地 / 风味…"
                className="h-9 w-full rounded-lg border border-transparent bg-[var(--bg-inset)] pl-9 pr-3 text-[13px] text-[var(--tx-1)] outline-none placeholder:text-[var(--tx-3)] focus:border-[var(--line)] focus:bg-[var(--bg-card)]"
              />
            </div>
          </div>

          {/* 选项列表 */}
          {beans.length === 0 ? (
            <div className="p-3">
              <div className="flex flex-col items-center gap-2.5 rounded-lg border border-dashed border-[var(--line-strong)] px-4 py-8 text-center">
                <svg
                  width="40"
                  height="40"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="var(--tx-3)"
                  strokeWidth="1.5"
                  aria-hidden
                >
                  <ellipse cx="12" cy="12" rx="7" ry="9" transform="rotate(35 12 12)" />
                  <path d="M8.5 6.5c3 3.5 4 7.5 7 11" strokeLinecap="round" />
                </svg>
                <p className="text-[13px] font-medium text-[var(--tx-1)]">豆库还是空的</p>
                <p className="text-[11px] leading-relaxed text-[var(--tx-2)]">
                  录入常喝的豆子，下次一键带入；也可以直接在下方手动输入
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onOpenBeans();
                  }}
                  className={btnGhost}
                >
                  去豆库添加
                </button>
              </div>
            </div>
          ) : (
            <ul className="max-h-[320px] overflow-y-auto py-1">
              {/* 清空选择项 */}
              <li>
                <button
                  type="button"
                  onClick={() => {
                    onSelect("");
                    setOpen(false);
                  }}
                  className={`flex h-11 w-full items-center justify-between px-3.5 text-left text-[13px] transition-colors duration-150 hover:bg-[var(--bg-inset)] ${
                    !value && !manualText.trim() ? "text-[var(--tx-1)]" : "text-[var(--tx-3)]"
                  }`}
                >
                  不指定豆子
                  {!value && !manualText.trim() && <IconCheck />}
                </button>
              </li>
              {filtered.map((b) => {
                const active = b.id === value;
                return (
                  <li key={b.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={active}
                      onClick={() => {
                        onSelect(b.id);
                        setOpen(false);
                      }}
                      className={`flex h-11 w-full items-center justify-between gap-2 px-3.5 text-left transition-colors duration-150 hover:bg-[var(--bg-inset)] ${
                        active ? "text-[var(--tx-1)]" : "text-[var(--tx-2)]"
                      }`}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-[13px] font-medium">{b.name}</span>
                        {b.roastLevel && (
                          <span className="shrink-0 rounded-full border border-[var(--acc-line)] bg-[var(--acc-soft)] px-2 py-0.5 text-[11px] leading-4 text-[var(--acc)]">
                            {b.roastLevel}
                          </span>
                        )}
                      </span>
                      {active && <IconCheck />}
                    </button>
                  </li>
                );
              })}
              {filtered.length === 0 && (
                <li className="px-3.5 py-6 text-center text-xs text-[var(--tx-3)]">
                  没有匹配的豆子，可在下方手动输入
                </li>
              )}
            </ul>
          )}

          {/* 底部固定：手动输入区 */}
          <div className="border-t border-[var(--line)] bg-[var(--bg-inset)] p-3">
            <p className="mb-1.5 text-[11px] font-medium tracking-[0.06em] text-[var(--tx-3)]">
              手动输入 · 无需选豆库
            </p>
            <div className="flex gap-2">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitManual()}
                placeholder="埃塞俄比亚 · 水洗 · 浅烘"
                className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--line)] bg-[var(--bg-card)] px-3 text-[13px] text-[var(--tx-1)] outline-none placeholder:text-[var(--tx-3)] focus:border-[var(--tx-1)] focus:ring-[3px] focus:ring-[var(--ring)]"
              />
              <button
                type="button"
                onClick={submitManual}
                disabled={!draft.trim()}
                className={`${btnPrimarySm} shrink-0`}
              >
                新建
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function IconCheck() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--tx-1)"
      strokeWidth="2"
      aria-hidden
      className="shrink-0"
    >
      <path d="M5 12.5l4.5 4.5L19 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
