// Sets host-mode env vars then boots the main server (static + 0.0.0.0 bind).
process.env.AIM4_SERVE_STATIC = '1';
process.env.AIM4_HOST = '0.0.0.0';
await import('./index.js');
