// Release builds on Windows are GUI apps without a console window.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod local_gateway;
mod security;
mod shared_file;
mod transport;
#[cfg(target_os = "macos")]
mod updater;
mod vault;
mod window_state;
#[cfg(windows)]
mod windows_dialog;

#[cfg(test)]
mod asset_tests;
#[cfg(test)]
mod production_tests;

use serde::Deserialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::{ipc::Channel, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use transport::{RequestOptions, Response, SocketEvent, Transport};
use vault::{SystemKeyStore, Vault};

#[derive(Clone)]
struct VaultState(Arc<Mutex<Vault>>);

fn require_app(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" && window.url().is_ok_and(|url| security::app_url(&url)) {
        Ok(())
    } else {
        Err("无效的应用窗口".into())
    }
}

#[tauri::command]
async fn secret_get(
    window: WebviewWindow,
    state: State<'_, VaultState>,
    key: String,
) -> Result<Option<String>, String> {
    require_app(&window)?;
    let vault = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || vault.lock().unwrap().get(&key))
        .await
        .map_err(|_| "无法读取登录信息")?
}
#[tauri::command]
async fn secret_set(
    window: WebviewWindow,
    state: State<'_, VaultState>,
    key: String,
    value: String,
) -> Result<(), String> {
    require_app(&window)?;
    let vault = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || vault.lock().unwrap().set(&key, value))
        .await
        .map_err(|_| "无法保存登录信息")?
}
#[tauri::command]
async fn secret_delete(
    window: WebviewWindow,
    state: State<'_, VaultState>,
    key: String,
) -> Result<(), String> {
    require_app(&window)?;
    let vault = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || vault.lock().unwrap().remove(&key))
        .await
        .map_err(|_| "无法删除登录信息")?
}
#[tauri::command]
async fn request(
    window: WebviewWindow,
    state: State<'_, Transport>,
    id: String,
    url: String,
    options: RequestOptions,
    on_started: Channel<()>,
) -> Result<Response, String> {
    require_app(&window)?;
    state.request(id, url, options, Some(on_started)).await
}
#[tauri::command]
fn abort_request(
    window: WebviewWindow,
    state: State<'_, Transport>,
    id: String,
) -> Result<(), String> {
    require_app(&window)?;
    state.abort_request(&id);
    Ok(())
}
#[tauri::command]
fn socket_connect(
    window: WebviewWindow,
    state: State<'_, Transport>,
    id: String,
    url: String,
    protocols: Vec<String>,
    headers: HashMap<String, String>,
    on_event: Channel<SocketEvent>,
) -> Result<(), String> {
    require_app(&window)?;
    state.connect(
        id,
        url,
        protocols,
        headers.get("Authorization").cloned().unwrap_or_default(),
        Arc::new(move |event| on_event.send(event).is_ok()),
    )
}
#[tauri::command]
fn socket_send(
    window: WebviewWindow,
    state: State<'_, Transport>,
    id: String,
    data: String,
) -> Result<(), String> {
    require_app(&window)?;
    state.send(&id, data)
}
#[tauri::command]
fn socket_close(
    window: WebviewWindow,
    state: State<'_, Transport>,
    id: String,
) -> Result<(), String> {
    require_app(&window)?;
    state.close(&id);
    Ok(())
}
#[tauri::command]
fn clipboard_write(
    window: WebviewWindow,
    app: tauri::AppHandle,
    text: String,
) -> Result<bool, String> {
    require_app(&window)?;
    app.clipboard().write_text(text).map_err(|_| "复制失败")?;
    Ok(true)
}

#[derive(Clone, serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopNotification {
    title: String,
    body: String,
    computer_id: Option<String>,
    notification_id: Option<String>,
    workspace_id: Option<String>,
    surface_id: Option<String>,
    source_id: Option<String>,
    thread_id: Option<String>,
    #[serde(default)]
    force: bool,
}

