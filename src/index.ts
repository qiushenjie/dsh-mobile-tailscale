/**
 * Phone access to the existing DSH Web application through Tailscale Serve. The
 * ordinary Web listener remains loopback-only; this package owns the remote
 * channel that is the only route intended for phones, so tailnet membership is
 * the access control and no pairing secret or self-signed CA exists.
 */
export { Config, parseMobileConfig, parseUpstream } from './config.js'
export type { PluginConfig, ResolvedMobileConfig } from './config.js'
export {
  assertSupportedDshVersion,
  isSupportedDshVersion,
  SUPPORTED_DSH_VERSIONS,
  warnUnsupportedDshVersion,
} from './compatibility.js'
export {
  JsonMobileAccessControlStore,
  parseMobileAccessControlState,
} from './control.js'
export type {
  MobileAccessControlState,
  MobileAccessControlStore,
} from './control.js'
export {
  MOBILE_LAYOUT_NEXT_PATH,
  MobileAssetRoute,
  MobileBootBatchStore,
  mobileBootBatchKey,
  mobileHistoryRequestBody,
  prunedClientModuleRequest,
  revisionedStaticCacheControl,
  rewriteRemoteMobileIndex,
  rewriteRemoteMobileIndexWithBatches,
  sanitizeRequestHeaders,
  sanitizeResponseHeaders,
  sendMobileBootBatch,
  sendPrunedClientModule,
  stripIpv6Brackets,
  websocketAccept,
} from './mobile-frontend.js'
export type {
  MobileAssetRouteOptions,
  MobileBootBatchEntry,
  MobileBootBatchPayload,
  MobileBootBatchPlan,
  MobileLayoutMode,
  RewrittenMobileIndex,
} from './mobile-frontend.js'
export {
  EXTENSION_LIMITS,
  MobileAccessService,
  MobileExtensionError,
  assertExtensionId,
  createMobileAccessService,
  parseExtensionManifest,
} from './extensions.js'
export type {
  LocalExtensionManifest,
  MobileAccessService as MobileAccessRegistry,
  MobileActionContext,
  MobileExtensionClientEntry,
  MobileExtensionDefinition,
  MobileExtensionManifest,
  MobileExtensionStatus,
  MobileHostAction,
  MobileHostRoute,
  MobileRouteRequest,
  MobileRouteResponse,
} from './extensions.js'
export { AUTH_PREFIX, LOCAL_ADMIN_PREFIX } from './http-security.js'
export { isLoopbackAddress } from './network.js'
export { apply, inject, name } from './plugin.js'
