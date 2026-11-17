//! Where the window was and how large, restored on the next launch. A saved
//! position no longer on any display (an unplugged monitor) is dropped so
//! the window never opens off screen.

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Saved {
    /// Logical points.
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub maximized: bool,
}

/// A display's area in logical points.
#[derive(Clone, Copy, Debug)]
pub struct Area {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub const DEFAULT_SIZE: (f64, f64) = (1280.0, 860.0);
pub const MIN_SIZE: (f64, f64) = (760.0, 600.0);

pub fn load(path: &Path) -> Option<Saved> {
    let saved: Saved = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    let finite = [saved.x, saved.y, saved.width, saved.height]
        .iter()
        .all(|v| v.is_finite());
    (finite && saved.width >= MIN_SIZE.0 && saved.height >= MIN_SIZE.1).then_some(saved)
}

pub fn store(path: &Path, saved: &Saved) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let temporary = path.with_extension("tmp");
    if let Ok(bytes) = serde_json::to_vec(saved) {
        if std::fs::write(&temporary, bytes).is_ok() {
            let _ = std::fs::rename(&temporary, path);
        }
    }
}

/// The saved frame when its title bar is on one of today's displays, sized
/// to fit there; otherwise only a size that fits the first display.
pub fn placement(saved: Option<Saved>, displays: &[Area]) -> (Option<(f64, f64)>, (f64, f64)) {
    let Some(saved) = saved else {
        return (None, DEFAULT_SIZE);
    };
    let fit = |area: &Area| {
        (
            saved.width.min(area.width).max(MIN_SIZE.0),
            saved.height.min(area.height).max(MIN_SIZE.1),
        )
    };
    // The title bar must be reachable: a strip near the top-left on screen.
    let probe = (saved.x + 40.0, saved.y + 10.0);
    match displays.iter().find(|area| {
        probe.0 >= area.x
            && probe.0 < area.x + area.width
            && probe.1 >= area.y
            && probe.1 < area.y + area.height
    }) {
        Some(area) => (Some((saved.x, saved.y)), fit(area)),
        None => (None, displays.first().map(fit).unwrap_or(DEFAULT_SIZE)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAIN: Area = Area {
        x: 0.0,
        y: 0.0,
        width: 1512.0,
        height: 982.0,
    };
    const SIDE: Area = Area {
        x: 1512.0,
        y: 0.0,
        width: 2560.0,
        height: 1440.0,
    };
    const SAVED: Saved = Saved {
        x: 1700.0,
        y: 100.0,
        width: 2000.0,
        height: 1200.0,
        maximized: false,
    };

    #[test]
    fn restores_a_frame_still_on_screen() {
        assert_eq!(
            placement(Some(SAVED), &[MAIN, SIDE]),
            (Some((1700.0, 100.0)), (2000.0, 1200.0))
        );
    }

    #[test]
    fn drops_a_position_on_a_display_that_is_gone_and_fits_the_size() {
        assert_eq!(placement(Some(SAVED), &[MAIN]), (None, (1512.0, 982.0)));
        assert_eq!(placement(None, &[MAIN]), (None, DEFAULT_SIZE));
    }

    #[test]
    fn round_trips_and_rejects_nonsense() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("window-state.json");
        store(&path, &SAVED);
        assert_eq!(load(&path), Some(SAVED));
        std::fs::write(&path, br#"{"x":0,"y":0,"width":10,"height":10}"#).unwrap();
        assert_eq!(load(&path), None);
        std::fs::write(&path, b"not json").unwrap();
        assert_eq!(load(&path), None);
    }
}
