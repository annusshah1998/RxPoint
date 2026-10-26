//! WebView2 settings for the desktop till (Windows only).
//!
//! WebView2 acts on some browser keys before the page can cancel them: F5 and Ctrl+R
//! reload, Ctrl+P prints, Ctrl+F finds, F7 turns on caret browsing, Ctrl+plus/minus zoom
//! and Alt+←/→ go back and forward. A stray press mid-sale would reload or print the page,
//! so the till turns them off. Key events still reach the page, so the till's own shortcuts
//! (F1–F9, Alt+1–9, Ctrl+P reprint …) keep working. Tauri 2.12 has no option for this:
//! wry has one, but tauri-runtime-wry never sets it (docs/m2-design.md §8.4).

use tauri::{App, Manager};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Controller, ICoreWebView2Settings3,
};
use windows_core::Interface;

/// Turns off WebView2's browser keys in the main window. A failure is logged, not fatal:
/// the till still starts, and the page's own key guard (`app/keys.ts`) still runs.
pub fn turn_off_browser_keys(app: &App) {
    let Some(window) = app.get_webview_window("main") else {
        eprintln!("Browser keys left on: the main window was not found");
        return;
    };
    let result = window.with_webview(|webview| {
        let controller = webview.controller();
        if let Err(e) = disable_browser_keys(&controller) {
            eprintln!("Browser keys left on: {e}");
        }
        #[cfg(debug_assertions)]
        if let Err(e) = keep_dev_tools_keys(&controller) {
            eprintln!("F12 will not open the developer tools: {e}");
        }
    });
    if let Err(e) = result {
        eprintln!("Browser keys left on: {e}");
    }
}

fn disable_browser_keys(controller: &ICoreWebView2Controller) -> windows_core::Result<()> {
    // COM calls on the main thread, where `with_webview` runs. The cast fails only on a
    // WebView2 runtime older than 1.0.864 (2021).
    unsafe {
        controller
            .CoreWebView2()?
            .Settings()?
            .cast::<ICoreWebView2Settings3>()?
            .SetAreBrowserAcceleratorKeysEnabled(false)
    }
}

/// Debug builds only. Turning the browser keys off also turns off F12 and Ctrl+Shift+I,
/// so this opens the developer tools on those keys again in `tauri dev`. Every other key
/// behaves as in a release build, which has no developer tools at all.
#[cfg(debug_assertions)]
fn keep_dev_tools_keys(controller: &ICoreWebView2Controller) -> windows_core::Result<()> {
    use webview2_com::AcceleratorKeyPressedEventHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_KEY_EVENT_KIND, COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetKeyState, VK_CONTROL, VK_F12, VK_I, VK_SHIFT,
    };

    fn held(key: u16) -> bool {
        // The high bit is set while the key is down.
        unsafe { GetKeyState(i32::from(key)) < 0 }
    }

    let handler = AcceleratorKeyPressedEventHandler::create(Box::new(|controller, args| {
        let (Some(controller), Some(args)) = (controller, args) else {
            return Ok(());
        };
        let mut kind = COREWEBVIEW2_KEY_EVENT_KIND::default();
        let mut key = 0u32;
        unsafe {
            args.KeyEventKind(&mut kind)?;
            args.VirtualKey(&mut key)?;
        }
        let dev_tools = key == u32::from(VK_F12)
            || (key == u32::from(VK_I) && held(VK_CONTROL) && held(VK_SHIFT));
        if kind == COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN && dev_tools {
            unsafe {
                args.SetHandled(true)?;
                controller.CoreWebView2()?.OpenDevToolsWindow()?;
            }
        }
        Ok(())
    }));
    let mut token = 0i64;
    unsafe { controller.add_AcceleratorKeyPressed(&handler, &mut token) }
}
