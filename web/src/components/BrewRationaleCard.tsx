/**
 * 方案解读卡（任务 #72）：逐条展示 brewRationale（param → choice → basis）。
 * - 样式与 VariantCompareCard 的改进依据卡片（NoteCard）对齐，复用既有 CSS 变量令牌，
 *   暗色模式零适配成本；
 * - 空态兼容：无条目时由调用方不渲染本组件（组件内部亦做兜底返回 null）。
 */
import type { BrewRationaleItem } from "../lib/api.js";
import { Card, CardHeader } from "./ui.js";

export default function BrewRationaleCard({ items }: { items: BrewRationaleItem[] }) {
  if (!items || items.length === 0) return null;
  return (
    <Card className="overflow-hidden">
      <CardHeader
        icon={<IconRationale />}
        title="方案解读"
        sub={`${items.length} 项关键选择 · 依据来源逐条标注`}
      />
      <div className="p-5">
        <ol className="space-y-2.5">
          {items.map((item, i) => (
            <RationaleRow key={`${item.param}-${i}`} item={item} index={i + 1} />
          ))}
        </ol>
      </div>
    </Card>
  );
}

/** 单条解读：编号徽章 + 参数名 → 选择值（强调色）+ 依据（注明来源） */
function RationaleRow({ item, index }: { item: BrewRationaleItem; index: number }) {
  return (
    <li className="relative overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--bg-inset)] px-4 py-3">
      {/* 顶部渐变细线（与 NoteCard 同款克制点缀，暗色随令牌自适应） */}
      <span
        className="absolute inset-x-0 top-0 h-px"
        style={{
          backgroundImage:
            "linear-gradient(90deg, transparent, color-mix(in srgb, var(--acc) 55%, transparent), transparent)",
        }}
        aria-hidden
      />
      <div className="flex items-start gap-3">
        <span className="tnum mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[var(--acc-line)] bg-[var(--acc-soft)] text-[10px] font-semibold text-[var(--acc)]">
          {index}
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="tnum text-xs font-medium text-[var(--tx-1)]">
            {item.param}
            <span className="mx-1.5 text-[var(--tx-3)]">→</span>
            <span className="text-[var(--acc)]">{item.choice}</span>
          </p>
          <p className="text-[11px] leading-relaxed text-[var(--tx-2)]">{item.basis}</p>
        </div>
      </div>
    </li>
  );
}

function IconRationale() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M9.6 9.2a2.4 2.4 0 1 1 3.3 2.2c-.7.3-.9.8-.9 1.6" strokeLinecap="round" />
      <circle cx="12" cy="16.4" r="0.4" fill="currentColor" stroke="none" />
    </svg>
  );
}
