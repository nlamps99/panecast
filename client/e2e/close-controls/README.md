# Close and pin controls on the phone

Uses the app's built-in demo, so it needs no fixture, pairing or real computer.
Generate this XcodeGen project under a canonical `/private/tmp/` path and run
`PanecastCloseUITests` on a dedicated simulator with the current app installed
and no saved pairing (the test enters the demo from the connect page).

It pins and unpins a workspace from the card's left swipe, cancels a workspace
close, closes one terminal from its tab, closes the last terminal (which closes
the workspace and returns to the list) and closes a workspace from its swipe
actions, answering the native confirmation each time. On a phone the card's
title row has no ☆ or ×; the iPad and the desktop keep them.
