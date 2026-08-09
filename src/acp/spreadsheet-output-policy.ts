export const SPREADSHEET_OUTPUT_POLICY = [
  "面向用户的表格统一使用 Excel（.xlsx）。",
  "即使用户口头提到 CSV、纯数据导出或机器交换，也应交付 .xlsx；只有服务内部兼容读取历史 CSV 时才保留 CSV。",
  "更新历史 CSV 时，服务会在同一文件资产下创建新的 XLSX 版本，保留原 CSV 版本、文件夹位置和自动化绑定。",
  "新建或更新表格时不得提交 .csv 文件名或 text/csv 内容。",
].join("");
