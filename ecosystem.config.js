module.exports = {
  apps: [
    {
      name: "invest-agent-mastra",
      script: "dist/index.js",
      env: {
        NODE_ENV: "production",
        PORT: 23655,
        HOST: "0.0.0.0",
      },
      autorestart: true,
      max_memory_restart: "500M",
      watch: false,
      // 必须 > W5 优雅排空预算（240s）+ 收尾清理。PM2 默认 kill_timeout 1600ms 会在
      // 排空 sleep 中 SIGKILL，在途自动化 run 变孤儿、15 分钟后被租约 reaper 判死
      // （T-412：2026-08-28 dyk 9:30 简报丢失）。
      kill_timeout: 250_000,
      error_file: "./logs/error.log",
      out_file: "./logs/out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
