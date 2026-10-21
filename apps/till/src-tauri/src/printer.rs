//! Sends ready-made ESC/POS bytes to a receipt printer. The bytes are built in
//! TypeScript (packages/receipt); this side only delivers them.
//!
//! Two targets:
//! - a Windows printer, through the print spooler in RAW mode (no driver formatting);
//! - a network printer, over TCP (port 9100 on most thermal printers).

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

/// Receipts are a few KB; anything bigger is a bug, not a receipt.
const MAX_JOB_BYTES: usize = 256 * 1024;

#[derive(Debug, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum PrintTarget {
    /// `printer_name: None` means the Windows default printer.
    #[serde(rename_all = "camelCase")]
    Windows { printer_name: Option<String> },
    #[serde(rename_all = "camelCase")]
    Network { host: String, port: u16 },
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrinterInfo {
    pub name: String,
    pub is_default: bool,
}

pub fn print_raw(target: &PrintTarget, bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() {
        return Err("Nothing to print".into());
    }
    if bytes.len() > MAX_JOB_BYTES {
        return Err("The print job is too large".into());
    }
    match target {
        PrintTarget::Network { host, port } => print_network(host, *port, bytes),
        PrintTarget::Windows { printer_name } => windows::print(printer_name.as_deref(), bytes),
    }
}

pub fn list_printers() -> Result<Vec<PrinterInfo>, String> {
    windows::list()
}

fn print_network(host: &str, port: u16, bytes: &[u8]) -> Result<(), String> {
    let unreachable = || format!("Printer not reachable at {host}:{port}");
    let addr = (host, port)
        .to_socket_addrs()
        .map_err(|_| unreachable())?
        .next()
        .ok_or_else(unreachable)?;
    let mut stream =
        TcpStream::connect_timeout(&addr, Duration::from_secs(3)).map_err(|_| unreachable())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    stream
        .write_all(bytes)
        .and_then(|_| stream.flush())
        .map_err(|e| format!("Printer at {host}:{port} stopped accepting data ({e})"))?;
    let _ = stream.shutdown(std::net::Shutdown::Write);
    Ok(())
}