#[tauri::command]
fn desktop_notify(
    window: WebviewWindow,
    app: tauri::AppHandle,
    options: DesktopNotification,
) -> Result<bool, String> {
    require_app(&window)?;
    if !options.force
        && window.is_focused().unwrap_or(false)
        && window.is_visible().unwrap_or(false)
    {
        return Ok(false); // The foreground already has the in-app banner.
    }
    if serde_json::to_vec(&options)
        .map_err(|_| "无效的通知")?
        .len()
        > 16_000
    {
        return Err("通知内容过长".into());
    }
    app.notification()
        .builder()
        .title(options.title.chars().take(200).collect::<String>())
        .body(options.body.chars().take(2000).collect::<String>())
        .sound("default")
        .extra("panecast", &options)
        .show()
        .map_err(|_| "无法发送系统通知")?;
    Ok(true)
}

#[tauri::command]
fn notification_settings(window: WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    require_app(&window)?;
    #[cfg(target_os = "macos")]
    let url = "x-apple.systempreferences:com.apple.Notifications-Settings.extension";
    #[cfg(windows)]
    let url = "ms-settings:notifications";
    #[cfg(not(any(target_os = "macos", windows)))]
    return Err("请在系统设置中管理通知".into());
    #[cfg(any(target_os = "macos", windows))]
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| "无法打开通知设置".into())
}

/// Self-update: the current version and what the updater is doing.
#[tauri::command]
async fn update_status(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    require_app(&window)?;
    #[cfg(target_os = "macos")]
    return serde_json::to_value(updater::status(&app)).map_err(|e| e.to_string());
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("这个系统暂不支持自动更新".into())
    }
}

/// Checks for an update now and installs it; resolves with the new status.
#[tauri::command]
async fn update_check(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    require_app(&window)?;
    #[cfg(target_os = "macos")]
    return serde_json::to_value(updater::check(&app).await).map_err(|e| e.to_string());
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("这个系统暂不支持自动更新".into())
    }
}

/// Restarts into the installed update.
#[tauri::command]
async fn update_restart(window: WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    require_app(&window)?;
    app.state::<Transport>().disconnect();
    app.restart()
}

/// The app menu's "检查更新…": checks, then says what it found.
#[cfg(target_os = "macos")]
fn check_from_menu(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let status = updater::check(&app).await;
        let (title, message, buttons) = match &status.state {
            updater::UpdateState::Ready { version, notes } => (
                format!("Panecast {version} 已下载"),
                notes.clone().unwrap_or_else(|| "重启 Panecast 后使用新版本。".into()),
                vec!["立即重启".to_string(), "稍后".to_string()],
            ),
            updater::UpdateState::Failed { message } => {
                ("检查更新失败".to_string(), message.clone(), vec!["好".to_string()])
            }
            _ => (
                "已是最新版本".to_string(),
                format!("Panecast {} 是最新版本。", status.current),
                vec!["好".to_string()],
            ),
        };
        let restart = matches!(status.state, updater::UpdateState::Ready { .. });
        let cancel = buttons.len() - 1;
        if let Ok(0) = native_dialog(&app, 0, title, message, buttons, cancel).await {
            if restart {
                app.state::<Transport>().disconnect();
                app.restart();
            }
        }
    });
}

