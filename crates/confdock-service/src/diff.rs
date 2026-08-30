//! Bounded, source-preserving revision diffs.
//!
//! This module deliberately lives at the service boundary.  Revisions are
//! stored as native bytes, while the API exposes a line-oriented view that
//! keeps each line's real terminator visible.  No parser or serializer is
//! involved and the bytes in SQLite are never rewritten.

use similar::{capture_diff_slices, group_diff_ops, Algorithm, DiffOp, DiffTag};

use crate::dto::{
    RevisionDiffDocumentDto, RevisionDiffDto, RevisionDiffHunkDto, RevisionDiffLineDto,
    RevisionDiffLineEnding, RevisionDiffLineKind, RevisionSummaryDto,
};

/// Maximum combined size of the two source BLOBs accepted by the diff
/// operation.  This is intentionally smaller than the service's 64 MiB
/// configuration limit: a diff needs memory for both token arrays and output.
pub const MAX_DIFF_INPUT_BYTES: usize = 8 * 1024 * 1024;
/// Maximum combined number of logical lines in the two inputs.
pub const MAX_DIFF_INPUT_LINES: usize = 200_000;
/// Maximum number of rows returned in all hunks combined.
pub const MAX_DIFF_OUTPUT_LINES: usize = 10_000;
/// Number of unchanged rows retained around each changed region.
pub const DIFF_CONTEXT_LINES: usize = 3;

