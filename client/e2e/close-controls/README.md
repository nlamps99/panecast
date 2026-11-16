# Close buttons on the phone

Uses the app's built-in demo, so it needs no fixture, pairing or real computer.
Generate this XcodeGen project under a canonical `/private/tmp/` path and run
`PanecastCloseUITests` on a dedicated simulator with the current app installed
and no saved pairing (the test enters the demo from the connect page).

It cancels a workspace close, closes one terminal from its tab, closes the last
terminal (which closes the workspace and returns to the list) and closes a
workspace from its card, answering the native confirmation each time.
