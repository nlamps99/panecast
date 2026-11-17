//! The gateway running on this computer leaves an owner-only credential
//! (`~/.cmuxremote/hub/local-gateway.json`). The desktop app beside it
//! connects over loopback with that token instead of pairing and routing every
//! keystroke through the server. The same user can already read the
//! gateway's own configuration, so this grants nothing new.

use crate::security::{bearer, service_url};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const MAX_BYTES: u64 = 16 * 1024;

pub fn file(home: &Path, config_dir: Option<PathBuf>) -> PathBuf {
    config_dir
        .unwrap_or_else(|| home.join(".cmuxremote"))
        .join("hub")
        .join("local-gateway.json")
}

fn text<'a>(value: &'a Value, key: &str, max: usize) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= max)
}

/// The checked credential, or None when it is missing, unreadable, readable
/// by other users, or names anything but a private or loopback gateway.
pub fn read(path: &Path) -> Option<Value> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_BYTES {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o077 != 0 {
            return None;
        }
    }
    let value: Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    let url = service_url(text(&value, "url", 512)?, true).ok()?;
    let health = service_url(text(&value, "health_url", 512)?, false).ok()?;
    if url.scheme() != "ws"
        || health.scheme() != "http"
        || url.host() != health.host()
        || url.port() != health.port()
        || url.path() != "/v1/ws"
        || health.path() != "/v1/health"
        || url.query().is_some()
    {
        return None;
    }
    let token = text(&value, "token", 512)?;
    if !bearer(&format!("Bearer {token}")) {
        return None;
    }
    Some(json!({
        "url": url.as_str(),
        "health_url": health.as_str(),
        "token": token,
        "device_id": text(&value, "device_id", 128)?,
        "relay_id": text(&value, "relay_id", 128),
        "broker_url": text(&value, "broker_url", 512),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, value: &Value, mode: u32) -> PathBuf {
        let path = dir.join("local-gateway.json");
        std::fs::write(&path, serde_json::to_vec(value).unwrap()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
        }
        #[cfg(not(unix))]
        let _ = mode;
        path
    }

    fn valid() -> Value {
        json!({ "version": 1, "url": "ws://127.0.0.1:4400/v1/ws", "health_url": "http://127.0.0.1:4400/v1/health",
            "device_id": "device", "token": "abc_DEF-123", "relay_id": "note-mac", "broker_url": "https://ningzx.example/cmux-remote", "backend": "hub" })
    }

    #[test]
    fn reads_an_owner_only_loopback_credential() {
        let dir = tempfile::tempdir().unwrap();
        let read = read(&write(dir.path(), &valid(), 0o600)).unwrap();
        assert_eq!(read["url"], "ws://127.0.0.1:4400/v1/ws");
        assert_eq!(read["token"], "abc_DEF-123");
        assert_eq!(read["relay_id"], "note-mac");
        assert!(read.get("backend").is_none());
    }

    #[test]
    fn rejects_shared_files_remote_hosts_and_mismatched_endpoints() {
        let dir = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        assert!(read(&write(dir.path(), &valid(), 0o644)).is_none());
        for (key, bad) in [
            ("url", "ws://203.0.113.9:4400/v1/ws"),
            ("url", "wss://127.0.0.1:4400/v1/ws"),
            ("url", "ws://127.0.0.1:4400/v1/ws?x=1"),
            ("health_url", "http://127.0.0.1:9/v1/health"),
            ("token", "bad token"),
            ("device_id", ""),
        ] {
            let mut value = valid();
            value[key] = json!(bad);
            assert!(
                read(&write(dir.path(), &value, 0o600)).is_none(),
                "{key}={bad}"
            );
        }
        assert!(read(&dir.path().join("missing.json")).is_none());
    }

    #[test]
    fn honors_the_gateway_config_directory() {
        let home = Path::new("/home/user");
        assert_eq!(
            file(home, None),
            Path::new("/home/user/.cmuxremote/hub/local-gateway.json")
        );
        assert_eq!(
            file(home, Some(PathBuf::from("/srv/panecast"))),
            Path::new("/srv/panecast/hub/local-gateway.json")
        );
    }
}
