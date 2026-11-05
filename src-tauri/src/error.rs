use serde::ser::{Serialize, SerializeStruct, Serializer};

/// Typed error returned by every Tauri command. Serialised as
/// `{ "code": "...", "message": "..." }` so the JS side can branch on `code`
/// without parsing English text.
#[derive(Debug, thiserror::Error)]
pub enum AudioError {
    #[error("no audio host is available")]
    NoHost,

    #[error("audio device not found: {0}")]
    DeviceNotFound(String),

    #[error("unsupported operation: {0}")]
    Unsupported(String),

    #[error("audio protocol error: {0}")]
    Protocol(String),

    #[error("audio bridge error: {0}")]
    Bridge(String),

    #[error("MIDI error: {0}")]
    Midi(String),

    #[error("operation timed out")]
    Timeout,

    #[error("audio engine is not running")]
    NotRunning,

    #[error("internal error: {0}")]
    Internal(String),

    #[error("audio thread stopped")]
    ThreadStopped,

    #[error("cpal: {0}")]
    Cpal(#[from] cpal::Error),

    #[error("I/O: {0}")]
    Io(#[from] std::io::Error),
}

impl AudioError {
    pub fn code(&self) -> &'static str {
        match self {
            AudioError::NoHost => "no_host",
            AudioError::DeviceNotFound(_) => "device_not_found",
            AudioError::Unsupported(_) => "unsupported",
            AudioError::Protocol(_) => "protocol",
            AudioError::Bridge(_) => "bridge",
            AudioError::Midi(_) => "midi",
            AudioError::Timeout => "timeout",
            AudioError::NotRunning => "not_running",
            AudioError::Internal(_) => "internal",
            AudioError::ThreadStopped => "thread_stopped",
            AudioError::Cpal(_) => "cpal",
            AudioError::Io(_) => "io",
        }
    }
}

impl Serialize for AudioError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut out = serializer.serialize_struct("AudioError", 2)?;
        out.serialize_field("code", self.code())?;
        out.serialize_field("message", &self.to_string())?;
        out.end()
    }
}
