import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          50: "#f7f7f8",
          100: "#eeeef0",
          200: "#d9d9de",
          300: "#b6b6bd",
          400: "#8b8b94",
          500: "#666670",
          600: "#4d4d56",
          700: "#3a3a42",
          800: "#27272d",
          900: "#18181c"
        },
        accent: {
          50: "#eef4ff",
          500: "#3b6cff",
          600: "#2a55e6",
          700: "#1f44b8"
        }
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "SF Pro Text",
          "PingFang SC",
          "Hiragino Sans GB",
          "Microsoft YaHei",
          "system-ui",
          "sans-serif"
        ],
        mono: ["SF Mono", "Menlo", "Consolas", "monospace"]
      }
    }
  },
  plugins: []
};

export default config;
