/**
 * Isolated browser acceptance for the user-file quota and unified preview
 * flow. Start Portal + its online mock connector first, then run:
 *
 * PORTAL_ACCEPTANCE_BASE=http://127.0.0.1:3211 \
 * npx tsx scripts/acceptance-assets-browser.mts
 */
import { chromium, type Page } from "playwright-core";

const base = process.env.PORTAL_ACCEPTANCE_BASE ?? "http://127.0.0.1:3211";
const user = process.env.PORTAL_ACCEPTANCE_USER ?? "primary";
const password = process.env.PORTAL_ACCEPTANCE_PASS ?? "User@2026";

const results: Array<{ item: string; pass: boolean; detail: string }> = [];
function check(item: string, condition: boolean, detail: string) {
  results.push({ item, pass: condition, detail });
  console.log(`${condition ? "PASS" : "FAIL"} ${item}: ${detail}`);
}

async function login(page: Page) {
  await page.goto(`${base}/login`, { waitUntil: "networkidle" });
  await page.locator('input[name="username"], input#username, input[type="text"]').first().fill(user);
  await page.locator('input[type="password"]').fill(password);
  await Promise.all([
    page.waitForURL(/\/chat/, { timeout: 15_000 }).catch(() => undefined),
    page.locator('button[type="submit"]').click(),
  ]);
}

async function openAssets(page: Page) {
  await page.goto(`${base}/assets`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "我的文件" }).waitFor({ timeout: 10_000 });
}

async function installPromptGuard(page: Page) {
  await page.addInitScript(() => {
    const state = window as typeof window & { __portalPromptCalls: number };
    state.__portalPromptCalls = 0;
    window.prompt = () => {
      state.__portalPromptCalls += 1;
      return null;
    };
  });
}

