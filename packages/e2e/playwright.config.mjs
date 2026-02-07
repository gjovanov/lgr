import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: process.env.CI ? 1 : 4,
  timeout: 30000,
  reporter: "html",
  use: {
    baseURL: process.env.BASE_URL || "http://localhost:4000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    actionTimeout: 1e4
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } }
  ],
  webServer: process.env.CI ? undefined : {
    command: "cd ../.. && bun run start",
    url: "http://localhost:4000",
    reuseExistingServer: true,
    timeout: 30000
  }
});
