import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const alphaColorTypes = new Set([4, 6])

function fail(message) {
  throw new Error(message)
}

async function read(relativePath, encoding) {
  return readFile(resolve(root, relativePath), encoding)
}

function asString(value, label) {
  if (typeof value !== 'string') fail(`${label} must be a string`)
  return value
}

function singleMatch(source, pattern, label) {
  const matches = [...source.matchAll(pattern)]
  if (matches.length !== 1 || matches[0][1] === undefined) {
    fail(`${label} must appear exactly once`)
  }
  return matches[0][1]
}

function pngMetadata(buffer, label) {
  if (buffer.length < 33 || !buffer.subarray(0, pngSignature.length).equals(pngSignature)) {
    fail(`${label} is not a valid PNG`)
  }
  const ihdrLength = buffer.readUInt32BE(8)
  const ihdrName = buffer.toString('ascii', 12, 16)
  if (ihdrLength !== 13 || ihdrName !== 'IHDR') fail(`${label} has an invalid IHDR chunk`)

  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  const colorType = buffer[25]
  if (colorType === undefined) fail(`${label} has a truncated IHDR chunk`)

  let offset = 8
  let hasTransparencyChunk = false
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const chunkEnd = offset + 12 + length
    if (chunkEnd > buffer.length) fail(`${label} has a truncated PNG chunk`)
    const chunkName = buffer.toString('ascii', offset + 4, offset + 8)
    if (chunkName === 'tRNS') hasTransparencyChunk = true
    offset = chunkEnd
    if (chunkName === 'IEND') break
  }

  return {
    width,
    height,
    hasAlpha: alphaColorTypes.has(colorType) || hasTransparencyChunk,
  }
}

async function checkPng(relativePath, expectedWidth, expectedHeight = expectedWidth, requireAlpha = false) {
  const metadata = pngMetadata(await read(relativePath), relativePath)
  if (metadata.width !== expectedWidth || metadata.height !== expectedHeight) {
    fail(`${relativePath} must be ${expectedWidth}x${expectedHeight}, got ${metadata.width}x${metadata.height}`)
  }
  if (requireAlpha && !metadata.hasAlpha) {
    fail(`${relativePath} must contain an alpha channel for its transparent background`)
  }
}

async function checkBrandAndStoreIcon() {
  const masterPath = 'apps/mobile/brand/app-icon-master.png'
  const master = pngMetadata(await read(masterPath), masterPath)
  if (master.width !== master.height || master.width < 1024) {
    fail(`${masterPath} must be square and at least 1024x1024, got ${master.width}x${master.height}`)
  }
  if (!master.hasAlpha) fail(`${masterPath} must contain an alpha channel`)
  await checkPng('apps/mobile/store/android/icon-512.png', 512, 512, true)
}

