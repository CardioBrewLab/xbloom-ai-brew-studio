/**
 * @abandonware/noble 是 optionalDependencies（原生模块，Windows 上可能安装失败）。
 * 代码一律经 dynamic import + try/catch 加载，这里只给出最小类型占位，
 * 避免缺失真实类型包时 tsc 报错。
 */
declare module "@abandonware/noble" {
  const noble: any;
  export default noble;
}