#[derive(Clone, Debug)]
pub(crate) struct RevisionDiffSource {
    pub summary: RevisionSummaryDto,
    pub source: Vec<u8>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DiffError {
    TooLarge,
    InvalidUtf8,
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
struct DiffToken {
    text: String,
    line_ending: RevisionDiffLineEnding,
}

#[derive(Debug)]
struct ParsedSource {
    lines: Vec<DiffToken>,
    has_utf8_bom: bool,
    line_ending: RevisionDiffLineEnding,
    trailing_newline: bool,
}

/// Compute a complete diff or fail closed when a resource boundary is
/// exceeded.  The caller runs this function in a Tokio blocking task.
pub(crate) fn build_revision_diff(
    from: RevisionDiffSource,
    to: RevisionDiffSource,
) -> Result<RevisionDiffDto, DiffError> {
    let combined_bytes = from
        .source
        .len()
        .checked_add(to.source.len())
        .ok_or(DiffError::TooLarge)?;
    if combined_bytes > MAX_DIFF_INPUT_BYTES {
        return Err(DiffError::TooLarge);
    }

    // Count terminators before allocating one owned String per line.  A file
    // made of millions of tiny lines must hit the line budget without first
    // exhausting the process heap.
    let from_line_count = logical_line_count(&from.source)?;
    let to_line_count = logical_line_count(&to.source)?;
    let combined_lines = from_line_count
        .checked_add(to_line_count)
        .ok_or(DiffError::TooLarge)?;
    if combined_lines > MAX_DIFF_INPUT_LINES {
        return Err(DiffError::TooLarge);
    }
    let from_parsed = parse_source(&from.source)?;
    let to_parsed = parse_source(&to.source)?;

    let from_document = document_metadata(&from.summary, &from_parsed);
    let to_document = document_metadata(&to.summary, &to_parsed);

    // The ID and hash are both stable identity signals at this boundary.  We
    // still parse the inputs above so metadata remains complete and limits are
    // enforced even for a large identical document.
    if from.summary.id == to.summary.id || from.summary.content_hash == to.summary.content_hash {
        return Ok(RevisionDiffDto {
            from: from_document,
            to: to_document,
            identical: true,
            additions: 0,
            deletions: 0,
            hunks: Vec::new(),
        });
    }

    let ops = capture_diff_slices(Algorithm::Myers, &from_parsed.lines, &to_parsed.lines);
    let additions = ops
        .iter()
        .filter(|op| op.tag() != DiffTag::Equal)
        .map(|op| op.new_range().len())
        .sum();
    let deletions = ops
        .iter()
        .filter(|op| op.tag() != DiffTag::Equal)
        .map(|op| op.old_range().len())
        .sum();

    let groups = group_diff_ops(ops, DIFF_CONTEXT_LINES);
    let mut hunks = Vec::with_capacity(groups.len());
    let mut output_lines = 0usize;
    for group in groups {
        let hunk = build_hunk(
            &group,
            &from_parsed.lines,
            &to_parsed.lines,
            &mut output_lines,
        )?;
        hunks.push(hunk);
    }

    Ok(RevisionDiffDto {
        from: from_document,
        to: to_document,
        identical: false,
        additions,
        deletions,
        hunks,
    })
}

fn parse_source(source: &[u8]) -> Result<ParsedSource, DiffError> {
    let (has_utf8_bom, body) = match source.strip_prefix(&[0xef, 0xbb, 0xbf]) {
        Some(body) => (true, body),
        None => (false, source),
    };
    // Revisions are normally validated as UTF-8 before they reach storage.
    // Keep this check here as a second, fail-closed boundary rather than
    // replacing invalid bytes with lossy replacement characters.
    std::str::from_utf8(body).map_err(|_| DiffError::InvalidUtf8)?;

    let mut lines = Vec::new();
    let mut start = 0usize;
    let mut lf_count = 0usize;
    let mut crlf_count = 0usize;
    for index in 0..body.len() {
        if body[index] != b'\n' {
            continue;
        }
        let (text_end, line_ending) = if index > start && body[index - 1] == b'\r' {
            crlf_count += 1;
            (index - 1, RevisionDiffLineEnding::CrLf)
        } else {
            lf_count += 1;
            (index, RevisionDiffLineEnding::Lf)
        };
        let text = std::str::from_utf8(&body[start..text_end])
            .map_err(|_| DiffError::InvalidUtf8)?
            .to_owned();
        lines.push(DiffToken { text, line_ending });
        start = index + 1;
    }
    if start < body.len() {
        let text = std::str::from_utf8(&body[start..])
            .map_err(|_| DiffError::InvalidUtf8)?
            .to_owned();
        lines.push(DiffToken {
            text,
            line_ending: RevisionDiffLineEnding::None,
        });
    }

    let line_ending = match (lf_count, crlf_count) {
        (0, 0) => RevisionDiffLineEnding::None,
        (0, _) => RevisionDiffLineEnding::CrLf,
        (_, 0) => RevisionDiffLineEnding::Lf,
        (_, _) => RevisionDiffLineEnding::Mixed,
    };
    Ok(ParsedSource {
        lines,
        has_utf8_bom,
        line_ending,
        trailing_newline: source.ends_with(b"\n"),
    })
}

fn logical_line_count(source: &[u8]) -> Result<usize, DiffError> {
    let body = source.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(source);
    std::str::from_utf8(body).map_err(|_| DiffError::InvalidUtf8)?;
    let terminated = body.iter().filter(|byte| **byte == b'\n').count();
    if body.is_empty() || body.ends_with(b"\n") {
        Ok(terminated)
    } else {
        terminated.checked_add(1).ok_or(DiffError::TooLarge)
    }
}

fn document_metadata(
    summary: &RevisionSummaryDto,
    parsed: &ParsedSource,
) -> RevisionDiffDocumentDto {
    RevisionDiffDocumentDto {
        summary: summary.clone(),
        has_utf8_bom: parsed.has_utf8_bom,
        line_ending: parsed.line_ending,
        trailing_newline: parsed.trailing_newline,
    }
}

fn build_hunk(
    group: &[DiffOp],
    old: &[DiffToken],
    new: &[DiffToken],
    output_lines: &mut usize,
) -> Result<RevisionDiffHunkDto, DiffError> {
    let old_start = group
        .iter()
        .map(|op| op.old_range().start)
        .min()
        .ok_or(DiffError::TooLarge)?;
    let new_start = group
        .iter()
        .map(|op| op.new_range().start)
        .min()
        .ok_or(DiffError::TooLarge)?;
    let old_end = group
        .iter()
        .map(|op| op.old_range().end)
        .max()
        .ok_or(DiffError::TooLarge)?;
    let new_end = group
        .iter()
        .map(|op| op.new_range().end)
        .max()
        .ok_or(DiffError::TooLarge)?;

    let old_count = old_end.saturating_sub(old_start);
    let new_count = new_end.saturating_sub(new_start);
    let mut lines = Vec::new();
    for op in group {
        let old_range = op.old_range();
        let new_range = op.new_range();
        match op.tag() {
            DiffTag::Equal => {
                for offset in 0..old_range.len() {
                    push_output_line(output_lines)?;
                    let old_index = old_range.start + offset;
                    let new_index = new_range.start + offset;
                    let token = old.get(old_index).ok_or(DiffError::TooLarge)?;
                    // Equal operations always have equal lengths and equal
                    // tokens. Use the old token for deterministic output.
                    let _ = new.get(new_index).ok_or(DiffError::TooLarge)?;
                    lines.push(RevisionDiffLineDto {
                        kind: RevisionDiffLineKind::Context,
                        old_line_no: Some(old_index + 1),
                        new_line_no: Some(new_index + 1),
                        text: token.text.clone(),
                        line_ending: token.line_ending,
                    });
                }
            }
            DiffTag::Delete => {
                for old_index in old_range {
                    push_output_line(output_lines)?;
                    let token = old.get(old_index).ok_or(DiffError::TooLarge)?;
                    lines.push(RevisionDiffLineDto {
                        kind: RevisionDiffLineKind::Delete,
                        old_line_no: Some(old_index + 1),
                        new_line_no: None,
                        text: token.text.clone(),
                        line_ending: token.line_ending,
                    });
                }
            }
            DiffTag::Insert => {
                for new_index in new_range {
                    push_output_line(output_lines)?;
                    let token = new.get(new_index).ok_or(DiffError::TooLarge)?;
                    lines.push(RevisionDiffLineDto {
                        kind: RevisionDiffLineKind::Insert,
                        old_line_no: None,
                        new_line_no: Some(new_index + 1),
                        text: token.text.clone(),
                        line_ending: token.line_ending,
                    });
                }
            }
            DiffTag::Replace => {
                for old_index in old_range {
                    push_output_line(output_lines)?;
                    let token = old.get(old_index).ok_or(DiffError::TooLarge)?;
                    lines.push(RevisionDiffLineDto {
                        kind: RevisionDiffLineKind::Delete,
                        old_line_no: Some(old_index + 1),
                        new_line_no: None,
                        text: token.text.clone(),
                        line_ending: token.line_ending,
                    });
                }
                for new_index in new_range {
                    push_output_line(output_lines)?;
                    let token = new.get(new_index).ok_or(DiffError::TooLarge)?;
                    lines.push(RevisionDiffLineDto {
                        kind: RevisionDiffLineKind::Insert,
                        old_line_no: None,
                        new_line_no: Some(new_index + 1),
                        text: token.text.clone(),
                        line_ending: token.line_ending,
                    });
                }
            }
        }
    }

    Ok(RevisionDiffHunkDto {
        old_start: old_start + 1,
        old_count,
        new_start: new_start + 1,
        new_count,
        lines,
    })
}

fn push_output_line(output_lines: &mut usize) -> Result<(), DiffError> {
    *output_lines = output_lines.checked_add(1).ok_or(DiffError::TooLarge)?;
    if *output_lines > MAX_DIFF_OUTPUT_LINES {
        return Err(DiffError::TooLarge);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::{DiagnosticDto, ValidationResultDto};

    fn summary(id: &str, revision_no: i64, hash: &str) -> RevisionSummaryDto {
        RevisionSummaryDto {
            id: id.to_owned(),
            revision_no,
            parent_revision_id: None,
            created_at: "2026-08-30T00:00:00Z".to_owned(),
            byte_length: 0,
            content_hash: hash.to_owned(),
            validation: ValidationResultDto {
                level: "basic".to_owned(),
                diagnostics: Vec::<DiagnosticDto>::new(),
            },
            validator_version: None,
            is_current: false,
            is_served: false,
        }
    }

    fn source(id: &str, revision_no: i64, bytes: &[u8], hash: &str) -> RevisionDiffSource {
        let mut value = summary(id, revision_no, hash);
        value.byte_length = bytes.len();
        RevisionDiffSource {
            summary: value,
            source: bytes.to_vec(),
        }
    }

    #[test]
    fn preserves_unicode_line_endings_and_direction() {
        let from = source("from", 1, "家庭\r\nold\n".as_bytes(), &"a".repeat(64));
        let to = source("to", 2, "家庭\r\nnew\n".as_bytes(), &"b".repeat(64));
        let diff = build_revision_diff(from, to).unwrap();
        assert_eq!(diff.from.line_ending, RevisionDiffLineEnding::Mixed);
        assert_eq!(diff.to.line_ending, RevisionDiffLineEnding::Mixed);
        assert_eq!(diff.additions, 1);
        assert_eq!(diff.deletions, 1);
        assert_eq!(diff.hunks[0].lines[1].text, "old");
        assert_eq!(diff.hunks[0].lines[2].text, "new");
    }

    #[test]
    fn bom_and_trailing_newline_are_metadata_not_normalized() {
        let from = source("from", 1, b"\xef\xbb\xbfa\n", &"a".repeat(64));
        let to = source("to", 2, b"a", &"b".repeat(64));
        let diff = build_revision_diff(from, to).unwrap();
        assert!(diff.from.has_utf8_bom);
        assert!(!diff.to.has_utf8_bom);
        assert!(diff.from.trailing_newline);
        assert!(!diff.to.trailing_newline);
        assert!(!diff.identical);
    }

    #[test]
    fn identical_hash_skips_hunks() {
        let hash = "c".repeat(64);
        let diff = build_revision_diff(
            source("from", 1, b"same\n", &hash),
            source("to", 2, b"same\n", &hash),
        )
        .unwrap();
        assert!(diff.identical);
        assert!(diff.hunks.is_empty());
        assert_eq!(diff.additions, 0);
        assert_eq!(diff.deletions, 0);
    }

    #[test]
    fn rejects_input_and_output_limits_without_truncating() {
        let huge = vec![b'x'; MAX_DIFF_INPUT_BYTES / 2 + 1];
        let result = build_revision_diff(
            source("from", 1, &huge, &"a".repeat(64)),
            source("to", 2, &huge, &"b".repeat(64)),
        );
        assert_eq!(result, Err(DiffError::TooLarge));

        let old = (0..(MAX_DIFF_OUTPUT_LINES / 2 + 1))
            .map(|index| format!("old-{index}\n"))
            .collect::<String>();
        let new = (0..(MAX_DIFF_OUTPUT_LINES / 2 + 1))
            .map(|index| format!("new-{index}\n"))
            .collect::<String>();
        let result = build_revision_diff(
            source("from", 1, old.as_bytes(), &"a".repeat(64)),
            source("to", 2, new.as_bytes(), &"b".repeat(64)),
        );
        assert_eq!(result, Err(DiffError::TooLarge));
    }

    #[test]
    fn handles_empty_single_line_insertions_and_deletions() {
        let inserted = build_revision_diff(
            source("from", 1, b"", &"a".repeat(64)),
            source("to", 2, b"one\n", &"b".repeat(64)),
        )
        .unwrap();
        assert_eq!((inserted.additions, inserted.deletions), (1, 0));
        assert_eq!(inserted.hunks[0].old_count, 0);
        assert_eq!(inserted.hunks[0].new_count, 1);
        assert_eq!(inserted.hunks[0].lines[0].new_line_no, Some(1));

        let deleted = build_revision_diff(
            source("from", 1, b"one\n", &"a".repeat(64)),
            source("to", 2, b"", &"b".repeat(64)),
        )
        .unwrap();
        assert_eq!((deleted.additions, deleted.deletions), (0, 1));
        assert_eq!(deleted.hunks[0].old_count, 1);
        assert_eq!(deleted.hunks[0].new_count, 0);
        assert_eq!(deleted.hunks[0].lines[0].old_line_no, Some(1));

        let one_line = build_revision_diff(
            source("from", 1, b"old", &"a".repeat(64)),
            source("to", 2, b"new", &"b".repeat(64)),
        )
        .unwrap();
        assert_eq!(one_line.hunks[0].old_start, 1);
        assert_eq!(one_line.hunks[0].new_start, 1);
        assert_eq!(one_line.hunks[0].lines.len(), 2);
    }

    #[test]
    fn mixed_line_ending_tokens_are_not_normalized() {
        let diff = build_revision_diff(
            source("from", 1, b"a\n", &"a".repeat(64)),
            source("to", 2, b"a\r\n", &"b".repeat(64)),
        )
        .unwrap();
        assert_eq!((diff.additions, diff.deletions), (1, 1));
        assert_eq!(
            diff.hunks[0].lines[0].line_ending,
            RevisionDiffLineEnding::Lf
        );
        assert_eq!(
            diff.hunks[0].lines[1].line_ending,
            RevisionDiffLineEnding::CrLf
        );
    }

    #[test]
    fn rejects_line_count_before_token_allocation() {
        let many_lines = vec![b'\n'; MAX_DIFF_INPUT_LINES + 1];
        let result = build_revision_diff(
            source("from", 1, &many_lines, &"a".repeat(64)),
            source("to", 2, b"", &"b".repeat(64)),
        );
        assert_eq!(result, Err(DiffError::TooLarge));
    }
}
