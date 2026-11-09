//! Inspect the actual bundled HTML and effective Tauri CSP without opening a WebView.

fn sources<'a>(policy: &'a str, directive: &str) -> Vec<&'a str> {
    policy
        .split(';')
        .find_map(|part| {
            let mut fields = part.split_whitespace();
            (fields.next() == Some(directive)).then(|| fields.collect())
        })
        .unwrap_or_else(|| panic!("Missing {directive} in bundled CSP"))
}

#[test]
fn bundled_policy_allows_runtime_styles_and_preserves_script_protection() {
    // MockRuntime does not launch a native window, browser, application state, or Keychain.
    // generate_context! embeds the same exported assets and config as the release build.
    let app = tauri::test::mock_builder()
        .build(tauri::generate_context!(test = true))
        .expect("bundled app context");
    let asset = app
        .asset_resolver()
        .get("index.html".into())
        .expect("bundled index.html");
    let html = std::str::from_utf8(asset.bytes()).expect("UTF-8 HTML");
    let policy = asset.csp_header().expect("CSP remains enabled");
    let styles = sources(policy, "style-src");

    // React Native Web creates unnonced style elements and React sets style attributes.
    // CSP ignores unsafe-inline if a nonce or hash occurs in the same source list.
    assert!(styles.contains(&"'self'"));
    assert!(styles.contains(&"'unsafe-inline'"));
    assert!(
        !styles
            .iter()
            .any(|source| { source.starts_with("'nonce-") || source.starts_with("'sha") }),
        "Runtime styles would be blocked by the effective style-src: {styles:?}"
    );
    assert!(!html.contains("__TAURI_STYLE_NONCE__"));
    assert!(!html.contains("__TAURI_SCRIPT_NONCE__"));
    assert!(html.contains("expo-reset"));
    assert!(html.contains("desktop-bridge.js"));

    let scripts = sources(policy, "script-src");
    assert!(scripts.contains(&"'self'"));
    assert!(app
        .config()
        .app
        .security
        .dangerous_disable_asset_csp_modification
        .can_modify("script-src"));
    for forbidden in ["'unsafe-inline'", "'unsafe-eval'", "*", "http:", "https:"] {
        assert!(
            !scripts.contains(&forbidden),
            "Script policy expanded: {scripts:?}"
        );
    }
    assert_eq!(sources(policy, "object-src"), ["'none'"]);
    assert_eq!(sources(policy, "frame-src"), ["'none'"]);
}
