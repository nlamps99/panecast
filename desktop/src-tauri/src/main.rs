mod security;
mod transport;
mod vault;

#[cfg(test)]
mod asset_tests;
#[cfg(test)]
mod production_tests;

use serde::Deserialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::{ipc::Channel, Manager, State, WebviewWindow};
use tauri_plugin_clipboard_manager::ClipboardExt;
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
    let (send, receive) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        #[cfg(target_os = "macos")]
        let result = {
            use objc2::MainThreadMarker;
            use objc2_app_kit::NSAlert;
            use objc2_foundation::NSString;
            let alert = NSAlert::new(MainThreadMarker::new().expect("main thread"));
            alert.setMessageText(&NSString::from_str(
                &options.title.chars().take(200).collect::<String>(),
            ));
            alert.setInformativeText(&NSString::from_str(
                &options
                    .message
                    .unwrap_or_default()
                    .chars()
                    .take(4000)
                    .collect::<String>(),
            ));
            for (index, title) in options.buttons.iter().enumerate() {
                let button = alert.addButtonWithTitle(&NSString::from_str(
                    &title.chars().take(100).collect::<String>(),
                ));
                // Enter defaults to cancellation, including destructive actions.
                button.setKeyEquivalent(&NSString::from_str(if index == options.cancel_id {
                    "\r"
                } else {
                    ""
                }));
            }
            let response = alert.runModal();
            usize::try_from(response - 1000)
                .ok()
                .filter(|i| *i < options.buttons.len())
                .unwrap_or(options.cancel_id)
        };
        #[cfg(not(target_os = "macos"))]
        let result = options.cancel_id;
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
    let window =
        tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
            .title("Panecast")
            .inner_size(1280.0, 860.0)
            .min_inner_size(760.0, 600.0)
            .background_color(tauri::window::Color(26, 27, 38, 255))
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
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            transport.disconnect();
        }
    });
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
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
            dialog
        ])
        .setup(|app| {
            // Preserve the installed Electron app's credential directory.
            let directory = app.path().data_dir()?.join("Panecast");
            app.manage(VaultState(Arc::new(Mutex::new(Vault::new(
                directory,
                Box::new(SystemKeyStore),
            )))));
            app.manage(Transport::new().map_err(std::io::Error::other)?);
            app.set_menu(tauri::menu::Menu::default(app.handle())?)?;
            open_window(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Unable to initialize Panecast")
        .run(|app, event| match event {
            tauri::RunEvent::Reopen { .. } => {
                let _ = open_window(app);
            }
            tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } => api.prevent_exit(),
            tauri::RunEvent::Exit => app.state::<Transport>().disconnect(),
            _ => {}
        });
}
