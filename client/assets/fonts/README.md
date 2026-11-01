# Fonts

`GeistMono-Regular.ttf` and `GeistMono-Bold.ttf` are Geist Mono (SIL Open Font
License 1.1, see `LICENSE-GeistMono.txt`) with the `liga`, `dlig` and `calt`
features removed, so a terminal shows `...`, `->` and `=>` as the characters
they are. React Native on iOS cannot turn ligatures off per text style.

Regenerate from the original files with `scripts/strip-font-ligatures.py`.
