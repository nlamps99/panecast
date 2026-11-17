//! Self-update for the Mac app.
//!
//! A few seconds after launch and then every few hours the app reads the
//! signed update manifest. A newer version is downloaded, its signature is
//! checked against the public key built into the app, and the app bundle is
//! replaced in place. The running copy keeps working; the new version starts
//! with the next launch, or right away when the user chooses to restart.
//! Every state change is sent to the window as `panecast-update`.

use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

const FIRST_CHECK: Duration = Duration::from_secs(8);
const CHECK_EVERY: Duration = Duration::from_secs(4 * 3600);
const PROGRESS_EVERY: Duration = Duration::from_millis(250);

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum UpdateState {
    Idle,
    Checking,
    Latest {
        checked_at: u64,
    },
    Downloading {
        version: String,
        downloaded: u64,
        total: Option<u64>,
    },
    /// Installed on disk; takes effect when the app restarts.
    Ready {
        version: String,
        notes: Option<String>,
    },
    Failed {
        message: String,
    },
}

#[derive(Clone, Debug, Serialize)]
pub struct UpdateStatus {
    pub current: String,
    #[serde(flatten)]
    pub state: UpdateState,
}

pub struct Updates {
    state: Mutex<UpdateState>,
    /// One check or download at a time, whether started by the timer or the user.
    running: tokio::sync::Mutex<()>,
}

impl Default for Updates {
    fn default() -> Self {
        Self {
            state: Mutex::new(UpdateState::Idle),
            running: tokio::sync::Mutex::new(()),
        }
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn status(app: &AppHandle) -> UpdateStatus {
    let state = app
        .state::<Updates>()
        .state
        .lock()
        .map(|s| s.clone())
        .unwrap_or(UpdateState::Idle);
    UpdateStatus {
        current: app.package_info().version.to_string(),
        state,
    }
}

fn set(app: &AppHandle, state: UpdateState) {
    if let Ok(mut current) = app.state::<Updates>().state.lock() {
        *current = state;
    }
    let _ = app.emit_to("main", "panecast-update", status(app));
}

fn ready(app: &AppHandle) -> bool {
    matches!(
        app.state::<Updates>().state.lock().as_deref(),
        Ok(UpdateState::Ready { .. })
    )
}

/// Checks now and installs what it finds. Returns the resulting status.
pub async fn check(app: &AppHandle) -> UpdateStatus {
    let updates = app.state::<Updates>();
    let _running = updates.running.lock().await;
    // Already installed: the next check belongs to the new version.
    if ready(app) {
        return status(app);
    }
    set(app, UpdateState::Checking);
    let result = async {
        let Some(update) = app.updater()?.check().await? else {
            return Ok::<_, tauri_plugin_updater::Error>(UpdateState::Latest {
                checked_at: now(),
            });
        };
        let version = update.version.clone();
        let (mut downloaded, mut shown) = (0u64, Instant::now() - PROGRESS_EVERY);
        set(
            app,
            UpdateState::Downloading {
                version: version.clone(),
                downloaded: 0,
                total: None,
            },
        );
        update
            .download_and_install(
                |chunk, total| {
                    downloaded += chunk as u64;
                    if shown.elapsed() >= PROGRESS_EVERY {
                        shown = Instant::now();
                        set(
                            app,
                            UpdateState::Downloading {
                                version: version.clone(),
                                downloaded,
                                total,
                            },
                        );
                    }
                },
                || {},
            )
            .await?;
        Ok(UpdateState::Ready {
            version,
            notes: update.body.clone().filter(|notes| !notes.trim().is_empty()),
        })
    }
    .await;
    set(
        app,
        result.unwrap_or_else(|error| UpdateState::Failed {
            message: describe(&error),
        }),
    );
    status(app)
}

fn describe(error: &tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error;
    match error {
        Error::Reqwest(_) | Error::Network(_) => "无法连接更新服务器，稍后会自动重试".into(),
        Error::Minisign(_) | Error::Base64(_) | Error::SignatureUtf8(_) => {
            "更新包签名校验失败，已放弃安装".into()
        }
        Error::Io(io) if io.kind() == std::io::ErrorKind::PermissionDenied => {
            "没有权限替换应用，请把 Panecast 放在“应用程序”文件夹".into()
        }
        other => format!("更新失败：{other}"),
    }
}

/// The periodic check, for the life of the app.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            check(&app).await;
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn states_reach_the_window_in_the_shape_the_bridge_reads() {
        let status = UpdateStatus {
            current: "0.2.10".into(),
            state: UpdateState::Downloading {
                version: "0.2.11".into(),
                downloaded: 5,
                total: Some(10),
            },
        };
        assert_eq!(
            serde_json::to_value(status).unwrap(),
            serde_json::json!({ "current": "0.2.10", "state": "downloading", "version": "0.2.11", "downloaded": 5, "total": 10 })
        );
        let ready = UpdateStatus {
            current: "0.2.10".into(),
            state: UpdateState::Ready {
                version: "0.2.11".into(),
                notes: None,
            },
        };
        assert_eq!(
            serde_json::to_value(ready).unwrap(),
            serde_json::json!({ "current": "0.2.10", "state": "ready", "version": "0.2.11", "notes": null })
        );
    }
}
