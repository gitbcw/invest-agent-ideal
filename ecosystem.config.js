module.exports = {
  apps: [
    {
      name: "invest-agent",
      script: "dist/index.js",
      env: {
        NODE_ENV: "production",
        PORT: 22655,
        HOST: "127.0.0.1",
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
