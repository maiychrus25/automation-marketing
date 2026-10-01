/** @type {import('tailwindcss').Config} */
// Các sắc gray/blue mà code đang dùng được nối vào token trong src/ui/index.css,
// riêng cho từng loại utility (docs/specs/2026-10-02-macos-ui.md mục 5).
// Sắc không liệt kê ở đây giữ màu mặc định của Tailwind.
const token = (name) => `rgb(var(--rgb-${name}) / <alpha-value>)`;

module.exports = {
  content: [
    './index.html',
    './src/ui/**/*.{js,ts,jsx,tsx}',
  ],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        zalo: {
          blue: '#0068ff',
          'blue-dark': '#0052cc',
          'blue-light': '#e8f4ff',
        },
        sidebar: 'var(--color-sidebar)',
        'sidebar-hover': 'var(--color-sidebar-hover)',
      },
      backgroundColor: {
        gray: {
          500: token('control-strong'),
          600: token('control-hover'),
          700: token('control'),
          750: token('surface-mid'),
          800: token('surface'),
          850: token('bg-mid'),
          900: token('bg'),
          950: token('bg-deep'),
        },
        blue: {
          500: token('accent-fill'),
          600: token('accent-fill'),
          700: token('accent-fill-hover'),
        },
      },
      textColor: {
        gray: {
          100: token('text-primary'),
          200: token('text-primary-soft'),
          300: token('text-secondary-strong'),
          400: token('text-secondary'),
          500: token('text-tertiary'),
          600: token('text-tertiary'),
        },
        blue: {
          300: token('accent-text'),
          400: token('accent-text'),
          500: token('accent-text'),
          600: token('accent-text'),
        },
      },
      // divide-* dùng borderColor nên cũng theo bảng này.
      borderColor: {
        gray: {
          400: token('border-heavy'),
          500: token('border-heavy'),
          600: token('border-strong'),
          700: token('border'),
          800: token('border-subtle'),
          900: token('border-subtle'),
        },
        blue: {
          400: token('accent'),
          500: token('accent'),
          600: token('accent'),
        },
      },
      placeholderColor: {
        gray: {
          400: token('text-tertiary'),
          500: token('text-tertiary'),
          600: token('text-tertiary'),
        },
      },
      ringColor: {
        // ring-gray-700 (ErpBadges) mất quy tắc light khi gỡ ghi đè, nên nối vào token.
        gray: {
          700: token('border-strong'),
        },
        blue: {
          400: token('accent'),
          500: token('accent'),
          600: token('accent'),
        },
      },
      fontSize: {
        // Chữ nội dung 13 px như macOS (spec mục 4.5). Các cỡ khác giữ nguyên.
        sm: ['0.8125rem', { lineHeight: '1.25rem' }],
      },
      boxShadow: {
        '2xl': 'var(--shadow-popover)',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', '"Segoe UI Variable Text"', '"Segoe UI"', '"Noto Sans"', 'Ubuntu', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
