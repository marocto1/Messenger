import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'./tests/browser', timeout:45000, workers:1, reporter:[['list'],['html',{open:'never'}]],
  use:{baseURL:'http://localhost:3000', trace:'retain-on-failure', screenshot:'only-on-failure', launchOptions:{...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_PATH}:{}),args:['--allow-loopback-in-peer-connection','--force-webrtc-ip-handling-policy=default_public_and_private_interfaces','--disable-features=WebRtcHideLocalIpsWithMdns','--no-sandbox','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'] }},
  webServer:[
    {command:'node tests/serve-ui.mjs',url:'http://localhost:14382/health',reuseExistingServer:false},
    {command:'node tests/serve-static.mjs',url:'http://localhost:3000',reuseExistingServer:false,env:{NEXT_DIST_DIR:'.next-ui',NEXT_PUBLIC_API_URL:'http://localhost:14382',NEXT_PUBLIC_WS_URL:'ws://localhost:14382/ws'}}
  ],
});
