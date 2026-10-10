import { execFileSync } from "node:child_process";

/** Read only the two data MCP credentials; never persist or log returned values. */
export function productionMcpEnv() {
  const remoteScript = `const fs=require("fs");const e=require("dotenv").parse(fs.readFileSync(".env"));const out={};for(const p of ["MARKET_DATA","QSSE"]){out[p+"_MCP_URL"]=e[p+"_MCP_URL"];out[p+"_MCP_TOKEN"]=e[p+"_MCP_TOKEN"];}process.stdout.write(JSON.stringify(out));`;
  let env;
  try {
    const raw = execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "claude@118.145.115.197",
      `cd /home/claude/invest-agent-mastra && node -e '${remoteScript}'`], { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });
    env = JSON.parse(raw);
  } catch {
    throw new Error("读取生产数据 MCP 配置失败；镜像停止启动，避免无数据源测试。请检查 SSH 连接。");
  }
  for (const prefix of ["MARKET_DATA", "QSSE"]) {
    if (!env[prefix + "_MCP_TOKEN"] || !env[prefix + "_MCP_URL"]) throw new Error(`${prefix} MCP 配置不完整`);
    const url = new URL(env[prefix + "_MCP_URL"]);
    if (["localhost", "127.0.0.1"].includes(url.hostname)) url.hostname = "118.145.115.197";
    env[prefix + "_MCP_URL"] = url.toString();
    env["INVEST_AGENT_MCP_" + prefix + "_ENABLED"] = "true";
  }
  return env;
}
