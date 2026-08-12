// 在首屏渲染前应用已保存主题，避免亮/暗闪烁。
try {
  var theme = localStorage.getItem("xbloom-theme");
  document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
} catch (_error) {
  document.documentElement.dataset.theme = "light";
}
