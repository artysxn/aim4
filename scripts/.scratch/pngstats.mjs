import sharp from 'sharp';
for (const f of process.argv.slice(2)) {
  const img = sharp(f);
  const meta = await img.metadata();
  const st = await img.stats();
  console.log(f.split(/[\/]/).pop(), meta.width+'x'+meta.height, 'ch', meta.channels, 'alpha', meta.hasAlpha, st.channels.map(c => `[${c.min}-${c.max} mean ${c.mean.toFixed(0)}]`).join(' '));
}