async function verifyFolderDialog(page: Page, mobile: boolean) {
  await page.getByRole("button", { name: "新建文件夹", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建文件夹", exact: true });
  const dialogVisible = await dialog.waitFor({ state: "visible", timeout: 5_000 }).then(() => true).catch(() => false);
  const inputVisible = dialogVisible && await dialog.getByRole("textbox", { name: "文件夹名称" }).isVisible().catch(() => false);
  const promptCalls = await page.evaluate(() => (window as typeof window & { __portalPromptCalls?: number }).__portalPromptCalls ?? 0);
  check(`${mobile ? "mobile" : "desktop"}-folder-dialog`, dialogVisible && inputVisible, "点击新建文件夹打开站内对话框");
  check(`${mobile ? "mobile" : "desktop"}-folder-dialog-no-prompt`, promptCalls === 0, `window.prompt 调用次数为 ${promptCalls}`);
  if (dialogVisible) await dialog.getByRole("button", { name: "取消", exact: true }).click();
}

async function verifyMobileFolderManagement(page: Page) {
  const folderName = `移动端验收-${Date.now()}`;
  const renamed = `${folderName}-已改名`;
  await page.getByRole("button", { name: "新建文件夹", exact: true }).click();
  const createDialog = page.getByRole("dialog", { name: "新建文件夹", exact: true });
  await createDialog.getByRole("textbox", { name: "文件夹名称" }).fill(folderName);
  await createDialog.getByRole("button", { name: "创建", exact: true }).click();
  await createDialog.waitFor({ state: "detached", timeout: 5_000 });
  const target = page.locator("[data-folder-id]").filter({ hasText: folderName });
  await target.getByRole("button", { name: `文件夹更多操作：${folderName}` }).click();
  await page.getByRole("button", { name: "重命名", exact: true }).click();
  const renameDialog = page.getByRole("dialog", { name: "重命名文件夹", exact: true });
  await renameDialog.getByRole("textbox", { name: "文件夹名称" }).fill(renamed);
  await renameDialog.getByRole("button", { name: "保存", exact: true }).click();
  await renameDialog.waitFor({ state: "detached", timeout: 5_000 });
  check("mobile-folder-rename", await target.getByRole("button", { name: `进入文件夹 ${renamed}` }).count() === 1, "移动端文件夹菜单支持重命名");
  await target.getByRole("button", { name: `文件夹更多操作：${renamed}` }).click();
  await page.getByRole("button", { name: "删除", exact: true }).click();
  const deleteDialog = page.getByRole("dialog", { name: "删除文件夹", exact: true });
  await deleteDialog.getByRole("button", { name: "删除文件夹", exact: true }).click();
  await deleteDialog.waitFor({ state: "detached", timeout: 5_000 });
  check("mobile-folder-delete-empty", await target.count() === 0, "移动端可以确认删除空文件夹");
}

async function closePanel(page: Page) {
  const close = page.getByRole("button", { name: "关闭制品预览" });
  if (await close.count()) await close.click();
  await page.locator('[data-file-panel-mode="asset-preview"]').waitFor({ state: "detached", timeout: 5_000 }).catch(() => undefined);
}

async function verifyAssetDragToFolder(page: Page) {
  const folderName = `拖放验收-${Date.now()}`;
  const renamedFolderName = `${folderName}-已改名`;
  await page.getByRole("button", { name: "新建文件夹", exact: true }).click();
  const createDialog = page.getByRole("dialog", { name: "新建文件夹", exact: true });
  await createDialog.getByRole("textbox", { name: "文件夹名称" }).fill(folderName);
  await createDialog.getByRole("button", { name: "创建", exact: true }).click();
  await createDialog.waitFor({ state: "detached", timeout: 5_000 });

  const source = page.locator('[data-asset-id="mock_asset_note"]');
  const createdTarget = page.locator("[data-folder-id]").filter({ hasText: folderName });
  const targetFolderId = await createdTarget.getAttribute("data-folder-id");
  if (!targetFolderId) throw new Error("created folder id missing");
  const target = page.locator(`[data-folder-id="${targetFolderId}"]`);
  await target.getByRole("button", { name: `文件夹更多操作：${folderName}` }).click();
  await page.getByRole("button", { name: "重命名", exact: true }).click();
  const renameDialog = page.getByRole("dialog", { name: "重命名文件夹", exact: true });
  await renameDialog.getByRole("textbox", { name: "文件夹名称" }).fill(renamedFolderName);
  await renameDialog.getByRole("button", { name: "保存", exact: true }).click();
  await renameDialog.waitFor({ state: "detached", timeout: 5_000 });
  check("desktop-folder-rename", await target.getByRole("button", { name: `进入文件夹 ${renamedFolderName}` }).count() === 1, "文件夹可通过行菜单重命名");
  const draggableRows = page.locator("[data-asset-id]");
  const folderIconBox = await target.locator("[data-primary-icon]").boundingBox();
  const fileIconLefts = await draggableRows.locator("[data-primary-icon]").evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().left));
  check("desktop-folder-file-alignment", Boolean(folderIconBox) && fileIconLefts.length === await draggableRows.count() && fileIconLefts.every((left) => Math.abs(left - folderIconBox!.x) <= 1), "文件夹、文件和报告图标左侧对齐");
  const draggableStates = await draggableRows.evaluateAll((elements) => elements.map((element) => element.getAttribute("draggable")));
  check("desktop-whole-row-draggable", draggableStates.every((state) => state === "true"), "移除手柄后整行仍可拖动");
  await source.dragTo(target);
  await source.waitFor({ state: "detached", timeout: 5_000 });
  check("desktop-folder-drop", await page.getByText(`已将“投资观察笔记”移动到“${renamedFolderName}”`, { exact: true }).count() === 1, "拖放后显示目标文件夹并从当前目录移除文件");

  await target.getByRole("button", { name: `文件夹更多操作：${renamedFolderName}` }).click();
  await page.getByRole("button", { name: "删除", exact: true }).click();
  const deleteDialog = page.getByRole("dialog", { name: "删除文件夹", exact: true });
  await deleteDialog.getByRole("button", { name: "删除文件夹", exact: true }).click();
  await page.getByText(`文件夹“${renamedFolderName}”不是空的，请先移出其中的文件或子文件夹。`, { exact: true }).waitFor({ timeout: 5_000 });
  check("desktop-folder-delete-nonempty", await target.count() === 1, "非空文件夹拒绝删除并保留原目录");
  await deleteDialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "关闭错误" }).click();

  await page.getByRole("button", { name: "进入文件夹", exact: true }).click();
  await page.getByRole("button", { name: "打开文件 投资观察笔记" }).waitFor({ state: "visible", timeout: 5_000 });
  check("desktop-folder-drop-destination", true, "目标文件夹中可见被移动文件");

  await page.getByRole("button", { name: "更多操作：投资观察笔记" }).click();
  await page.getByRole("button", { name: "移动", exact: true }).click();
  const moveDialog = page.getByRole("dialog", { name: "移动文件", exact: true });
  await moveDialog.getByLabel("根目录", { exact: true }).check();
  await moveDialog.getByRole("button", { name: "移动到此处", exact: true }).click();
  await moveDialog.waitFor({ state: "detached", timeout: 5_000 });
  await page.getByRole("navigation", { name: "文件夹路径" }).getByRole("button", { name: "我的文件", exact: true }).click();
  await page.getByRole("button", { name: "打开文件 投资观察笔记" }).waitFor({ state: "visible", timeout: 5_000 });
  return { folderName: renamedFolderName, folderId: targetFolderId };
}

