//! Files a shared window hands to its guest. The gateway gives a short-lived
//! HTTPS link; the app downloads it into `Downloads/Panecast` and opens it
//! with the default app. Only document and image kinds open directly: the
//! file was written by someone else's Claude, so anything that could run
//! (scripts, apps, installers, web pages) is only shown in Finder.

use futures_util::StreamExt;
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;

pub const MAX_BYTES: u64 = 60 * 1024 * 1024;

const OPENS: &[&str] = &[
    "pdf", "png", "jpg", "jpeg", "gif", "webp", "heic", "txt", "md", "csv", "tsv", "tex", "bib", "docx", "doc", "xlsx", "xls",
    "pptx", "ppt", "rtf", "pages", "numbers", "key", "odt", "ods", "odp",
];

/// A plain file name: no folders, controls, leading dots or reserved characters.
pub fn safe_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect();
    let trimmed = cleaned.trim().trim_start_matches('.').trim();
    let mut result: String = trimmed.chars().rev().take(150).collect::<Vec<_>>().into_iter().rev().collect();
    if result.is_empty() {
        result = "file".into();
    }
    result
}

/// Whether the default app may open this kind directly.
pub fn opens_directly(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| OPENS.contains(&extension.to_ascii_lowercase().as_str()))
}

/// `name`, or `name (2)`… when a file of that name exists already.
pub fn unique_path(directory: &Path, name: &str) -> PathBuf {
    let path = Path::new(name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or(name);
    let extension = path.extension().and_then(|s| s.to_str());
    for n in 1..1000 {
        let candidate = match (n, extension) {
            (1, _) => name.to_string(),
            (_, Some(extension)) => format!("{stem} ({n}).{extension}"),
            (_, None) => format!("{stem} ({n})"),
        };
        let full = directory.join(&candidate);
        if std::fs::symlink_metadata(&full).is_err() {
            return full;
        }
    }
    directory.join(format!("{stem}-{}", std::process::id()))
}

/// Only HTTPS links, without credentials in them.
pub fn valid_url(url: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(url).map_err(|_| "下载链接无效".to_string())?;
    if parsed.scheme() != "https" || !parsed.username().is_empty() || parsed.password().is_some() || parsed.host_str().is_none() {
        return Err("下载链接必须使用 HTTPS".into());
    }
    Ok(parsed)
}

/// Downloads into `directory` and returns the saved path.
pub async fn download(url: url::Url, directory: &Path, name: &str) -> Result<PathBuf, String> {
    tokio::fs::create_dir_all(directory).await.map_err(|_| "无法创建下载文件夹".to_string())?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|_| "无法下载文件".to_string())?;
    let response = client.get(url).send().await.map_err(|_| "连不上文件服务器，请稍后再试".to_string())?;
    match response.status().as_u16() {
        200 => {}
        403 | 404 => return Err("下载链接已过期，请再点一次".into()),
        status => return Err(format!("文件服务器没有返回文件（{status}）")),
    }
    if response.content_length().is_some_and(|length| length > MAX_BYTES) {
        return Err("文件太大".into());
    }
    let partial = directory.join(format!(".{}.panecast-{}", safe_name(name), std::process::id()));
    let mut output = tokio::fs::File::create(&partial).await.map_err(|_| "无法保存文件".to_string())?;
    let mut stream = response.bytes_stream();
    let mut written: u64 = 0;
    let result: Result<(), String> = async {
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| "下载中断，请再试一次".to_string())?;
            written += chunk.len() as u64;
            if written > MAX_BYTES {
                return Err("文件太大".into());
            }
            output.write_all(&chunk).await.map_err(|_| "无法保存文件".to_string())?;
        }
        output.flush().await.map_err(|_| "无法保存文件".to_string())
    }
    .await;
    drop(output);
    if let Err(error) = result {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(error);
    }
    let target = unique_path(directory, &safe_name(name));
    tokio::fs::rename(&partial, &target).await.map_err(|_| "无法保存文件".to_string())?;
    quarantine(&target);
    Ok(target)
}

/// Marks the file as downloaded, as a browser would, so Gatekeeper checks anything executable in it.
fn quarantine(path: &Path) {
    #[cfg(target_os = "macos")]
    {
        let seconds = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = std::process::Command::new("/usr/bin/xattr")
            .arg("-w")
            .arg("com.apple.quarantine")
            .arg(format!("0081;{seconds:x};Panecast;"))
            .arg(path)
            .status();
    }
    #[cfg(not(target_os = "macos"))]
    let _ = path;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_stay_in_the_download_folder() {
        assert_eq!(safe_name("../../.ssh/authorized_keys"), "authorized_keys");
        assert_eq!(safe_name("论文.docx"), "论文.docx");
        assert_eq!(safe_name("a\nb:c.pdf"), "abc.pdf");
        assert_eq!(safe_name("..."), "file");
        assert_eq!(safe_name("C:\\Users\\x\\report.xlsx"), "report.xlsx");
    }

    #[test]
    fn only_documents_open_directly() {
        for name in ["论文.docx", "a.PDF", "plot.png", "data.csv", "slides.pptx"] {
            assert!(opens_directly(name), "{name}");
        }
        for name in ["run.command", "x.sh", "page.html", "app.app", "setup.pkg", "a.dmg", "x.terminal", "macro.docm", "noext", "a.svg"] {
            assert!(!opens_directly(name), "{name}");
        }
    }

    #[test]
    fn links_must_be_https() {
        assert!(valid_url("https://nzx2.drinklake.com/panecast-files/v1/o/x/a.pdf?t=y").is_ok());
        assert!(valid_url("http://nzx2.drinklake.com/x").is_err());
        assert!(valid_url("file:///etc/passwd").is_err());
        assert!(valid_url("https://user:pw@example.com/x").is_err());
    }

    #[test]
    fn existing_names_get_a_number() {
        let directory = std::env::temp_dir().join(format!("panecast-shared-file-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("a.pdf"), b"x").unwrap();
        assert_eq!(unique_path(&directory, "a.pdf"), directory.join("a (2).pdf"));
        assert_eq!(unique_path(&directory, "b.pdf"), directory.join("b.pdf"));
        std::fs::remove_dir_all(&directory).unwrap();
    }
}
