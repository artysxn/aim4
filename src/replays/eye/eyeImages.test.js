import assert from 'node:assert/strict';
import { clockLabel, limitImages, parseClock } from './eyeImages.js';

const shot = (n) => ({
  role: 'user',
  content: [
    { type: 'text', text: `picture ${n}` },
    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${n}` } }
  ]
});

// Only the newest two pictures stay; older ones become their text and a note.
const messages = [{ role: 'user', content: 'hi' }, shot(1), { role: 'assistant', content: 'ok' }, shot(2), shot(3)];
limitImages(messages);
assert.equal(typeof messages[1].content, 'string', 'the oldest picture is gone');
assert.match(messages[1].content, /picture 1/);
assert.match(messages[1].content, /removed/);
assert.ok(Array.isArray(messages[3].content) && Array.isArray(messages[4].content), 'the newest two stay');
assert.equal(messages[0].content, 'hi');

// Running it again changes nothing more.
limitImages(messages);
assert.ok(Array.isArray(messages[3].content));

assert.equal(parseClock('1:20'), 80);
assert.equal(parseClock('1.20'), 80);
assert.equal(parseClock('0:05'), 5);
assert.equal(parseClock('90'), 90);
assert.equal(parseClock(''), null);
assert.equal(parseClock('later'), null);
assert.equal(clockLabel(80), '1:20');
assert.equal(clockLabel(-3), '0:00');
console.log('eyeImages.test.js ok');
