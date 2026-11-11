//! Confirmation dialogs on Windows: a task dialog with the app's own button
//! labels, falling back to a message box when the task dialog is unavailable.
use std::ptr::null_mut;
use windows_sys::{
    core::{BOOL, HRESULT, PCWSTR},
    Win32::{
        Foundation::HWND,
        System::LibraryLoader::{GetModuleHandleW, GetProcAddress, LoadLibraryW},
        UI::{
            Controls::{
                TASKDIALOGCONFIG, TASKDIALOG_BUTTON, TDF_ALLOW_DIALOG_CANCELLATION,
                TDF_POSITION_RELATIVE_TO_WINDOW, TDF_SIZE_TO_CONTENT,
            },
            WindowsAndMessaging::{
                MessageBoxW, IDOK, MB_DEFBUTTON2, MB_OK, MB_OKCANCEL, MB_SETFOREGROUND,
            },
        },
    },
};

type TaskDialogIndirect =
    unsafe extern "system" fn(*const TASKDIALOGCONFIG, *mut i32, *mut i32, *mut BOOL) -> HRESULT;
const FIRST_BUTTON: i32 = 1000;

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Comctl32 v6 (selected by the app manifest) exports TaskDialogIndirect. It is
/// resolved at run time so a missing export can never stop the app from loading.
fn task_dialog() -> Option<TaskDialogIndirect> {
    let name = wide("comctl32.dll");
    unsafe {
        let mut module = GetModuleHandleW(name.as_ptr());
        if module.is_null() {
            module = LoadLibraryW(name.as_ptr());
        }
        if module.is_null() {
            return None;
        }
        let function = GetProcAddress(module, c"TaskDialogIndirect".as_ptr().cast())?;
        Some(std::mem::transmute::<
            unsafe extern "system" fn() -> isize,
            TaskDialogIndirect,
        >(function))
    }
}

/// Shows a modal dialog over `parent` and returns the chosen button index.
/// Enter selects the cancel button; Esc and closing the dialog also cancel.
pub fn show(parent: isize, title: &str, message: &str, buttons: &[String], cancel: usize) -> usize {
    let owner = parent as HWND;
    let caption = wide("Panecast");
    let instruction = wide(title);
    let content = wide(message);
    let labels: Vec<Vec<u16>> = buttons.iter().map(|label| wide(label)).collect();
    if let Some(run) = task_dialog() {
        let items: Vec<TASKDIALOG_BUTTON> = labels
            .iter()
            .enumerate()
            .map(|(index, label)| TASKDIALOG_BUTTON {
                nButtonID: FIRST_BUTTON + index as i32,
                pszButtonText: label.as_ptr(),
            })
            .collect();
        let config = TASKDIALOGCONFIG {
            cbSize: std::mem::size_of::<TASKDIALOGCONFIG>() as u32,
            hwndParent: owner,
            dwFlags: TDF_ALLOW_DIALOG_CANCELLATION
                | TDF_POSITION_RELATIVE_TO_WINDOW
                | TDF_SIZE_TO_CONTENT,
            pszWindowTitle: caption.as_ptr(),
            pszMainInstruction: instruction.as_ptr(),
            pszContent: if message.is_empty() {
                std::ptr::null()
            } else {
                content.as_ptr()
            },
            cButtons: items.len() as u32,
            pButtons: items.as_ptr(),
            nDefaultButton: FIRST_BUTTON + cancel as i32,
            ..Default::default()
        };
        let mut pressed = 0;
        // SAFETY: the configuration and every string it points to outlive the modal call.
        if unsafe { run(&config, &mut pressed, null_mut(), null_mut()) } >= 0 {
            return usize::try_from(pressed - FIRST_BUTTON)
                .ok()
                .filter(|index| *index < buttons.len())
                .unwrap_or(cancel);
        }
    }
    // A message box cannot relabel its buttons: OK runs the first other action.
    let text = if message.is_empty() {
        title.to_string()
    } else {
        format!("{title}\n\n{message}")
    };
    let text = wide(&text);
    let single = buttons.len() == 1;
    let style = if single {
        MB_OK
    } else {
        MB_OKCANCEL | MB_DEFBUTTON2
    } | MB_SETFOREGROUND;
    let result = unsafe { MessageBoxW(owner, text.as_ptr() as PCWSTR, caption.as_ptr(), style) };
    if single {
        return 0;
    }
    if result == IDOK {
        (0..buttons.len())
            .find(|index| *index != cancel)
            .unwrap_or(cancel)
    } else {
        cancel
    }
}