/// The gateway on this computer, for a direct loopback connection.
#[tauri::command]
async fn local_gateway(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<Option<serde_json::Value>, String> {
    require_app(&window)?;
    let home = app.path().home_dir().map_err(|_| "无法找到用户目录")?;
    let config = std::env::var_os("PANECAST_CONFIG_DIR").map(std::path::PathBuf::from);
    tauri::async_runtime::spawn_blocking(move || {
        local_gateway::read(&local_gateway::file(&home, config))
    })
    .await
    .map_err(|_| "无法读取本机网关".into())
}

#[derive(serde::Serialize)]
struct OpenedFile {
    path: String,
    opened: bool,
}

/// Downloads a file a shared window offered and opens it with the default app.
#[tauri::command]
async fn open_shared_file(
    window: WebviewWindow,
    app: tauri::AppHandle,
    url: String,
    name: String,
) -> Result<OpenedFile, String> {
    require_app(&window)?;
    let url = shared_file::valid_url(&url)?;
    let directory = app
        .path()
        .download_dir()
        .map_err(|_| "无法找到下载文件夹")?
        .join("Panecast");
    let path = shared_file::download(url, &directory, &name).await?;
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let direct = shared_file::opens_directly(&file_name);
    let shown = if direct {
        app.opener()
            .open_path(path.to_string_lossy().into_owned(), None::<&str>)
    } else {
        app.opener().reveal_item_in_dir(&path)
    };
    if shown.is_err() {
        let _ = app.opener().reveal_item_in_dir(&path);
    }
    Ok(OpenedFile {
        path: path.to_string_lossy().into_owned(),
        opened: direct && shown.is_ok(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DialogOptions {
    title: String,
    message: Option<String>,
    buttons: Vec<String>,
    cancel_id: usize,
}
#[tauri::command]
async fn dialog(
    window: WebviewWindow,
    app: tauri::AppHandle,
    options: DialogOptions,
) -> Result<usize, String> {
    require_app(&window)?;
    if options.buttons.is_empty()
        || options.buttons.len() > 6
        || options.cancel_id >= options.buttons.len()
    {
        return Err("无效的对话框".into());
    }
    let title: String = options.title.chars().take(200).collect();
    let message: String = options
        .message
        .unwrap_or_default()
        .chars()
        .take(4000)
        .collect();
    let buttons: Vec<String> = options
        .buttons
        .iter()
        .map(|title| title.chars().take(100).collect())
        .collect();
    #[cfg(windows)]
    let parent = window.hwnd().map(|hwnd| hwnd.0 as isize).unwrap_or(0);
    #[cfg(not(windows))]
    let parent = 0;
    native_dialog(&app, parent, title, message, buttons, options.cancel_id).await
}

/// A modal alert on the main thread; returns the chosen button index.
async fn native_dialog(
    app: &tauri::AppHandle,
    parent: isize,
    title: String,
    message: String,
    buttons: Vec<String>,
    cancel_id: usize,
) -> Result<usize, String> {
    #[cfg(not(windows))]
    let _ = parent;
    let (send, receive) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        #[cfg(target_os = "macos")]
        let result = {
            use objc2::MainThreadMarker;
            use objc2_app_kit::NSAlert;
            use objc2_foundation::NSString;
            let alert = NSAlert::new(MainThreadMarker::new().expect("main thread"));
            alert.setMessageText(&NSString::from_str(&title));
            alert.setInformativeText(&NSString::from_str(&message));
            for (index, title) in buttons.iter().enumerate() {
                let button = alert.addButtonWithTitle(&NSString::from_str(title));
                // Enter defaults to cancellation, including destructive actions.
                button.setKeyEquivalent(&NSString::from_str(if index == cancel_id {
                    "\r"
                } else {
                    ""
                }));
            }
            let response = alert.runModal();
            usize::try_from(response - 1000)
                .ok()
                .filter(|i| *i < buttons.len())
                .unwrap_or(cancel_id)
        };
        #[cfg(windows)]
        let result = windows_dialog::show(parent, &title, &message, &buttons, cancel_id);
        #[cfg(not(any(target_os = "macos", windows)))]
        let result = {
            let _ = (&title, &message, &buttons);
            cancel_id
        };
        let _ = send.send(result);
    })
    .map_err(|_| "无法显示对话框")?;
    receive.await.map_err(|_| "对话框已关闭".into())
}

/// App Nap (a hidden window, an app in the background) would let macOS
/// throttle the app until its connections die and completion notifications
/// stop. The page holds this while any computer is paired; it is a
/// user-initiated activity that still lets an idle Mac sleep.
#[tauri::command]
fn keep_awake(window: WebviewWindow, active: bool) -> Result<(), String> {
    require_app(&window)?;
    #[cfg(target_os = "macos")]
    app_nap::hold(active);
    #[cfg(not(target_os = "macos"))]
    let _ = active;
    Ok(())
}

#[cfg(target_os = "macos")]
mod app_nap {
    use objc2::rc::Retained;
    use objc2::runtime::{NSObjectProtocol, ProtocolObject};
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};
    use std::sync::Mutex;

    struct Activity(Retained<ProtocolObject<dyn NSObjectProtocol>>);
    // SAFETY: the token is opaque and only ever handed back to NSProcessInfo,
    // whose activity methods are documented as thread-safe.
    unsafe impl Send for Activity {}

    static ACTIVITY: Mutex<Option<Activity>> = Mutex::new(None);

    pub fn hold(active: bool) {
        let Ok(mut current) = ACTIVITY.lock() else {
            return;
        };
        let info = NSProcessInfo::processInfo();
        match (active, current.take()) {
            (true, Some(activity)) => *current = Some(activity),
            (true, None) => {
                let reason = NSString::from_str("Panecast keeps paired computers connected");
                *current = Some(Activity(info.beginActivityWithOptions_reason(
                    NSActivityOptions::UserInitiatedAllowingIdleSystemSleep,
                    &reason,
                )));
            }
            // SAFETY: the token came from `beginActivityWithOptions_reason`.
            (false, Some(activity)) => unsafe { info.endActivity(&activity.0) },
            (false, None) => {}
        }
    }
}

fn open_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        window.show()?;
        window.set_focus()?;
        return Ok(());
    }
    let navigation_app = app.clone();
    let popup_app = app.clone();
    let transport = app.state::<Transport>().inner().clone();
    let state_path = app
        .path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("window-state.json"));
    let saved = state_path.as_deref().and_then(window_state::load);
    let displays: Vec<window_state::Area> = app
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|monitor| {
            let scale = monitor.scale_factor();
            let position = monitor.position().to_logical::<f64>(scale);
            let size = monitor.size().to_logical::<f64>(scale);
            window_state::Area {
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
            }
        })
        .collect();
    let (position, (width, height)) = window_state::placement(saved, &displays);
    let mut builder =
        tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
            .title("Panecast")
            .inner_size(width, height)
            .min_inner_size(window_state::MIN_SIZE.0, window_state::MIN_SIZE.1)
            .maximized(saved.is_some_and(|saved| saved.maximized));
    builder = match position {
        Some((x, y)) => builder.position(x, y),
        None => builder.center(),
    };
    // ⌘W only hides the window. WebKit would otherwise suspend the hidden
    // page within minutes (macOS 14+ honours this setting): its sockets'
    // keepalive replies, reconnect timers and completion checks would stop.
    #[cfg(target_os = "macos")]
    let builder = builder.background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled);
    let window = builder
        .background_color(tauri::window::Color(26, 27, 38, 255))
        // Let WebKit deliver OS-selected files to the shared HTML drop zone.
        .disable_drag_drop_handler()
        .on_navigation(move |url| {
            if security::app_url(url) {
                return true;
            }
            if url.scheme() == "https" {
                let _ = navigation_app.opener().open_url(url.as_str(), None::<&str>);
            }
            false
        })
        .on_new_window(move |url, _| {
            if url.scheme() == "https" {
                let _ = popup_app.opener().open_url(url.as_str(), None::<&str>);
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .on_page_load(move |_, event| {
            if matches!(event.event(), tauri::webview::PageLoadEvent::Started) {
                transport.disconnect();
            }
        })
        .build()?;
    let transport = app.state::<Transport>().inner().clone();
    let handle = window.clone();
    window.on_window_event(move |event| match event {
        // ⌘W on the Mac hides the window: the connection, the terminal state
        // and completion notifications stay alive, and the Dock brings it
        // back at once. Windows has no Dock, so closing there quits.
        #[cfg(target_os = "macos")]
        tauri::WindowEvent::CloseRequested { api, .. } => {
            save_window(&handle, state_path.as_deref());
            api.prevent_close();
            let _ = handle.hide();
        }
        #[cfg(not(target_os = "macos"))]
        tauri::WindowEvent::CloseRequested { .. } => save_window(&handle, state_path.as_deref()),
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
            save_window(&handle, state_path.as_deref())
        }
        tauri::WindowEvent::Destroyed => transport.disconnect(),
        // Coming back to the app is when a waiting fix is most useful.
        #[cfg(target_os = "macos")]
        tauri::WindowEvent::Focused(true) => updater::on_focus(handle.app_handle()),
        _ => {}
    });
    Ok(())
}

fn save_window(window: &WebviewWindow, path: Option<&std::path::Path>) {
    let Some(path) = path else { return };
    // Minimized or hidden windows report sizes that are not worth keeping.
    if window.is_minimized().unwrap_or(true) || !window.is_visible().unwrap_or(false) {
        return;
    }
    let maximized = window.is_maximized().unwrap_or(false);
    let (Ok(scale), Ok(position), Ok(size)) = (
        window.scale_factor(),
        window.outer_position(),
        window.inner_size(),
    ) else {
        return;
    };
    let previous = window_state::load(path);
    // A maximized window keeps the frame it returns to.
    let (position, size) = match (maximized, previous) {
        (true, Some(previous)) => ((previous.x, previous.y), (previous.width, previous.height)),
        _ => {
            let position = position.to_logical::<f64>(scale);
            let size = size.to_logical::<f64>(scale);
            ((position.x, position.y), (size.width, size.height))
        }
    };
    window_state::store(
        path,
        &window_state::Saved {
            x: position.0,
            y: position.1,
            width: size.0,
            height: size.1,
            maximized,
        },
    );
}

/// The Mac menu bar's items that the page runs as its own shortcuts. Each is
/// emitted to the page by id as the `panecast-menu` event (client
/// ui/desktopShell `menuCommand`). The menu owns their key equivalents: the
/// page leaves those keys to it, so a shortcut runs once whether it is typed
/// or chosen from the menu.
#[cfg(target_os = "macos")]
const PAGE_MENU_ITEMS: [&str; 9] = [
    "new-workspace",
    "new-terminal",
    "close-terminal",
    "settings",
    "zoom-in",
    "zoom-out",
    "zoom-reset",
    "find",
    "toggle-sidebar",
];

/// Served with the download page, which loads in China where GitHub often does not.
#[cfg(target_os = "macos")]
const HELP_PAGES: [(&str, &str); 2] = [
    ("help", "https://ningzx.cn/panecast/support.html"),
    ("privacy", "https://ningzx.cn/panecast/privacy.html"),
];

#[cfg(target_os = "macos")]
fn mac_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
    let item = |id: &str, text: &str, accelerator: Option<&str>| {
        MenuItem::with_id(app, id, text, true, accelerator)
    };
    let separator = || PredefinedMenuItem::separator(app);
    let info = app.package_info();
    let about = AboutMetadata {
        name: Some(info.name.clone()),
        version: Some(info.version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        ..Default::default()
    };
    let app_menu = Submenu::with_items(
        app,
        "Panecast",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("关于 Panecast"), Some(about))?,
            &item("check-update", "检查更新…", None)?,
            &separator()?,
            &item("settings", "设置…", Some("Cmd+,"))?,
            &separator()?,
            &PredefinedMenuItem::services(app, Some("服务"))?,
            &separator()?,
            &PredefinedMenuItem::hide(app, Some("隐藏 Panecast"))?,
            &PredefinedMenuItem::hide_others(app, Some("隐藏其他"))?,
            &PredefinedMenuItem::show_all(app, Some("全部显示"))?,
            &separator()?,
            &PredefinedMenuItem::quit(app, Some("退出 Panecast"))?,
        ],
    )?;
    // ⌘W closes the terminal; with none open the page closes (hides) the
    // window instead, which ⇧⌘W always does.
    let file = Submenu::with_items(
        app,
        "文件",
        true,
        &[
            &item("new-workspace", "新建工作区", Some("Cmd+N"))?,
            &item("new-terminal", "新建终端", Some("Cmd+T"))?,
            &separator()?,
            &item("close-terminal", "关闭终端", Some("Cmd+W"))?,
            &item("close-window", "关闭窗口", Some("Cmd+Shift+W"))?,
        ],
    )?;
    // WKWebView needs these native items for ⌘C/⌘V and the rest in text fields.
    let edit = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &PredefinedMenuItem::undo(app, Some("撤销"))?,
            &PredefinedMenuItem::redo(app, Some("重做"))?,
            &separator()?,
            &PredefinedMenuItem::cut(app, Some("剪切"))?,
            &PredefinedMenuItem::copy(app, Some("复制"))?,
            &PredefinedMenuItem::paste(app, Some("粘贴"))?,
            &PredefinedMenuItem::select_all(app, Some("全选"))?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "显示",
        true,
        &[
            &item("zoom-in", "放大", Some("Cmd+="))?,
            &item("zoom-out", "缩小", Some("Cmd+-"))?,
            &item("zoom-reset", "实际大小", Some("Cmd+0"))?,
            &separator()?,
            &item("find", "查找…", Some("Cmd+F"))?,
            &separator()?,
            &item("toggle-sidebar", "显示/隐藏侧栏", Some("Ctrl+Cmd+S"))?,
            &PredefinedMenuItem::fullscreen(app, Some("进入全屏幕"))?,
        ],
    )?;
    let window = Submenu::with_id_and_items(
        app,
        "window-menu",
        "窗口",
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some("最小化"))?,
            &PredefinedMenuItem::maximize(app, Some("缩放"))?,
            &separator()?,
            &PredefinedMenuItem::bring_all_to_front(app, Some("前置全部窗口"))?,
        ],
    )?;
    let help = Submenu::with_id_and_items(
        app,
        "help-menu",
        "帮助",
        true,
        &[
            &item("help", "Panecast 使用帮助", None)?,
            &item("privacy", "隐私政策", None)?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window, &help])
}

