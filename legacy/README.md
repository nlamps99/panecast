# legacy

The original cmux Remote native clients and documents. They are kept as a
reference while the Expo client in `../client` reaches feature parity, and
are not maintained. This directory will be deleted once parity is reached.

- `ios/`: the SwiftUI app. Run `xcodegen generate` in `ios/` to create the
  Xcode project; it builds against the Swift package in `../relay`.
- `android/`: the Kotlin and Jetpack Compose app.
- `README.cmux-remote*.md`: the old project README in Chinese, English and
  Korean. It still documents relay configuration in full.
- `PRIVACY.cmux-remote.md`, `docs/`, `tasks/`, `scripts/`, `LOCAL_INSTALL.md`:
  App Store material, connection guides and notes from the old project.
