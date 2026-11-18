// Completes the generated Android and iPhone projects (npx cap add android|ios): camera permission
// for reading CME barcodes and the CCIH Integra icons. Safe to run more than once.
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const at = (p) => new URL(`../${p}`, import.meta.url);

if (existsSync(at('android'))) {
  const manifest = at('android/app/src/main/AndroidManifest.xml');
  let xml = readFileSync(manifest, 'utf8');
  if (!xml.includes('android.permission.CAMERA')) {
    xml = xml.replace('<uses-permission android:name="android.permission.INTERNET" />', [
      '<uses-permission android:name="android.permission.INTERNET" />',
      '    <uses-permission android:name="android.permission.CAMERA" />',
      '    <uses-feature android:name="android.hardware.camera" android:required="false" />',
    ].join('\n'));
    writeFileSync(manifest, xml);
  }
  cpSync(at('src-tauri/icons/android'), at('android/app/src/main/res'), { recursive: true });
  console.warn('Android: permissão de câmera e ícones aplicados.');
}

if (existsSync(at('ios'))) {
  const plist = at('ios/App/App/Info.plist');
  let xml = readFileSync(plist, 'utf8');
  if (!xml.includes('NSCameraUsageDescription')) {
    xml = xml.replace('<key>CFBundleDisplayName</key>', '<key>NSCameraUsageDescription</key>\n\t<string>A câmera lê os códigos de barras das etiquetas da CME.</string>\n\t<key>CFBundleDisplayName</key>');
    writeFileSync(plist, xml);
  }
  // iPhone icons cannot be transparent: the opaque version is used.
  cpSync(at('assets/ios-icon-1024.png'), at('ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'));
  console.warn('iPhone: descrição de uso da câmera e ícone aplicados.');
}
