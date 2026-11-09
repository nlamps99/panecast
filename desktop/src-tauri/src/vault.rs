use crate::security::storage_key;
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
};
use zeroize::Zeroizing;

const MAGIC: &[u8] = b"PANECAST2";
const SERVICE: &str = "com.nzx.panecast.desktop";
const ACCOUNT: &str = "credentials-v2";
const STORAGE_ERROR: &str = "无法读取登录信息，请解锁系统钥匙串后重试。";
type Secrets = BTreeMap<String, String>;

pub trait KeyStore: Send + Sync {
    fn get(&self, service: &str, account: &str) -> Result<Option<Vec<u8>>, String>;
    fn set(&self, service: &str, account: &str, value: &[u8]) -> Result<(), String>;
}
pub struct SystemKeyStore;
#[cfg(target_os = "macos")]
impl KeyStore for SystemKeyStore {
    fn get(&self, service: &str, account: &str) -> Result<Option<Vec<u8>>, String> {
        match security_framework::passwords::get_generic_password(service, account) {
            Ok(value) => Ok(Some(value)),
            Err(error) if error.code() == -25300 => Ok(None),
            Err(_) => Err(STORAGE_ERROR.into()),
        }
    }
    fn set(&self, service: &str, account: &str, value: &[u8]) -> Result<(), String> {
        security_framework::passwords::set_generic_password(service, account, value)
            .map_err(|_| STORAGE_ERROR.into())
    }
}
#[cfg(not(target_os = "macos"))]
impl KeyStore for SystemKeyStore {
    fn get(&self, _: &str, _: &str) -> Result<Option<Vec<u8>>, String> {
        Err("此版本仅支持 macOS".into())
    }
    fn set(&self, _: &str, _: &str, _: &[u8]) -> Result<(), String> {
        Err("此版本仅支持 macOS".into())
    }
}

// The caller serializes operations, including first-run migration and atomic writes.
pub struct Vault {
    directory: PathBuf,
    keys: Box<dyn KeyStore>,
}
impl Vault {
    pub fn new(directory: PathBuf, keys: Box<dyn KeyStore>) -> Self {
        Self { directory, keys }
    }
    fn master_key(&self, create: bool) -> Result<Zeroizing<Vec<u8>>, String> {
        if let Some(key) = self.keys.get(SERVICE, ACCOUNT)? {
            if key.len() != 32 {
                return Err(STORAGE_ERROR.into());
            }
            return Ok(Zeroizing::new(key));
        }
        if !create {
            return Err(STORAGE_ERROR.into());
        }
        let mut key = Zeroizing::new(vec![0; 32]);
        getrandom::fill(&mut key).map_err(|_| STORAGE_ERROR)?;
        self.keys.set(SERVICE, ACCOUNT, &key)?;
        Ok(key)
    }
    fn read(&self) -> Result<Secrets, String> {
        let file = self.directory.join("credentials-v2.enc");
        match fs::read(file) {
            Ok(bytes) => {
                let key = self.master_key(false)?;
                decode(&bytes, &key)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let bytes = match fs::read(self.directory.join("credentials.enc")) {
                    Ok(bytes) => bytes,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        return Ok(Secrets::new())
                    }
                    Err(_) => return Err(STORAGE_ERROR.into()),
                };
                // Electron 0.1.0 used Chromium's macOS v10 safeStorage format.
                // Keep that encrypted file intact, and only mark migration complete by
                // atomically writing a fully authenticated v2 vault. A failed unlock
                // never creates an empty replacement or discards a pairing.
                let password = Zeroizing::new(
                    self.keys
                        .get("Panecast Safe Storage", "Panecast")?
                        .ok_or(STORAGE_ERROR)?,
                );
                let data = decode_legacy(&bytes, &password)?;
                self.write(&data)?;
                Ok(data)
            }
            Err(_) => Err(STORAGE_ERROR.into()),
        }
    }
    fn write(&self, data: &Secrets) -> Result<(), String> {
        let key = self.master_key(true)?;
        let bytes = encode(data, &key)?;
        fs::create_dir_all(&self.directory).map_err(|_| "无法创建登录信息目录")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.directory, fs::Permissions::from_mode(0o700))
                .map_err(|_| "无法保护登录信息目录")?;
        }
        let temporary = self.directory.join("credentials-v2.enc.tmp");
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut output = options.open(&temporary).map_err(|_| "无法保存登录信息")?;
        output
            .write_all(&bytes)
            .and_then(|_| output.sync_all())
            .map_err(|_| "无法保存登录信息")?;
        fs::rename(temporary, self.directory.join("credentials-v2.enc"))
            .map_err(|_| "无法保存登录信息")?;
        Ok(())
    }
    pub fn get(&self, key: &str) -> Result<Option<String>, String> {
        storage_key(key)?;
        Ok(self.read()?.remove(key))
    }
    pub fn set(&self, key: &str, value: String) -> Result<(), String> {
        storage_key(key)?;
        if value.len() > 1024 * 1024 {
            return Err("存储内容过大".into());
        }
        let mut data = self.read()?;
        data.insert(key.into(), value);
        self.write(&data)
    }
    pub fn remove(&self, key: &str) -> Result<(), String> {
        storage_key(key)?;
        let mut data = self.read()?;
        data.remove(key);
        self.write(&data)
    }
}

