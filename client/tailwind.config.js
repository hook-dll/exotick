/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      // Bare `border` utility follows this variable so it flips in dark mode.
      borderColor: {
        DEFAULT: 'var(--tc-border, #e5e7eb)',
      },
    },
  },
  plugins: [],
};
