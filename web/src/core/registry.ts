import type {
  StructuredEditCapability,
  TargetDescriptor,
  TargetId,
  TargetSchema,
} from './types'

/**
 * Mirror of `TargetRegistry::builtin()`.
 *
 * Copied field-for-field from `crates/confdock-core/src/targets/*.rs`,
 * including the English `safetyNotes` verbatim — those strings are the
 * adapter's own promise about what it will patch, and paraphrasing them in the
 * UI would be how the interface starts lying about its capabilities.
 *
 * Order matches the registration order in `TargetRegistry::builtin()`.
 *
 * When the WASM bindings land, this file is deleted and `targets()` comes from
 * the real registry. Until then, `capability_contracts_match_real_schema_and_
 * validation` (crates/confdock-core/tests/fixtures.rs) is the test that keeps
 * the Rust side from drifting; this file has to be updated by hand alongside it.
 */

const CONF_SAFETY = (section: string) =>
  `Only unique existing ${section} keys without inline comments are patchable.`

interface TargetEntry {
  descriptor: TargetDescriptor
  schema: TargetSchema | null
  editCapabilities: StructuredEditCapability[]
  /** Substring that raises text detection to `likely`. Mirrors each adapter's
   * `detect()`. Advisory only. */
  detectionMarkers: string[]
}

export const TARGET_ENTRIES: readonly TargetEntry[] = [
  {
    descriptor: {
      id: 'mihomo',
      displayName: 'Mihomo',
      fileExtensions: ['yaml', 'yml'],
      capabilities: {
        rawEdit: true,
        validationLevel: 'static',
        nativeValidation: false,
        sections: ['top-level YAML mapping', 'proxies', 'proxy-groups', 'rules'],
      },
    },
    schema: {
      fields: [
        {
          path: '/mixed-port',
          valueType: 'integer',
          description: 'Mixed inbound port; must be between 1 and 65535.',
        },
      ],
    },
    editCapabilities: [
      {
        scope: { kind: 'exactPaths', paths: ['/mixed-port'] },
        operations: ['replaceExistingValue'],
        valueTypes: ['integer'],
        safetyNotes: 'Only an unambiguous top-level decimal scalar is patched.',
      },
    ],
    detectionMarkers: ['mixed-port:', 'proxy-groups:'],
  },
  {
    descriptor: {
      id: 'sing-box',
      displayName: 'sing-box',
      fileExtensions: ['json'],
      capabilities: {
        rawEdit: true,
        validationLevel: 'syntax',
        nativeValidation: false,
        sections: ['log', 'dns', 'inbounds', 'outbounds', 'route'],
      },
    },
    schema: {
      fields: [
        {
          path: '/log/level',
          valueType: 'string',
          description: 'sing-box log level.',
        },
      ],
    },
    editCapabilities: [
      {
        scope: { kind: 'existingJsonPointerValues' },
        operations: ['replaceExistingValue'],
        valueTypes: [
          'string',
          'integer',
          'boolean',
          'number',
          'object',
          'array',
          'null',
        ],
        safetyNotes:
          'Only an existing, unique RFC 6901 value span is replaced.',
      },
    ],
    detectionMarkers: [],
  },
  {
    descriptor: {
      id: 'surge',
      displayName: 'Surge',
      fileExtensions: ['conf'],
      capabilities: {
        rawEdit: true,
        validationLevel: 'basic',
        nativeValidation: false,
        sections: [
          'General',
          'Proxy',
          'Proxy Group',
          'Rule',
          'Script',
          'URL Rewrite',
        ],
      },
    },
    schema: null,
    editCapabilities: [
      {
        scope: {
          kind: 'existingSectionKeys',
          sections: ['General'],
          caseSensitive: true,
        },
        operations: ['replaceExistingValue'],
        valueTypes: ['string'],
        safetyNotes: CONF_SAFETY('General'),
      },
    ],
    detectionMarkers: ['[General]'],
  },
  {
    descriptor: {
      id: 'loon',
      displayName: 'Loon',
      fileExtensions: ['conf'],
      capabilities: {
        rawEdit: true,
        validationLevel: 'basic',
        nativeValidation: false,
        sections: [
          'General',
          'Proxy',
          'Proxy Group',
          'Rule',
          'Script',
          'Rewrite',
        ],
      },
    },
    schema: null,
    editCapabilities: [
      {
        scope: {
          kind: 'existingSectionKeys',
          sections: ['General'],
          caseSensitive: true,
        },
        operations: ['replaceExistingValue'],
        valueTypes: ['string'],
        safetyNotes: CONF_SAFETY('General'),
      },
    ],
    detectionMarkers: ['[General]'],
  },
  {
    descriptor: {
      id: 'quantumult-x',
      displayName: 'Quantumult X',
      fileExtensions: ['conf'],
      capabilities: {
        rawEdit: true,
        validationLevel: 'basic',
        nativeValidation: false,
        sections: [
          'general',
          'server_local',
          'filter_remote',
          'rewrite_remote',
          'policy',
        ],
      },
    },
    schema: null,
    editCapabilities: [
      {
        scope: {
          kind: 'existingSectionKeys',
          sections: ['general'],
          caseSensitive: true,
        },
        operations: ['replaceExistingValue'],
        valueTypes: ['string'],
        safetyNotes: CONF_SAFETY('general'),
      },
    ],
    detectionMarkers: ['[general]'],
  },
  {
    descriptor: {
      id: 'shadowrocket',
      displayName: 'Shadowrocket',
      fileExtensions: ['conf'],
      capabilities: {
        rawEdit: true,
        validationLevel: 'basic',
        nativeValidation: false,
        sections: ['General', 'Proxy', 'Proxy Group', 'Rule'],
      },
    },
    schema: null,
    editCapabilities: [
      {
        scope: {
          kind: 'existingSectionKeys',
          sections: ['General'],
          caseSensitive: true,
        },
        operations: ['replaceExistingValue'],
        valueTypes: ['string'],
        safetyNotes: CONF_SAFETY('General'),
      },
    ],
    detectionMarkers: ['[General]'],
  },
]

const BY_ID = new Map<TargetId, TargetEntry>(
  TARGET_ENTRIES.map((entry) => [entry.descriptor.id, entry]),
)

export function targetEntry(id: TargetId): TargetEntry | null {
  return BY_ID.get(id) ?? null
}

export function targetDescriptors(): TargetDescriptor[] {
  return TARGET_ENTRIES.map((entry) => entry.descriptor)
}

/** Which sections a structured edit may touch, derived from the capability
 * rather than hard-coded per target. Used by the fields view to list the keys
 * it is allowed to offer. */
export function editableSections(id: TargetId): {
  sections: string[]
  caseSensitive: boolean
} | null {
  const entry = targetEntry(id)
  if (!entry) return null
  for (const capability of entry.editCapabilities) {
    if (capability.scope.kind === 'existingSectionKeys') {
      return {
        sections: capability.scope.sections,
        caseSensitive: capability.scope.caseSensitive,
      }
    }
  }
  return null
}