async function verifyReportDragToFolder(page: Page, folderName: string, folderId: string) {
  const source = page.locator('[data-asset-id="mock_asset_report_daily"]');
  const target = page.locator(`[data-folder-id="${folderId}"]`);
  await source.dragTo(target);
  await source.waitFor({ state: "detached", timeout: 5_000 });
  check("desktop-report-folder-drop", await page.getByText(`已将“每日复盘”移动到“${folderName}”`, { exact: true }).count() === 1, "报告也可拖入文件夹");

  await page.getByRole("button", { name: "进入文件夹", exact: true }).click();
  await page.getByRole("button", { name: "打开报告 每日复盘" }).waitFor({ state: "visible", timeout: 5_000 });
  await page.getByRole("button", { name: "更多操作：每日复盘" }).click();
  await page.getByRole("button", { name: "移动", exact: true }).click();
  const moveDialog = page.getByRole("dialog", { name: "移动文件", exact: true });
  await moveDialog.getByLabel("根目录", { exact: true }).check();
  await moveDialog.getByRole("button", { name: "移动到此处", exact: true }).click();
  await moveDialog.waitFor({ state: "detached", timeout: 5_000 });
  await page.getByRole("navigation", { name: "文件夹路径" }).getByRole("button", { name: "我的文件", exact: true }).click();
  await page.getByRole("button", { name: "打开报告 每日复盘" }).waitFor({ state: "visible", timeout: 5_000 });
  await target.getByRole("button", { name: `文件夹更多操作：${folderName}` }).click();
  await page.getByRole("button", { name: "删除", exact: true }).click();
  const deleteDialog = page.getByRole("dialog", { name: "删除文件夹", exact: true });
  await deleteDialog.getByRole("button", { name: "删除文件夹", exact: true }).click();
  await deleteDialog.waitFor({ state: "detached", timeout: 5_000 });
  check("desktop-folder-delete-empty", await target.count() === 0, "清空后的文件夹可以删除");
}

