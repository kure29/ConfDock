import type { TargetId } from '../core/types'

/**
 * Seed documents for the mock API.
 *
 * Verbatim copies of `fixtures/mihomo/config.yaml`,
 * `fixtures/singbox/config.json` and `fixtures/surge/config.conf`, so the UI is
 * exercised against the same awkward content the Rust tests use: anchors,
 * aliases, merge keys, a block scalar, duplicate keys, quoted Chinese, and a
 * Surge script line containing a regex.
 *
 * Keeping the real content matters — a tidied-up sample would hide exactly the
 * cases where source-preserving editing earns its keep.
 */

export interface SeedProject {
  name: string
  targetId: TargetId
  fileName: string
  source: string
}

/** `fixtures/mihomo/config.yaml` */
const MIHOMO_YAML = `# Synthetic fixture: no real credentials.
mixed-port: 7890
allow-lan: true

# Quotes, anchors, aliases, merge keys and block scalar must survive edits.
profile: &profile
  store-selected: true
  note: 'keep single quotes'
defaults: *profile
merged: {<<: *profile, mode: "safe"}
unicode-note: "家庭网络"
script: |-
  line one
  line two
unknown-extension: custom-value
duplicate-key: one
duplicate-key: two
`

/** `fixtures/singbox/config.json` — note the duplicate `unknown-field` key,
 * which makes `/unknown-field` an ambiguous structured-edit target. */
const SINGBOX_JSON = `{
  "log": {
    "level": "info",
    "timestamp": true
  },
  "unknown-field": { "keep": "中文" },
  "unknown-field": { "keep": "duplicate is retained" },
  "outbounds": [
    { "type": "direct", "tag": "direct" }
  ]
}
`

/** `fixtures/surge/config.conf` — the `\\.` in the script line is a literal
 * backslash in the file and must survive the round-trip. */
const SURGE_CONF = `# Synthetic Surge fixture; credentials and endpoints are placeholders.
[General]
loglevel = notify
comment = "保留引号"

[Proxy]
Example = socks5, 127.0.0.1, 1080, user-placeholder, pass-placeholder

[Rule]
DOMAIN-SUFFIX,example.test,Example

[Script]
http-response ^https?://example\\.test script-path=https://example.test/a.js, requires-body=true

[Unknown Section]
custom = "未知"
custom = "重复键"
`

export const SEED_PROJECTS: readonly SeedProject[] = [
  {
    name: '家庭网络',
    targetId: 'mihomo',
    fileName: 'config.yaml',
    source: MIHOMO_YAML,
  },
  {
    name: '旅行',
    targetId: 'sing-box',
    fileName: 'config.json',
    source: SINGBOX_JSON,
  },
  {
    name: '备用',
    targetId: 'surge',
    fileName: 'config.conf',
    source: SURGE_CONF,
  },
]
