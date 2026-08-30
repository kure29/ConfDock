use std::fmt;

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ConfigPath(String);

impl ConfigPath {
    pub fn new(value: impl Into<String>) -> Result<Self, ConfigPathError> {
        let value = value.into();
        if !value.is_empty() && !value.starts_with('/') {
            return Err(ConfigPathError(value));
        }

        let bytes = value.as_bytes();
        let mut cursor = 0;
        while cursor < bytes.len() {
            if bytes[cursor] == b'~' {
                match bytes.get(cursor + 1) {
                    Some(b'0' | b'1') => cursor += 2,
                    _ => return Err(ConfigPathError(value)),
                }
            } else {
                cursor += 1;
            }
        }
        Ok(Self(value))
    }

    pub fn from_segments<'a>(segments: impl IntoIterator<Item = &'a str>) -> Self {
        let mut value = String::new();
        for segment in segments {
            value.push('/');
            value.push_str(&escape_segment(segment));
        }
        Self(value)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn decoded_segments(&self) -> Vec<String> {
        if self.0.is_empty() {
            return Vec::new();
        }
        self.0[1..].split('/').map(unescape_segment).collect()
    }
}

impl TryFrom<&str> for ConfigPath {
    type Error = ConfigPathError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl std::str::FromStr for ConfigPath {
    type Err = ConfigPathError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::new(value)
    }
}

impl fmt::Display for ConfigPath {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConfigPathError(String);

impl fmt::Display for ConfigPathError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "invalid RFC 6901 path: {}", self.0)
    }
}

impl std::error::Error for ConfigPathError {}

fn escape_segment(segment: &str) -> String {
    segment.replace('~', "~0").replace('/', "~1")
}

fn unescape_segment(segment: &str) -> String {
    let mut output = String::with_capacity(segment.len());
    let mut characters = segment.chars();
    while let Some(character) = characters.next() {
        if character == '~' {
            match characters.next() {
                Some('0') => output.push('~'),
                Some('1') => output.push('/'),
                _ => unreachable!("ConfigPath is validated when constructed"),
            }
        } else {
            output.push(character);
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::ConfigPath;

    #[test]
    fn pointer_segments_escape_reserved_characters() {
        let path = ConfigPath::from_segments(["a/b", "c~d", "e.f", "0"]);
        assert_eq!(path.as_str(), "/a~1b/c~0d/e.f/0");
        assert_eq!(path.decoded_segments(), ["a/b", "c~d", "e.f", "0"]);
    }

    #[test]
    fn invalid_tilde_escape_is_rejected() {
        assert!(ConfigPath::new("/bad~2escape").is_err());
    }
}