/// Installs the menu bar: the Window menu lists the open windows and Help
/// gets the system's search field.
#[cfg(target_os = "macos")]
fn install_mac_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::MenuItemKind;
    let menu = mac_menu(app)?;
    app.set_menu(menu.clone())?;
    if let Some(MenuItemKind::Submenu(window)) = menu.get("window-menu") {
        window.set_as_windows_menu_for_nsapp()?;
    }
    if let Some(MenuItemKind::Submenu(help)) = menu.get("help-menu") {
        help.set_as_help_menu_for_nsapp()?;
    }
    app.on_menu_event(|app, event| menu_event(app, event.id().as_ref()));
    // The page asks for this when ⌘W finds no terminal to close.
    let closing = app.clone();
    tauri::Listener::listen(app, "panecast-close-window", move |_| {
        close_main_window(&closing)
    });
    Ok(())
}

#[cfg(target_os = "macos")]
fn menu_event(app: &tauri::AppHandle, id: &str) {
    if id == "check-update" {
        check_from_menu(app);
    } else if id == "close-window" {
        if main_is_key(app) {
            close_main_window(app);
        }
    } else if let Some((_, url)) = HELP_PAGES.iter().find(|(page, _)| *page == id) {
        let _ = app.opener().open_url(*url, None::<&str>);
    } else if PAGE_MENU_ITEMS.contains(&id) {
        // A hidden window comes back for everything but closing. Closing
        // acts on the main window only while it is in front: not while it is
        // hidden, nor while the About panel has the keyboard.
        if id != "close-terminal" {
            let _ = open_window(app);
        } else if !main_is_key(app) {
            return;
        }
        let _ = app.emit_to("main", "panecast-menu", id);
    }
}

