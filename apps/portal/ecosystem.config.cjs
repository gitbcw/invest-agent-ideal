module.exports = {
  apps: [
    {
      name: "mastra-portal",
      script: "server.ts",
      interpreter: "node_modules/.bin/tsx",
      env: {
        NODE_ENV: "production",
      },
      autorestart: true,
      max_memory_restart: "500M",
      watch: false,
      error_file: "./logs/error.log",
      out_file: "./logs/out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
