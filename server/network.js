// ---------------------------------------------------------------------------
// server/network.js
// Print LAN addresses so the host can share http://IP:PORT with friends.
// ---------------------------------------------------------------------------

import os from 'os';

export function getLanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      out.push({ name, address: iface.address });
    }
  }
  return out;
}

/** Best-effort public (WAN) IPv4 lookup via a couple of plain-text services. */
export async function fetchPublicIp(timeoutMs = 4000) {
  const services = ['https://api.ipify.org', 'https://ipv4.icanhazip.com'];
  for (const url of services) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const ip = (await res.text()).trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip;
    } catch {
      /* try next service */
    }
  }
  return null;
}

export async function printHostBanner(port, publicIp) {
  const lines = [
    '',
    '============================================================',
    '  AIM4.io is running — share this address with friends:',
    '============================================================',
    '',
    `  This PC:     http://127.0.0.1:${port}`,
    ''
  ];
  const lan = getLanAddresses();
  if (lan.length) {
    lines.push('  On your network (LAN):');
    for (const { name, address } of lan) {
      lines.push(`    http://${address}:${port}   (${name})`);
    }
    lines.push('');
  } else {
    lines.push('  (No LAN IPv4 found — use your public IP if playing over the internet.)');
    lines.push('');
  }

  if (publicIp === undefined) publicIp = await fetchPublicIp();
  if (publicIp) {
    lines.push('  Over the internet (friends anywhere in the world):');
    lines.push(`    http://${publicIp}:${port}`);
    lines.push('');
    lines.push('  For that public link to work you MUST also:');
    lines.push(`    1. Forward TCP port ${port} on your router to this PC's LAN IP.`);
    lines.push(`    2. Allow Node.js (or TCP port ${port}) through your firewall.`);
    lines.push('  (start-host.bat tries to add the firewall rule automatically.)');
  } else {
    lines.push('  Over the internet: find your public IP (e.g. https://api.ipify.org),');
    lines.push(`  forward TCP port ${port} on your router to this PC, allow it through`);
    lines.push(`  the firewall, then share http://YOUR_PUBLIC_IP:${port}`);
  }
  lines.push('');
  lines.push('  Friends: open the URL above, click Multiplayer, join your lobby code');
  lines.push('  (or just open the full invite link shown inside your lobby).');
  lines.push('  Multiplayer WebSocket: same host, path /ws (128 tick).');
  lines.push('');
  lines.push('  Stop the server with Ctrl+C.');
  lines.push('============================================================');
  lines.push('');
  console.log(lines.join('\n'));
}