/// Whether the main window is shown and has the keyboard.
#[cfg(target_os = "macos")]
fn main_is_key(app: &tauri::AppHandle) -> bool {
    app.get_webview_window("main").is_some_and(|window| {
        window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false)
    })
}

/// Closes the window as its red button does; on the Mac that hides it.
#[cfg(target_os = "macos")]
fn close_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.close();
    }
}

#[cfg(all(test, target_os = "macos"))]
mod menu_tests {
    /// Every item the menu hands to the page is one the page runs
    /// (`MENU_COMMANDS` in the client's ui/desktopShell.ts).
    #[test]
    fn page_menu_items_are_the_ones_the_page_runs() {
        let page = include_str!("../../../client/src/ui/desktopShell.ts");
        let start = page.find("const MENU_COMMANDS").expect("MENU_COMMANDS in desktopShell.ts");
        let commands = &page[start..start + page[start..].find("};").expect("end of MENU_COMMANDS")];
        for id in super::PAGE_MENU_ITEMS {
            assert!(
                commands.contains(&format!("'{id}':")) || commands.contains(&format!(" {id}:")),
                "the page does not run the menu item {id}"
            );
        }
        assert_eq!(commands.matches(": { kind:").count(), super::PAGE_MENU_ITEMS.len());
    }
}

