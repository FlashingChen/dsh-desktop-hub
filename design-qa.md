# Design QA

## Reference

The attached DeepSeek Harness desktop screenshot is the visual reference: a quiet white workspace, a compact pale sidebar, muted labels, and a blue active state.

## Implementation review

- DSH owns the only visible sidebar. The desktop shell's duplicate sidebar is hidden.
- The manager is mounted as a DSH client plugin panel under a native DSH sidebar entry.
- Manager sections use a slim top tab row, a white canvas, light borders, and the same restrained blue active state as the reference.
- The DSH workspace remains the launch view; the manager appears only when its DSH sidebar entry is selected.

## Verification

- `npm run build` passed.
- `npm start` is running with the bundled `@deepseek-ai/dsh` version `0.1.7-rc.2`.
- A native screenshot comparison is pending because the macOS session reported as locked during visual inspection. The layout has not been visually signed off in the running window.
