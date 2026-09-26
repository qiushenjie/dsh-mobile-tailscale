# DSH Mobile design system

## Direction

Restrained navy and cyan accents on the host theme's surfaces, compact developer-tool density, and a lively whale-girl character. The character may be expressive; the product UI remains calm and functional. Do not use gradients, glow, particles, glass effects, animated ambient backgrounds, or emoji icons.

## Color

| Role | Value |
| --- | --- |
| Background | `#FFFFFF` |
| Surface | `#F8FAFC` |
| Primary text | `#172554` |
| Secondary text | `#475569` |
| Accent | `#2563EB` |
| Accent soft | `#DBEAFE` |
| Border | `#BFDBFE` |
| Danger | `#DC2626` |

Maintain at least 4.5:1 text contrast. The implementation reads DSH's `--dsw-alias-*` theme variables, so plugin UI follows the host theme in light and dark mode and must not force a global theme; `#FFFFFF` is only the light-theme fallback, never a hard-coded background.

## Typography

In product UI, inherit DSH's system font stack. README artwork contains no generated text. Use 16px inputs on mobile to avoid browser zoom and preserve user font scaling.

## Shape and depth

- Panel and provider-card radius: 13px.
- Button radius: 12px.
- Input and secondary-control radius: 10px.
- Compact badges may use 8–9px. The former 16px card radius is legacy and survives only in isolated spots.
- Touch target: at least 44px; prefer 48px for primary mobile actions.
- Use a one-pixel blue-gray border and one restrained shadow at most.
- Never shift layout on hover or press.

## Motion

Use only short 150-200ms state transitions. Respect `prefers-reduced-motion`; no decorative entrance animation or continuous animation.

## Mobile layout

- Honor safe-area insets on every edge.
- Keep conversation content full-width on narrow screens.
- Prevent page-level horizontal overflow. Wide tables and code blocks may scroll inside their own containers.
- Keep primary actions reachable above the soft keyboard.
- Test 375px and 390px portrait, landscape, font scaling, and keyboard-open states.

## Brand artwork

- App icon: square white background; lively smiling whale girl holding a phone; navy/cyan technical jacket; no text, watermark, glow, particles, or complex scenery.
- Repository hero: wide white canvas; character and a restrained desktop scene on the right; generous empty space on the left; no generated text or special effects.

## Delivery checklist

- [ ] Host-theme surfaces and restrained accents.
- [ ] No emoji icons, gradients, glow, particles, or glass effects.
- [ ] Visible keyboard focus.
- [ ] 44px minimum touch targets.
- [ ] Safe-area and soft-keyboard handling.
- [ ] Reduced motion supported.
- [ ] No content hidden behind fixed controls.
- [ ] No page-level horizontal overflow at 375px; wide content scrolls only inside its container.