#[cfg(windows)]
mod windows {
    use super::PrinterInfo;
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::Graphics::Printing::{
        ClosePrinter, EndDocPrinter, EndPagePrinter, EnumPrintersW, GetDefaultPrinterW,
        OpenPrinterW, StartDocPrinterW, StartPagePrinter, WritePrinter, DOC_INFO_1W,
        PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL, PRINTER_HANDLE, PRINTER_INFO_4W,
    };

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe fn from_wide(ptr: *const u16) -> String {
        if ptr.is_null() {
            return String::new();
        }
        let mut len = 0;
        while *ptr.add(len) != 0 {
            len += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len))
    }

    fn default_printer() -> Option<String> {
        let mut size: u32 = 0;
        unsafe {
            GetDefaultPrinterW(std::ptr::null_mut(), &mut size);
            if size == 0 {
                return None;
            }
            let mut buf = vec![0u16; size as usize];
            if GetDefaultPrinterW(buf.as_mut_ptr(), &mut size) == 0 {
                return None;
            }
            Some(from_wide(buf.as_ptr()))
        }
    }

    /// Closes the printer handle however the job ends.
    struct Handle(PRINTER_HANDLE);
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe {
                ClosePrinter(self.0);
            }
        }
    }

    pub fn print(name: Option<&str>, bytes: &[u8]) -> Result<(), String> {
        let name = match name {
            Some(n) if !n.trim().is_empty() => n.to_string(),
            _ => default_printer().ok_or("No Windows default printer is set")?,
        };
        let failed = |step: &str| {
            let code = unsafe { GetLastError() };
            format!("Printer \"{name}\" did not accept the receipt ({step}, error {code})")
        };
        let wide_name = wide(&name);
        let mut doc_name = wide("Receipt");
        let mut datatype = wide("RAW");
        unsafe {
            let mut raw = PRINTER_HANDLE::default();
            if OpenPrinterW(wide_name.as_ptr(), &mut raw, std::ptr::null()) == 0 {
                return Err(failed("open"));
            }
            let handle = Handle(raw);
            let info = DOC_INFO_1W {
                pDocName: doc_name.as_mut_ptr(),
                pOutputFile: std::ptr::null_mut(),
                pDatatype: datatype.as_mut_ptr(),
            };
            if StartDocPrinterW(handle.0, 1, &info) == 0 {
                return Err(failed("start"));
            }
            let mut ok = StartPagePrinter(handle.0) != 0;
            let mut written: u32 = 0;
            if ok {
                ok = WritePrinter(
                    handle.0,
                    bytes.as_ptr().cast(),
                    bytes.len() as u32,
                    &mut written,
                ) != 0
                    && written as usize == bytes.len();
                EndPagePrinter(handle.0);
            }
            EndDocPrinter(handle.0);
            if !ok {
                return Err(failed("write"));
            }
        }
        Ok(())
    }

    pub fn list() -> Result<Vec<PrinterInfo>, String> {
        let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
        let mut needed: u32 = 0;
        let mut count: u32 = 0;
        unsafe {
            EnumPrintersW(
                flags,
                std::ptr::null(),
                4,
                std::ptr::null_mut(),
                0,
                &mut needed,
                &mut count,
            );
            // The first call only reports the buffer size; zero means no printers.
            if needed == 0 {
                return Ok(Vec::new());
            }
            // u64 storage keeps the buffer aligned for the structs Windows writes into it.
            let mut buf = vec![0u64; (needed as usize).div_ceil(8)];
            if EnumPrintersW(
                flags,
                std::ptr::null(),
                4,
                buf.as_mut_ptr().cast(),
                needed,
                &mut needed,
                &mut count,
            ) == 0
            {
                return Err("Could not list printers".into());
            }
            let default = default_printer();
            let infos =
                std::slice::from_raw_parts(buf.as_ptr().cast::<PRINTER_INFO_4W>(), count as usize);
            Ok(infos
                .iter()
                .map(|info| {
                    let name = from_wide(info.pPrinterName);
                    let is_default = default.as_deref() == Some(name.as_str());
                    PrinterInfo { name, is_default }
                })
                .collect())
        }
    }
}

#[cfg(not(windows))]
mod windows {
    use super::PrinterInfo;

    pub fn print(_name: Option<&str>, _bytes: &[u8]) -> Result<(), String> {
        Err("Windows printers work only on Windows".into())
    }

    pub fn list() -> Result<Vec<PrinterInfo>, String> {
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn sends_bytes_to_a_network_printer() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let receiver = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut received = Vec::new();
            socket.read_to_end(&mut received).unwrap();
            received
        });
        let target = PrintTarget::Network {
            host: "127.0.0.1".into(),
            port,
        };
        print_raw(&target, b"\x1b@hello\n").unwrap();
        assert_eq!(receiver.join().unwrap(), b"\x1b@hello\n");
    }

    #[test]
    fn reports_an_unreachable_network_printer() {
        // Bind then drop, so nothing listens on the port.
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let target = PrintTarget::Network {
            host: "127.0.0.1".into(),
            port,
        };
        let err = print_raw(&target, b"x").unwrap_err();
        assert_eq!(err, format!("Printer not reachable at 127.0.0.1:{port}"));
    }

    #[test]
    fn rejects_empty_and_oversized_jobs() {
        let target = PrintTarget::Network {
            host: "127.0.0.1".into(),
            port: 9,
        };
        assert!(print_raw(&target, b"").is_err());
        assert!(print_raw(&target, &vec![0u8; MAX_JOB_BYTES + 1]).is_err());
    }

    #[test]
    fn reads_targets_from_the_app() {
        let t: PrintTarget =
            serde_json::from_str(r#"{"mode":"network","host":"10.0.0.5","port":9100}"#).unwrap();
        assert!(matches!(t, PrintTarget::Network { port: 9100, .. }));
        let t: PrintTarget =
            serde_json::from_str(r#"{"mode":"windows","printerName":null}"#).unwrap();
        assert!(matches!(t, PrintTarget::Windows { printer_name: None }));
    }
}
