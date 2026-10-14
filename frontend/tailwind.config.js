/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        ink: "#1d1d1d",
        charcoal: "#2b2b2b",
        "charcoal-dark": "#181a1d",
        soft: "#f3f4f6",
        label: "#8a7767",
        amber: {
          DEFAULT: "#d98a1f",
          light: "#f5a742"
        },
        red: {
          DEFAULT: "#c8443b",
          light: "#e25c53"
        },
        gridgrey: "#9aa3ad"
      },
      fontFamily: {
        serif: ['"Playfair Display"', 'Georgia', 'serif'],
        sans: ['"Poppins"', 'system-ui', 'sans-serif'],
      },
      letterSpacing: {
        widest: '.2em',
      }
    },
  },
  plugins: [],
}