fn parse(bytes: &[u8]) -> Result<Secrets, String> {
    let data: Secrets = serde_json::from_slice(bytes).map_err(|_| STORAGE_ERROR)?;
    for (key, value) in &data {
        storage_key(key)?;
        if value.len() > 1024 * 1024 {
            return Err(STORAGE_ERROR.into());
        }
    }
    Ok(data)
}
fn encode(data: &Secrets, key: &[u8]) -> Result<Vec<u8>, String> {
    let mut nonce = [0; 12];
    getrandom::fill(&mut nonce).map_err(|_| STORAGE_ERROR)?;
    let plain = Zeroizing::new(serde_json::to_vec(data).map_err(|_| STORAGE_ERROR)?);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| STORAGE_ERROR)?;
    let encrypted = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &plain,
                aad: MAGIC,
            },
        )
        .map_err(|_| STORAGE_ERROR)?;
    Ok([MAGIC, &nonce, &encrypted].concat())
}
fn decode(bytes: &[u8], key: &[u8]) -> Result<Secrets, String> {
    if !bytes.starts_with(MAGIC) || bytes.len() < MAGIC.len() + 12 + 16 {
        return Err(STORAGE_ERROR.into());
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| STORAGE_ERROR)?;
    let plain = Zeroizing::new(
        cipher
            .decrypt(
                Nonce::from_slice(&bytes[MAGIC.len()..MAGIC.len() + 12]),
                Payload {
                    msg: &bytes[MAGIC.len() + 12..],
                    aad: MAGIC,
                },
            )
            .map_err(|_| STORAGE_ERROR)?,
    );
    parse(&plain)
}
fn decode_legacy(bytes: &[u8], password: &[u8]) -> Result<Secrets, String> {
    let ciphertext = bytes.strip_prefix(b"v10").ok_or(STORAGE_ERROR)?;
    let mut key = Zeroizing::new([0u8; 16]);
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password, b"saltysalt", 1003, key.as_mut());
    let cipher = cbc::Decryptor::<aes::Aes128>::new_from_slices(key.as_ref(), &[b' '; 16])
        .map_err(|_| STORAGE_ERROR)?;
    let plain = Zeroizing::new(
        cipher
            .decrypt_padded_vec_mut::<Pkcs7>(ciphertext)
            .map_err(|_| STORAGE_ERROR)?,
    );
    parse(&plain)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    #[test]
    #[ignore = "accesses an isolated macOS Keychain item"]
    #[cfg(target_os = "macos")]
    fn system_keychain_roundtrip() {
        let service = format!("com.nzx.panecast.desktop.test.{}", std::process::id());
        let store = SystemKeyStore;
        store
            .set(&service, "test-only", b"non-secret-test-value")
            .unwrap();
        let result = store.get(&service, "test-only");
        security_framework::passwords::delete_generic_password(&service, "test-only").unwrap();
        assert_eq!(result.unwrap().unwrap(), b"non-secret-test-value");
        assert!(store.get(&service, "test-only").unwrap().is_none());
    }
    #[derive(Clone, Default)]
    struct MemoryKeys(Arc<Mutex<BTreeMap<String, Vec<u8>>>>);
    impl KeyStore for MemoryKeys {
        fn get(&self, service: &str, account: &str) -> Result<Option<Vec<u8>>, String> {
            Ok(self
                .0
                .lock()
                .unwrap()
                .get(&format!("{service}/{account}"))
                .cloned())
        }
        fn set(&self, service: &str, account: &str, value: &[u8]) -> Result<(), String> {
            self.0
                .lock()
                .unwrap()
                .insert(format!("{service}/{account}"), value.into());
            Ok(())
        }
    }
    #[test]
    fn vault_survives_restart_and_detects_tampering() {
        let dir = tempfile::tempdir().unwrap();
        let keys = MemoryKeys::default();
        let vault = Vault::new(dir.path().into(), Box::new(keys.clone()));
        vault
            .set("panecast.account.v1", "private-token".into())
            .unwrap();
        vault.set("panecast.clientId", "client-id".into()).unwrap();
        let restarted = Vault::new(dir.path().into(), Box::new(keys));
        assert_eq!(
            restarted.get("panecast.account.v1").unwrap().as_deref(),
            Some("private-token")
        );
        let file = dir.path().join("credentials-v2.enc");
        let mut bytes = fs::read(&file).unwrap();
        assert!(!bytes.windows(13).any(|chunk| chunk == b"private-token"));
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        fs::write(&file, &bytes).unwrap();
        assert!(restarted.get("panecast.account.v1").is_err());
        assert!(restarted.set("panecast.clientId", "new".into()).is_err());
        assert_eq!(fs::read(file).unwrap(), bytes);
    }
    #[test]
    fn electron_migration_preserves_credentials_and_does_not_resurrect_logout() {
        let dir = tempfile::tempdir().unwrap();
        let keys = MemoryKeys::default();
        keys.set("Panecast Safe Storage", "Panecast", b"test-legacy-key")
            .unwrap();
        // Fixture generated with Node crypto using Chromium's v10 parameters.
        let bytes = include_bytes!("../../test/legacy-vault.bin");
        fs::write(dir.path().join("credentials.enc"), bytes).unwrap();
        let vault = Vault::new(dir.path().into(), Box::new(keys));
        assert_eq!(
            vault.get("panecast.account.v1").unwrap().as_deref(),
            Some("test-account-token")
        );
        assert_eq!(
            vault.get("panecast.clientId").unwrap().as_deref(),
            Some("test-client-id")
        );
        vault.remove("panecast.account.v1").unwrap();
        assert_eq!(vault.get("panecast.account.v1").unwrap(), None);
        assert_eq!(fs::read(dir.path().join("credentials.enc")).unwrap(), bytes);
    }
    #[test]
    fn failed_keychain_access_preserves_legacy_file() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("credentials.enc"),
            include_bytes!("../../test/legacy-vault.bin"),
        )
        .unwrap();
        let vault = Vault::new(dir.path().into(), Box::<MemoryKeys>::default());
        assert!(vault.get("panecast.account.v1").is_err());
        assert!(!dir.path().join("credentials-v2.enc").exists());
    }
}