async function verifyAssets(page: Page, mobile: boolean) {
  await openAssets(page);
  const usage = await page.getByText("存储空间").count();
  check(`${mobile ? "mobile" : "desktop"}-usage`, usage === 1, "容量条可见");
  await verifyFolderDialog(page, mobile);
  if (mobile) await verifyMobileFolderManagement(page);

  await page.getByRole("button", { name: /^报告(?:\s|$)/ }).click();
  const report = page.getByText("每日复盘", { exact: true });
  await report.click();
  const panel = page.locator('[data-file-panel-mode="asset-preview"]');
  await panel.waitFor({ timeout: 5_000 });
  const dialog = panel.getByRole("dialog");
  await page.getByRole("button", { name: "关闭制品预览" }).waitFor({ state: "visible", timeout: 5_000 });
  const bounds = await dialog.boundingBox();
  check(`${mobile ? "mobile" : "desktop"}-report-panel`, Boolean(bounds) && (mobile ? Math.round(bounds!.width) === 390 : bounds!.width >= 900 && bounds!.width <= 1200), `报告使用统一文件预览 (${bounds?.width ?? 0}px)`);
  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "detached", timeout: 5_000 }).catch(() => undefined);
  check(`${mobile ? "mobile" : "desktop"}-escape`, await panel.count() === 0, "Esc 关闭预览");

  if (!mobile) {
    await page.getByRole("button", { name: /^全部(?:\s|$)/ }).click();
    const dragFolder = await verifyAssetDragToFolder(page);
    await verifyReportDragToFolder(page, dragFolder.folderName, dragFolder.folderId);
    const assetButton = page.getByRole("button", { name: "打开文件 投资观察笔记" });
    await assetButton.click();
    await panel.waitFor({ timeout: 5_000 });
    await closePanel(page);
    const restored = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    check("desktop-focus-restore", restored === "打开文件 投资观察笔记", "关闭后焦点回到触发文件");
  }
}

async function verifyClientLimits(page: Page) {
  await openAssets(page);
  await page.getByRole("button", { name: "上传文件" }).click();
  const input = page.locator('input[type="file"]');
  await input.setInputFiles({ name: "too-large.md", mimeType: "text/markdown", buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 65) });
  await page.getByRole("button", { name: "上传文件", exact: true }).last().click();
  check("client-10mb", await page.getByText("单个文件不能超过 10MB").count() > 0, "超过 10MB 在提交前被拦截");
  await page.getByRole("button", { name: "关闭上传" }).click();

  await page.getByRole("button", { name: "上传文件" }).click();
  const tenMiB = Buffer.alloc(10 * 1024 * 1024, 66);
  await page.locator('input[type="file"]').setInputFiles([
    { name: "batch-a.md", mimeType: "text/markdown", buffer: tenMiB },
    { name: "batch-b.md", mimeType: "text/markdown", buffer: tenMiB },
    { name: "batch-c.md", mimeType: "text/markdown", buffer: Buffer.from("x") },
  ]);
  await page.getByRole("button", { name: "上传文件", exact: true }).last().click();
  check("client-20mb", await page.getByText("同一次上传不能超过 20MB").count() > 0, "超过 20MB 总量在提交前被拦截");
  await page.getByRole("button", { name: "关闭上传" }).click();
}

async function verifyConversationSave(page: Page) {
  await page.goto(`${base}/chat`, { waitUntil: "networkidle" });
  await page.getByText("持仓风险快检", { exact: true }).click();
  const card = page.getByRole("button", { name: "打开制品 持仓风险复盘" });
  await card.waitFor({ timeout: 10_000 });
  await card.click();
  await page.getByRole("complementary", { name: "文档工作区" }).waitFor({ state: "visible", timeout: 5_000 });
  await page.getByRole("button", { name: "关闭全部并退出工作区" }).click();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByText("已保存", { exact: true }).waitFor({ timeout: 5_000 });
  check("conversation-explicit-save", true, "对话交付物只有点击保存后才进入长期资产");
}

async function main() {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const desktop = await desktopContext.newPage();
    await installPromptGuard(desktop);
    await login(desktop);
    await verifyAssets(desktop, false);
    await verifyClientLimits(desktop);
    await verifyConversationSave(desktop);

    const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const mobile = await mobileContext.newPage();
    await installPromptGuard(mobile);
    await login(mobile);
    await verifyAssets(mobile, true);
  } finally {
    await browser.close();
  }
  const failures = results.filter((item) => !item.pass);
  console.log(JSON.stringify({ results, failures: failures.length }, null, 2));
  if (failures.length) process.exitCode = 1;
}

void main();
