// Partner 平台页面入口（薄壳）。
// 统一壳已合并 owner + partner，按角色分层渲染。本文件保留导出签名供 routes/platform.ts 引用。
// renderPartnerPlatformPage() = 未认证/强制改密时显示登录壳（统一壳内部按 authenticated 分流）。
export { renderPartnerPlatformPage } from "./platform-ui/unified-app";
