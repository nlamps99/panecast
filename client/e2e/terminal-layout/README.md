# Terminal size and wrapping on the phone

Run `node client/e2e/terminal-layout/fixture.mjs` (loopback broker on 4491). It
shows one 150-column Claude Code screen: a welcome box, tool output with `⎿`,
a diff, Chinese text and the status line padded between `? for shortcuts` and
`◯ IDE disconnected`. Rows carry SGR colors and the cursor sits on the prompt,
as the relay sends them from cmux's render grid. Nothing reaches a real computer or model.

Generate this XcodeGen project under a canonical `/private/tmp/` path and run
`PanecastLayoutUITests` on a dedicated iPhone 15 Pro (393×852) simulator with
the current app installed and no saved pairing.

The test checks the terminal's share of the screen with and without the
keyboard, that the "⋯" menu holds the controls that used to take rows, that
history status floats without resizing the terminal, and that only the keys
and the input stay below the terminal while typing. Look at the screenshots
for wrapping: continuation lines line up with their row's text, the welcome
box closes at the phone's width, and no line ends cut off.
