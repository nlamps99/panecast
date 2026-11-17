// Release builds on Windows are GUI apps without a console window.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod local_gateway;
mod security;
mod transport;
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
    let cancel_id = options.cancel_id;
    #[cfg(windows)]
    let parent = window.hwnd().map(|hwnd| hwnd.0 as isize).unwrap_or(0);
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

#[cfg(target_os = "macos")]
fn mac_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItemKind, PredefinedMenuItem, Submenu};
    let menu = Menu::default(app)?;
    // Keep the native close action and its standard Command-W shortcut, while
    // making the entry discoverable in the same language as the app.
    let file = Submenu::with_items(
        app,
        "文件",
        true,
        &[&PredefinedMenuItem::close_window(app, Some("关闭窗口"))?],
    )?;
    let mut replaced = false;
    for (index, item) in menu.items()?.iter().enumerate() {
        if matches!(item, MenuItemKind::Submenu(submenu) if submenu.text()? == "File") {
            menu.remove_at(index)?;
            menu.insert(&file, index)?;
            replaced = true;
            break;
        }
    }
    if !replaced {
        menu.append(&file)?;
    }
    Ok(menu)
}

fn main() {
    tauri::Builder::default()
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
            dialog
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
            app.set_menu(mac_menu(app.handle())?)?;
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
