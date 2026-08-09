/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      // Named stacking layers — use these (z-dropdown, z-overlay, z-modal,
      // z-toast) instead of ad-hoc z-[9999] escalation, so every floating
      // surface has a defined place in the stack.
      zIndex: {
        dropdown: "50",
        overlay: "90",
        modal: "100",
        toast: "110",
      },
      // Both keyframes read --drift/--rot-mid/--rot-end custom properties
      // (defaulted so the animation still works if unset) — callers set
      // those inline per-particle so every star/glitter bit falls along its
      // own randomized path instead of a single shared trajectory.
      keyframes: {
        starFall: {
          "0%":   { opacity: "0", transform: "translate(0px, -6px) rotate(0deg) scale(0.6)" },
          "15%":  { opacity: "1", transform: "translate(calc(var(--drift, 0px) * 0.2), 0px) rotate(var(--rot-mid, 60deg)) scale(1)" },
          "100%": { opacity: "0", transform: "translate(var(--drift, 0px), 48px) rotate(var(--rot-end, 200deg)) scale(0.6)" },
        },
        // A single smooth arc (position/opacity/scale) — same shape as
        // starFall, no back-and-forth. The shimmer is a *separate* animation
        // (glitterShimmer, below) layered on top via a different property
        // (filter), so the two never fight over the same value mid-frame —
        // that's what made the old single-keyframe zigzag read as "stepped".
        glitterFall: {
          "0%":   { opacity: "0", transform: "translate(0px, -6px) scale(0.3)" },
          "20%":  { opacity: "1", transform: "translate(calc(var(--drift, 0px) * 0.25), 4px) scale(1)" },
          "100%": { opacity: "0", transform: "translate(var(--drift, 0px), 48px) scale(0.5)" },
        },
        glitterShimmer: {
          "0%, 100%": { filter: "brightness(1) drop-shadow(0 0 1px currentColor)" },
          "50%":      { filter: "brightness(2) drop-shadow(0 0 4px currentColor)" },
        },
        // Analytics' KPI tiles rise into place — the same fade-up-and-deblur
        // shape as Home's masked reveal, so both entrances read as one
        // language. Callers stagger it with an inline animationDelay.
        kpiRise: {
          "0%":   { opacity: "0", transform: "translateY(14px)", filter: "blur(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)", filter: "blur(0)" },
        },
        // A thin brand edge that flows cyan→teal along itself. Background-size
        // is set to 200% on the element so the gradient loops seamlessly when
        // its position slides 0% → 200% (the endpoints are the same hue).
        gradientFlow: {
          "0%":   { backgroundPosition: "0% 50%" },
          "100%": { backgroundPosition: "200% 50%" },
        },
      },
      animation: {
        "star-fall": "starFall 1.1s ease-in forwards",
        // Comma-separated — CSS's animation shorthand natively supports
        // running multiple named animations on one element at once.
        "glitter-twinkle": "glitterFall 1s ease-in-out forwards, glitterShimmer 0.35s ease-in-out infinite",
        // `both` so the staggered tiles hold their pre-animation state during
        // their delay instead of flashing in at full opacity first.
        "kpi-rise": "kpiRise 0.65s cubic-bezier(0.16, 1, 0.3, 1) both",
        "gradient-flow": "gradientFlow 4s linear infinite",
      },
      fontFamily: {
        sans: [
          '"Geist Variable"', "Geist", "system-ui", "-apple-system",
          "Segoe UI", "Roboto", "Helvetica", "Arial", "sans-serif",
        ],
        display: [
          '"Bricolage Grotesque Variable"', '"Bricolage Grotesque"',
          '"Geist Variable"', "sans-serif",
        ],
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
