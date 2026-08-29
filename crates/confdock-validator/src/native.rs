use std::time::Duration;

/// Policy that a process-backed validator must implement before it can be
/// enabled: fixed binary/version, temporary working directory, timeout,
/// resource limits, non-root execution, bounded stdout/stderr, and redaction
/// of source bytes from logs.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeProcessPolicy {
    pub binary: String,
    pub fixed_version: String,
    pub run_as_non_root: bool,
    pub timeout: Duration,
    pub max_memory_bytes: u64,
    pub max_output_bytes: usize,
    pub log_source_bytes: bool,
}

impl NativeProcessPolicy {
    pub fn safe_defaults(binary: impl Into<String>, version: impl Into<String>) -> Self {
        Self {
            binary: binary.into(),
            fixed_version: version.into(),
            run_as_non_root: true,
            timeout: Duration::from_secs(10),
            max_memory_bytes: 256 * 1024 * 1024,
            max_output_bytes: 64 * 1024,
            log_source_bytes: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::NativeProcessPolicy;

    #[test]
    fn safe_defaults_are_non_root_and_redacted() {
        let policy = NativeProcessPolicy::safe_defaults("mihomo", "1.0.0");
        assert!(policy.run_as_non_root);
        assert!(!policy.log_source_bytes);
        assert!(policy.max_output_bytes > 0);
    }
}