fn main() {
    let builder = tauri::Builder::default();
    // Windows still updates from the download page.
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            secret_get,
            secret_set,
            secret_delete,
            request,
            abort_request,
            socket_connect,
            socket_send,
            socket_close,
            clipboard_write,
            desktop_notify,
            notification_settings,
            local_gateway,
            keep_awake,
            dialog,
            open_shared_file,
            update_status,
            update_check,
            update_restart
        ])
        .setup(|app| {
            // macOS preserves the installed Electron app's credential directory.
            // Windows keeps the key on this computer, so the vault stays local too,
            // beside the WebView data and apart from the installation directory.
            #[cfg(windows)]
            let directory = app.path().app_local_data_dir()?;
            #[cfg(not(windows))]
            let directory = app.path().data_dir()?.join("Panecast");
            app.manage(VaultState(Arc::new(Mutex::new(Vault::new(
                directory,
                Box::new(SystemKeyStore),
            )))));
            app.manage(Transport::new().map_err(std::io::Error::other)?);
            let notification_app = app.handle().clone();
            app.notification().on_action(move |action| {
                if action.action_id() != "tap" {
                    return;
                }
                if let Some(target) = action
                    .notification()
                    .and_then(|notification| notification.extra().get("panecast"))
                {
                    let app = notification_app.clone();
                    let target = target.clone();
                    let _ = notification_app.run_on_main_thread(move || {
                        let _ = open_window(&app);
                        let _ = app.emit_to("main", "panecast-notification", target);
                    });
                }
            })?;
            // WKWebView needs the Edit menu for ⌘C/⌘V. On Windows a menu bar's
            // accelerators would take Ctrl+C and Ctrl+V from the terminal.
            #[cfg(target_os = "macos")]
            {
                install_mac_menu(app.handle())?;
                app.manage(updater::Updates::default());
                updater::start(app.handle());
            }
            open_window(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Unable to initialize Panecast")
        .run(|app, event| match event {
            // A Mac app stays open without windows and reopens from the Dock;
            // on Windows, closing the window quits.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                let _ = open_window(app);
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } => api.prevent_exit(),
            tauri::RunEvent::Exit => app.state::<Transport>().disconnect(),
            _ => {}
        });
}
