import { Modal } from "./ui.js";

export const MODEL_API_INVITE_URL = "https://llm.mathmodel.tech/sign-up?aff=NmPu";
export const SUPPORT_QR_PATH = "/support/wechat-support-qr.jpg";

export interface SupportProjectModalProps {
  open: boolean;
  onClose: () => void;
}

export default function SupportProjectModal({ open, onClose }: SupportProjectModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="支持这个项目" sub="免费开源，也由个人持续维护">
      <div className="space-y-4">
        <section className="rounded-xl border border-[var(--line)] bg-[var(--bg-inset)] p-4 sm:p-5">
          <p className="text-[11px] font-medium tracking-[0.12em] text-[var(--tx-3)]">模型 API</p>
          <h4 className="mt-2 font-display text-base font-semibold text-[var(--tx-1)]">
            需要模型接口，可以从这里注册
          </h4>
          <p className="mt-1.5 text-xs leading-5 text-[var(--tx-3)]">
            这是项目邀请链接。通过它注册可能为项目带来返利，具体服务和价格以平台页面为准。
          </p>
          <a
            href={MODEL_API_INVITE_URL}
            target="_blank"
            rel="sponsored noopener noreferrer"
            className="mt-4 inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-[var(--btn-bg)] px-4 text-xs font-medium text-[var(--btn-fg)] transition-all duration-150 hover:-translate-y-px hover:bg-[var(--btn-bg-hover)]"
          >
            打开邀请注册链接
            <ExternalLinkIcon />
          </a>
        </section>

        <section className="grid gap-4 rounded-xl border border-[var(--line)] bg-[var(--bg-card)] p-4 sm:grid-cols-[1fr_210px] sm:items-center sm:p-5">
          <div>
            <p className="text-[11px] font-medium tracking-[0.12em] text-[var(--tx-3)]">
              请我喝杯咖啡
            </p>
            <h4 className="mt-2 font-display text-base font-semibold text-[var(--tx-1)]">
              如果它刚好帮你省了点时间
            </h4>
            <p className="mt-1.5 text-xs leading-5 text-[var(--tx-3)]">
              扫码即可自愿支持。项目的全部功能与是否支持无关。
            </p>
          </div>
          <div className="mx-auto w-full max-w-[210px] overflow-hidden rounded-xl border border-[var(--line)] bg-white p-2 shadow-sm">
            <img
              src={SUPPORT_QR_PATH}
              alt="微信支持项目收款二维码"
              width="828"
              height="1124"
              loading="lazy"
              decoding="async"
              className="block h-auto w-full rounded-lg"
            />
          </div>
        </section>

        <p className="px-1 text-[11px] leading-5 text-[var(--tx-3)]">
          xBloom AI Brew Studio 是独立的非官方开源项目，支持行为不会获得额外功能或优先服务。
        </p>
      </div>
    </Modal>
  );
}

function ExternalLinkIcon() {
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
      <path d="M14 5h5v5M11 13l8-8M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
    </svg>
  );
}
