import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { runtimeEnv, requireProductionEndpoints } from '../../../scripts/runtime.mjs';
const cwd = resolve(import.meta.dirname, '..');
const root = resolve(cwd, '..', '..');
const production = process.env.ANDROID_BUILD_TYPE === 'release';
const api = process.env.ANDROID_API_URL || (production ? '' : 'http://10.0.2.2:4000');
const ws = process.env.ANDROID_WS_URL || (api ? api.replace(/^http/, 'ws') + '/ws' : '');
if (production) requireProductionEndpoints(api, ws);
const env = runtimeEnv({ ...process.env, NEXT_PUBLIC_API_URL: api, NEXT_PUBLIC_WS_URL: ws });
execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:web'], { cwd: root, stdio: 'inherit', env, shell: process.platform === 'win32' });
if (!existsSync(resolve(cwd, 'android'))) execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['cap', 'add', 'android'], { cwd, env, shell: process.platform === 'win32', stdio: 'inherit' });
const manifest = resolve(cwd, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
if (existsSync(manifest)) {
  let xml = readFileSync(manifest, 'utf8');
  xml = xml.replace(/\sandroid:usesCleartextTraffic="[^"]*"/g, '');
  xml = xml.replace('<application', `<application android:usesCleartextTraffic="${production ? 'false' : api.startsWith('http://')}"`);
  for (const permission of ['android.permission.RECORD_AUDIO', 'android.permission.CAMERA', 'android.permission.POST_NOTIFICATIONS']) if (!xml.includes(permission)) xml = xml.replace('<application', `<uses-permission android:name="${permission}" />\n    <application`);
  if (!xml.includes('android:windowSoftInputMode')) xml = xml.replace('<activity', '<activity android:windowSoftInputMode="adjustResize"');
  if (!xml.includes('android:scheme="marocto-messenger"')) {
    const deepLink = `
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="marocto-messenger" />
            </intent-filter>`;
    xml = xml.replace('</activity>', `${deepLink}\n        </activity>`);
    console.log('[ANDROID] Deep links enabled: marocto-messenger://invite/<token> and marocto-messenger://chat/<conversationId>');
  }
  if (!xml.includes('android.intent.action.SEND')) {
    const shareTarget = `
            <intent-filter android:label="Share to Messenger">
                <action android:name="android.intent.action.SEND" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="*/*" />
            </intent-filter>
            <intent-filter android:label="Share to Messenger">
                <action android:name="android.intent.action.SEND_MULTIPLE" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="*/*" />
            </intent-filter>`;
    xml = xml.replace('</activity>', `${shareTarget}\n        </activity>`);
    console.log('[ANDROID] Android Share Target enabled.');
  }
  writeFileSync(manifest, xml);
}
const javaDir = resolve(cwd, 'android', 'app', 'src', 'main', 'java', 'com', 'marocto', 'messenger');
mkdirSync(javaDir, { recursive: true });
for (const file of ['MainActivity.java', 'ShareTargetPlugin.java']) writeFileSync(resolve(javaDir, file), readFileSync(resolve(cwd, 'native', file)));
const gradleFile = resolve(cwd, 'android', 'app', 'build.gradle');
if (existsSync(gradleFile)) {
  let gradle = readFileSync(gradleFile, 'utf8').replace(/versionCode \d+/, 'versionCode 10000').replace(/versionName "[^"]*"/, 'versionName "1.0.0"');
  writeFileSync(gradleFile, gradle);
}
cpSync(resolve(cwd,'native','res'),resolve(cwd,'android','app','src','main','res'),{recursive:true});
console.log('[ANDROID] Native ShareTarget plugin and Marocto icons installed.');

const google = resolve(cwd, 'android', 'app', 'google-services.json');
if (!existsSync(google)) console.warn('[PUSH] google-services.json is missing. The app can run, but FCM registration requires this Firebase file.');
console.log(`[ANDROID] API: ${api}`); console.log(`[ANDROID] WS : ${ws}`);

execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['cap','sync','android'], {cwd, env, shell: process.platform === 'win32', stdio:'inherit'});
