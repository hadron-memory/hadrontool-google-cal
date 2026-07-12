import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Tests always run against the dedicated test DB, regardless of .env —
    // same posture as the other capability tools / hadron-server.
    env: {
      DATABASE_URL: 'postgresql://holger@localhost:5432/hadrontool_google_cal_test',
      NODE_ENV: 'test',
      TOKEN_ENCRYPTION_KEY: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
      GOOGLE_CAL_TOOL_TOKEN: 'test-tool-token',
      GOOGLE_CLIENT_ID: 'test-client-id',
      GOOGLE_CLIENT_SECRET: 'test-client-secret',
    },
    // DB-backed route tests share tables; run files sequentially.
    fileParallelism: false,
  },
});
