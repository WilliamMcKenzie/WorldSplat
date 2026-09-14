import { defineConfig } from '@playwright/test'
export default defineConfig({
 testDir: './client/browser-tests',
 timeout: 60000,
 workers: 1,
 use: { baseURL: 'http://127.0.0.1:8099', ignoreHTTPSErrors: true, viewport: {width:1440,height:1000}, trace:'retain-on-failure', launchOptions:{args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']} },
 webServer: { command: 'python3 -m http.server 8099 --bind 127.0.0.1 --directory client', url:'http://127.0.0.1:8099', reuseExistingServer:!process.env.CI },
})
