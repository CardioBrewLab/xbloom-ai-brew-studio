/**
 * 错误边界：捕获子树渲染异常，避免单组件崩溃导致整站白屏。
 * 崩溃时渲染友好卡片（"界面开小差了" + 重试），并提供就地恢复与整页重载两条路径。
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** 可选：自定义回退 UI（不传则使用内置卡片） */
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // 保留控制台诊断信息，便于开发期定位
    console.error("[ErrorBoundary] 渲染异常已被捕获：", error, info.componentStack);
  }

  private recover = () => {
    this.setState({ hasError: false });
  };

  private reload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    if (this.props.fallback) return this.props.fallback;

    return (
      <div className="flex min-h-[40vh] items-center justify-center px-6 py-16">
        <div className="animate-fade-up w-full max-w-md rounded-2xl border border-[var(--line)] bg-[var(--bg-card)] p-8 text-center shadow-[0_24px_60px_-32px_rgba(0,0,0,0.25)]">
          {/* 插画：倾倒的咖啡杯 —— 界面"洒"了一下 */}
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--acc-soft)]">
            <svg
              width="26"
              height="26"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--acc)"
              strokeWidth="1.6"
              aria-hidden
            >
              <g transform="rotate(-14 12 12)">
                <path
                  d="M5 11h11v5a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4v-5zM16 12h1.5a2.5 2.5 0 0 1 0 5H16"
                  strokeLinecap="round"
                />
                <path
                  d="M9 7c0-1.2 1-1.5 1-2.5M12.5 7c0-1.2 1-1.5 1-2.5"
                  strokeLinecap="round"
                  opacity="0.6"
                />
              </g>
            </svg>
          </div>

          <h2 className="font-display text-[20px] font-semibold tracking-[-0.01em] text-[var(--tx-1)]">
            界面开小差了
          </h2>
          <p className="mt-2 text-xs leading-relaxed text-[var(--tx-3)]">
            冲煮曲线画到一半打了个盹。你的配方数据没有丢失，
            <br />
            重试一下就能继续。
          </p>

          <div className="mt-6 flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={this.recover}
              className="rounded-lg border border-[var(--line-strong)] px-4 py-2 text-xs font-medium text-[var(--tx-2)] transition-colors duration-150 hover:bg-[var(--bg-inset)] hover:text-[var(--tx-1)]"
            >
              就地恢复
            </button>
            <button
              type="button"
              onClick={this.reload}
              className="rounded-lg bg-[var(--btn-bg)] px-4 py-2 text-xs font-medium text-[var(--btn-fg)] transition-colors duration-150 hover:bg-[var(--btn-bg-hover)]"
            >
              重新加载
            </button>
          </div>
        </div>
      </div>
    );
  }
}