async function checkAndroid() {
  const [gradle, manifest, networkSecurity, packageManifest, discovery, nativeAuth, nsdDiscovery, credentialStore, webViewClient, scanActivity, qrDecoder, nativeBridge] = await Promise.all([
    read('apps/mobile/android/app/build.gradle.kts', 'utf8'),
    read('apps/mobile/android/app/src/main/AndroidManifest.xml', 'utf8'),
    read('apps/mobile/android/app/src/main/res/xml/network_security_config.xml', 'utf8'),
    read('package.json', 'utf8'),
    read('apps/mobile/android/app/src/main/java/io/github/sayach/dshmobile/LanDiscovery.kt', 'utf8'),
    read('apps/mobile/android/app/src/main/java/io/github/sayach/dshmobile/NativeAuthClient.kt', 'utf8'),
    read('apps/mobile/android/app/src/main/java/io/github/sayach/dshmobile/NsdDiscovery.kt', 'utf8'),
    read('apps/mobile/android/app/src/main/java/io/github/sayach/dshmobile/DeviceCredentialStore.kt', 'utf8'),
    read('apps/mobile/android/app/src/main/java/io/github/sayach/dshmobile/SecureWebViewClient.kt', 'utf8'),
    read('apps/mobile/android/app/src/main/java/io/github/sayach/dshmobile/ScanActivity.kt', 'utf8'),
    read('apps/mobile/android/app/src/main/java/io/github/sayach/dshmobile/QrDecoder.kt', 'utf8'),
    read('apps/mobile/android/app/src/main/java/io/github/sayach/dshmobile/NativeBridge.kt', 'utf8'),
  ])
  const packageVersion = asString(JSON.parse(packageManifest).version, 'package.version')
  const compileSdk = singleMatch(gradle, /^\s*compileSdk\s*=\s*(\d+)\s*$/gm, 'Android compileSdk')
  const targetSdk = singleMatch(gradle, /^\s*targetSdk\s*=\s*(\d+)\s*$/gm, 'Android targetSdk')
  const versionName = singleMatch(gradle, /^\s*versionName\s*=\s*"([^"]+)"\s*$/gm, 'Android versionName')
  if (compileSdk !== '36' || targetSdk !== '36') {
    fail(`Android compileSdk and targetSdk must both be 36, got ${compileSdk} and ${targetSdk}`)
  }
  if (versionName !== packageVersion) {
    fail(`Android versionName ${JSON.stringify(versionName)} must equal package.version ${JSON.stringify(packageVersion)}`)
  }
  if (!/android:icon="@mipmap\/ic_launcher"/.test(manifest)
    || !/android:roundIcon="@mipmap\/ic_launcher"/.test(manifest)) {
    fail('Android manifest must use the checked launcher icon for icon and roundIcon')
  }
  if (!/android:usesCleartextTraffic="false"/.test(manifest)) {
    fail('Android manifest must keep cleartext traffic disabled')
  }
  for (const permission of [
    'android.permission.ACCESS_NETWORK_STATE',
    'android.permission.NEARBY_WIFI_DEVICES',
    'android.permission.CHANGE_WIFI_MULTICAST_STATE',
  ]) {
    if (!manifest.includes(permission)) fail(`Android manifest must declare ${permission}`)
  }
  if (!nativeAuth.includes('/mobile-access/discovery') || !nativeAuth.includes('HttpsURLConnection')) {
    fail('Android LAN discovery must probe the HTTPS discovery endpoint')
  }
  if (!discovery.includes('NsdDiscovery.scan') || !nsdDiscovery.includes('_dsh-mobile._tcp.')) {
    fail('Android LAN discovery must listen for DSH DNS-SD services')
  }
  if (!credentialStore.includes('AndroidKeyStore') || !credentialStore.includes('AES/GCM/NoPadding')) {
    fail('Android device credentials must remain encrypted by Android Keystore AES-GCM')
  }
  if (networkSecurity.includes('src="user"')) {
    fail('Android must not trust system-wide user-installed CAs')
  }
  if (!manifest.includes('android.permission.CAMERA')) {
    fail('Android manifest must declare CAMERA for QR pairing')
  }
  if (!qrDecoder.includes('MultiFormatReader') || !scanActivity.includes('QrDecoder.decodeNv21')) {
    fail('Android QR pairing must keep ZXing decoding wired to the scanner')
  }
  for (const marker of ['addJavascriptInterface', '@JavascriptInterface', 'MAX_MESSAGE_BYTES', 'MAX_PENDING', 'files.pick', 'camera.capture']) {
    if (!nativeBridge.includes(marker)) fail(`Android native bridge is missing ${marker}`)
  }
  if (!webViewClient.includes('error.primaryError == SslError.SSL_UNTRUSTED')
    || !webViewClient.includes('PinnedTls.acceptsWebViewLeaf')
    || !webViewClient.includes('handler.proceed()')) {
    fail('Android WebView private-CA handling must remain restricted to the pinned exact-origin leaf')
  }

  const densitySizes = {
    mdpi: 48,
    hdpi: 72,
    xhdpi: 96,
    xxhdpi: 144,
    xxxhdpi: 192,
  }
  await Promise.all(Object.entries(densitySizes).map(([density, size]) =>
    checkPng(`apps/mobile/android/app/src/main/res/mipmap-${density}/ic_launcher.png`, size, size, true)))
}

async function main() {
  await checkBrandAndStoreIcon()
  await checkAndroid()
  console.log('mobile release assets ok: brand artwork, store icon, Android manifest, network security, and bridge contracts verified')
}

main().catch((error) => {
  console.error(`mobile release check failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})

