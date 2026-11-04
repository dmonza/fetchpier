// REQ-0070 — secrets domain barrel (pure crypto + key + manifest).
//
// Encrypt/decrypt/parse/verify/mask all live here so the CLI and desktop share
// identical bytes; only key *custody* (safeStorage keystore, reveal gate) is
// Electron-specific and lives in `src/main/secrets/`.

export {
  encryptValue,
  decryptValue,
  generateWorkspaceKey,
  isEncryptedValue,
  loadSodium,
  KEY_BYTES,
  NONCE_BYTES,
  TAG_BYTES
} from './crypto'

export { formatKey, parseKey, deriveKeyId } from './key'

export {
  buildManifest,
  verifyKeyAgainstChallenge,
  serializeManifest,
  parseManifest,
  CHALLENGE_PLAINTEXT,
  CHALLENGE_AD,
  MANIFEST_VERSION,
  SECRETS_ALGORITHM,
  type SecretsManifest
} from './manifest'

export { keyMissingError, keyInvalidError, valueCorruptError, valueUnsetError } from './errors'

export {
  mintExecutionNonce,
  secretMarker,
  secretLogMask,
  createSecretMasker,
  type SecretMasker,
  type SecretMaskerInput
} from './markers'

export {
  collectReferencedVariableNames,
  resolveSecrets,
  type ResolveSecretsInput
} from './resolver'

export {
  classifyLocalWrite,
  emptyLocalValues,
  localValuesPath,
  resolveLocalValuesPath,
  readLocalValues,
  writeLocalValues,
  mergeEnvironmentLayers,
  persistScriptEnvChanges,
  isReservedPrefixValue,
  RESERVED_VALUE_PREFIX,
  type LocalValuesFile,
  type MergedEnvironment,
  type PersistScriptEnvChangesInput
} from './local-values'
