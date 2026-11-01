# Security Policy

Panecast lets a phone control the terminals on your computer, so a security
bug here can expose everything those terminals can reach. Please report
problems privately.

## Reporting a vulnerability

Do not open a public issue. Use GitHub's private vulnerability reporting
instead: open the repository's **Security** tab and choose **Report a
vulnerability**.

A working proof of concept helps but is not required. We aim to acknowledge
reports within 7 days and to ship a fix or mitigation within 30 days,
coordinating disclosure with the reporter. Reporters are credited in the
security advisory unless they ask to stay anonymous.

## Scope

In scope:

- the relay (`relay/`): its HTTP/WebSocket server, authentication and device
  tokens, pairing, rate limiting, and the launchd installer
- the broker (`broker/`): pairing, device tokens and session forwarding
- the phone client (`client/`)
- the wire protocol: HTTP/WebSocket framing, the JSON-RPC envelope and diff
  frames

Out of scope:

- terminal backends such as [cmux](https://github.com/manaflow-ai/cmux),
  Tailscale, SwiftNIO, Expo, React Native, and iOS, Android or macOS platform
  bugs. Please report these to their own projects.
- the unmaintained native clients in `legacy/`
- the broker being able to read the terminal frames it forwards. This is a
  documented design limit: connections use TLS but are not end-to-end
  encrypted.

## What counts as a vulnerability

- an unpaired or unauthenticated client reaching relay or broker handlers
- a device token or pairing code leaking through a response, log line,
  notification or the clipboard
- forging a pairing or device registration
- terminal contents leaking into notifications, logs or telemetry
- a paired device reading from or sending to a workspace it was not
  authorized for
- bypassing the pairing or per-device rate limits
- memory or process compromise through crafted RPC or diff frames
