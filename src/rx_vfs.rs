//! A non-default SQLite VFS that removes write/create flags from every file open.
//! Native nset storage continues to use SQLite's default VFS unchanged. Combined
//! with readonly_shm=1 on the source URI, this prevents sidecar creation even if
//! a producer removes its WAL between our preflight and SQLite's open.
use rusqlite::ffi;
use std::{
    ffi::{c_char, c_int},
    sync::{
        OnceLock,
        atomic::{AtomicPtr, Ordering},
    },
};

pub const NAME: &str = "nset-rx-readonly";
static BASE: AtomicPtr<ffi::sqlite3_vfs> = AtomicPtr::new(std::ptr::null_mut());
static REGISTERED: OnceLock<c_int> = OnceLock::new();

unsafe extern "C" fn open(
    _vfs: *mut ffi::sqlite3_vfs,
    name: *const c_char,
    file: *mut ffi::sqlite3_file,
    flags: c_int,
    output: *mut c_int,
) -> c_int {
    let base = BASE.load(Ordering::Acquire);
    if base.is_null() || name.is_null() {
        return ffi::SQLITE_CANTOPEN;
    }
    let flags = (flags
        & !(ffi::SQLITE_OPEN_READWRITE | ffi::SQLITE_OPEN_CREATE | ffi::SQLITE_OPEN_DELETEONCLOSE))
        | ffi::SQLITE_OPEN_READONLY;
    // SAFETY: BASE is SQLite's process-lifetime default VFS. SQLite supplies the
    // file storage using the cloned szOsFile and retains filename URI metadata.
    unsafe { ((*base).xOpen.unwrap())(base, name, file, flags, output) }
}
unsafe extern "C" fn delete(
    _vfs: *mut ffi::sqlite3_vfs,
    _name: *const c_char,
    _sync: c_int,
) -> c_int {
    ffi::SQLITE_READONLY
}

pub fn register() -> std::result::Result<(), c_int> {
    let rc = *REGISTERED.get_or_init(|| {
        // SAFETY: initialize SQLite before VFS lookup, clone its stable callback
        // table without changing the default, and leak the registered descriptor
        // because SQLite retains its address for the process lifetime. Only xOpen
        // and xDelete change; all other callbacks retain the original pAppData.
        unsafe {
            let rc = ffi::sqlite3_initialize();
            if rc != ffi::SQLITE_OK {
                return rc;
            }
            let base = ffi::sqlite3_vfs_find(std::ptr::null());
            if base.is_null() || (*base).xOpen.is_none() {
                return ffi::SQLITE_CANTOPEN;
            }
            BASE.store(base, Ordering::Release);
            let mut vfs = Box::new(std::ptr::read(base));
            vfs.zName = c"nset-rx-readonly".as_ptr();
            vfs.pNext = std::ptr::null_mut();
            vfs.xOpen = Some(open);
            vfs.xDelete = Some(delete);
            let vfs = Box::into_raw(vfs);
            ffi::sqlite3_vfs_register(vfs, 0)
        }
    });
    if rc == ffi::SQLITE_OK {
        Ok(())
    } else {
        Err(rc)
    }
}
