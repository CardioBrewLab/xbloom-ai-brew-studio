export type XhsQrFailureKind =
  "service_offline" | "browser_timeout" | "no_qrcode" | "image_invalid" | "unknown";

export interface XhsQrFailureCopy {
  title: string;
  detail: string;
}

export function xhsQrFailureCopy(kind: XhsQrFailureKind | undefined): XhsQrFailureCopy {
  switch (kind) {
    case "service_offline":
      return {
        title: "小红书服务尚未就绪",
        detail: "本地服务状态会保留登录文件；服务恢复后再刷新状态。",
      };
    case "browser_timeout":
      return {
        title: "二维码生成超时",
        detail:
          "服务端口在线，但浏览器内核本次没有返回二维码。登录文件仍保持原样，可刷新状态后重试。",
      };
    case "no_qrcode":
      return {
        title: "本次没有拿到二维码",
        detail: "小红书登录页返回了提示，但没有附带二维码图片。可重新请求一张。",
      };
    case "image_invalid":
      return {
        title: "二维码图片解析失败",
        detail: "二维码数据已返回，但浏览器没有成功显示图片。重新取码会创建一张新码。",
      };
    default:
      return {
        title: "二维码暂未生成",
        detail: "刷新服务状态后再试一次，当前登录文件与账号数据保持原样。",
      };
  }
}
