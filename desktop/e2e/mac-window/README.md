# Mac window and confirmation regression

The QA bundle uses the real Rust window/menu/dialog code with a separate bundle
identifier and static test page. The page never calls credential, network, or
terminal commands, so this test never closes a user's terminal.

Build with `npm run tauri -- build --bundles app --config e2e/mac-window/tauri.test.conf.json`.
Register the resulting **Panecast Window Tests.app** with Launch Services, then
generate `project.yml` using XcodeGen and run the `PanecastWindowUITests` scheme
on macOS. UI testing requires the runner's normal macOS automation permission.

The test checks cancel/confirm, the red close button, File → Close Window,
Command-W, reopening the existing application, and Command-Q.
