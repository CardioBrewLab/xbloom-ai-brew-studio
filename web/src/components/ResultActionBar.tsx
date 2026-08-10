/** 结果后的主动作集中区：突出“电脑生成 → 手机 xBloom App 使用”的最短路径。 */
import { btnGhost, btnPrimary, btnSage, Card } from "./ui.js";

export interface ResultActionBarProps {
  recipeName: string;
  canBrew: boolean;
  saving: boolean;
  saved: boolean;
  cloudLoggedIn: boolean;
  cloudTableId?: string;
  onUpload: () => void;
  onBrew: () => void;
  onSave: () => void;
  onEditInput: () => void;
}

export default function ResultActionBar({
  recipeName,
  canBrew,
  saving,
  saved,
  cloudLoggedIn,
  cloudTableId,
  onUpload,
  onBrew,
  onSave,
  onEditInput,
}: ResultActionBarProps) {
  return (
    <Card className="overflow-hidden border-[var(--line-strong)]">
      <div className="flex flex-col gap-4 p-4 2xl:flex-row 2xl:items-center 2xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-base font-semibold tracking-[-0.015em] text-[var(--tx-1)]">
              {recipeName}
            </h2>
            <span className="rounded-full border border-[var(--line)] bg-[var(--bg-inset)] px-2 py-0.5 text-[10px] text-[var(--tx-3)]">
              {cloudTableId ? "已上传" : cloudLoggedIn ? "云端已连接" : "上传时登录"}
            </span>
          </div>
          <p className="mt-1 text-xs leading-5 text-[var(--tx-3)]">
            电脑端整理好配方，上传后在手机 xBloom App 里直接使用。
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button type="button" onClick={onUpload} className={`${btnPrimary} h-10`}>
            <IconUpload />
            {cloudTableId ? "更新到手机 xBloom App" : "上传到手机 xBloom App"}
          </button>
          <button type="button" onClick={onBrew} disabled={!canBrew} className={btnSage}>
            <IconPlay /> 打开冲煮引导
          </button>
          <button type="button" onClick={onSave} disabled={saving || saved} className={btnGhost}>
            <IconSave /> {saving ? "保存中…" : saved ? "已保存" : "保存到本地"}
          </button>
          <button type="button" onClick={onEditInput} className={btnGhost}>
            修改输入
          </button>
        </div>
      </div>
    </Card>
  );
}

function IconUpload() {
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
      <path
        d="M12 16V4M7.5 8.5 12 4l4.5 4.5M5 14v5h14v-5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconPlay() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 5.5v13a1 1 0 0 0 1.53.85l10.2-6.5a1 1 0 0 0 0-1.7L9.53 4.65A1 1 0 0 0 8 5.5z" />
    </svg>
  );
}

function IconSave() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden
    >
      <path d="M5 4h12l2 2v14H5zM8 4v6h8V4M8 20v-6h8v6" strokeLinejoin="round" />
    </svg>
  );
}
