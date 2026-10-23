// Run: node src/replays/eye/eyeCommands.test.js
//
// The composer's slash commands: what a line is read as, the export files, the
// summary request and what replaces the chat after /compact.

import assert from 'node:assert/strict';
import { COMMANDS, compactedMessages, contextStats, exportJson, exportMarkdown, exportName, matchCommands, parseCommand, transcriptOf } from './eyeCommands.js';

// ---- reading a line ----
assert.equal(parseCommand('What are their weaknesses?'), null);
assert.equal(parseCommand('/'), null);
assert.equal(parseCommand('/ nothing'), null);
assert.equal(parseCommand('/demos/abc/def'), null, 'a path is a question');
assert.equal(parseCommand('//'), null);
assert.equal(parseCommand('/export').command.name, 'export');
assert.equal(parseCommand('/download').command.name, 'export', 'an alias');
assert.equal(parseCommand('/EXPORT md').args, 'md');
assert.equal(parseCommand('  /compact  ').command.name, 'compact');
assert.equal(parseCommand('/clear').command.name, 'new');
assert.deepEqual(parseCommand('/nope'), { unknown: 'nope' });
assert.equal(parseCommand('/export\nmore text'), null, 'a command is one line');
assert.ok(COMMANDS.every((c) => c.about && !c.about.includes('—')), 'every command says what it does, with no em dash');

// ---- the list under the cursor ----
assert.deepEqual(matchCommands('/').map((c) => c.name), COMMANDS.map((c) => c.name));
assert.deepEqual(matchCommands('/co').map((c) => c.name), ['compact', 'copy', 'context']);
assert.deepEqual(matchCommands('/dow').map((c) => c.name), ['export'], 'matches an alias');
assert.deepEqual(matchCommands('/export md'), [], 'closed once there is an argument');
assert.deepEqual(matchCommands('hello'), []);

// ---- a chat to export ----
const messages = [
  { role: 'user', content: 'Weaknesses of HAVU on Nuke?\n\nAttached by the user:\n- Team: HAVU', ui: { text: 'Weaknesses of HAVU on Nuke?', chips: [{ kind: 'team', label: 'HAVU' }] }, compacted: true },
  { role: 'assistant', content: 'Checking the rounds.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'find_weaknesses', arguments: '{"team":"HAVU","map":"Nuke"}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: `{"sides":[{"side":"T","weaknesses":["x"]}]}${'y'.repeat(4000)}` },
  { role: 'user', content: [{ type: 'text', text: 'The picture' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }] },
  { role: 'assistant', content: 'They lose their A fights, 5 deaths to 1 kill.' }
];
const meta = { title: 'Weaknesses of HAVU on Nuke?', exportedAt: '2026-10-18T10:00:00.000Z', model: 'qwen3.8-27b', systemPrompt: 'You are aim4 eye', tools: ['find_weaknesses'] };

// JSON: parses, keeps tool results whole, pictures out, the model and prompt in.
const json = JSON.parse(exportJson({ messages, meta }));
assert.equal(json.format, 'aim4-eye-chat');
assert.equal(json.model, 'qwen3.8-27b');
assert.equal(json.systemPrompt, 'You are aim4 eye');
assert.equal(json.messages.length, 5);
assert.equal(json.messages[2].content.length, messages[2].content.length, 'the tool result is whole');
assert.equal(json.messages[3].content[1].text, '[picture]');
assert.ok(!('compacted' in json.messages[0]), 'the in-memory flag is not exported');
assert.ok(!exportJson({ messages, meta }).includes('base64'));

// A result shortened for the model's context is exported whole (C16: the 17 Oct export was cut).
const shortened = [{ role: 'tool', tool_call_id: 'c9', content: 'short… [shortened to save space]', full: 'the whole result', compacted: true }];
const whole = JSON.parse(exportJson({ messages: shortened, meta })).messages[0];
assert.equal(whole.content, 'the whole result');
assert.ok(!('full' in whole));

// Markdown: reads as a conversation; long results are cut and say by how much.
const md = exportMarkdown({ messages, meta }, { resultChars: 100 });
assert.match(md, /^# Weaknesses of HAVU on Nuke\?/);
assert.match(md, /## You\n\nWeaknesses of HAVU on Nuke\?/);
assert.match(md, /_Attached: team HAVU_/);
assert.match(md, /> Checking the rounds\./);
assert.match(md, /\*\*find_weaknesses\*\* `\{"team":"HAVU","map":"Nuke"\}`/);
assert.match(md, /… \[\d+ more characters\]/);
assert.match(md, /## aim4 eye\n\nThey lose their A fights/);

// File names.
assert.equal(exportName('Weaknesses of HAVU on Nuke?', 'json', new Date('2026-10-18T10:00:00Z')), 'aim4-eye_weaknesses-of-havu-on-nuke_2026-10-18.json');
assert.equal(exportName('???', 'md', new Date('2026-10-18T10:00:00Z')), 'aim4-eye_chat_2026-10-18.md');

// ---- compact ----
const transcript = transcriptOf(messages, { resultChars: 50 });
assert.match(transcript, /^USER: Weaknesses of HAVU on Nuke\?\nNOTE: Checking the rounds\.\nTOOL find_weaknesses \{"team":"HAVU","map":"Nuke"\} -> \{"sides":/);
assert.match(transcript, /ASSISTANT: They lose their A fights/);
assert.ok(!transcript.includes('Attached by the user'), 'the question as the user typed it, not as the model read it');
assert.ok(transcript.length < 700, 'tool results are cut');

// A long answer's folded steps go to the summary as their lines, not call by call.
{
  const long = [
    { role: 'user', content: 'Notes on every playlist', ui: { text: 'Notes on every playlist' }, progress: '- round_briefs(playlist "A") -> 4 rounds\n- write_round_notes(4 notes) -> Wrote 4 of 4 round notes.' },
    { role: 'assistant', content: '', stepFolded: true, tool_calls: [{ id: 'f', type: 'function', function: { name: 'round_briefs', arguments: '{"playlist":"A"}' } }] },
    { role: 'tool', tool_call_id: 'f', stepFolded: true, content: 'z'.repeat(3000) },
    { role: 'assistant', content: 'Done: 4 notes.' }
  ];
  const t = transcriptOf(long);
  assert.match(t, /^USER: Notes on every playlist\nDONE \(a line per call\):\n- round_briefs\(playlist "A"\) -> 4 rounds\n/);
  assert.ok(!t.includes('zzz'), 'the folded results are not repeated');
  assert.match(t, /ASSISTANT: Done: 4 notes\.$/);
}

const after = compactedMessages('  HAVU lose A fights on Nuke T side.  ');
assert.equal(after.length, 2);
assert.equal(after[0].role, 'user');
assert.equal(after[0].ui.text, '/compact');
assert.equal(after[1].role, 'assistant');
assert.match(after[1].content, /^Summary of the conversation so far:\n\nHAVU lose A fights on Nuke T side\.$/);

// ---- context ----
const s = contextStats(messages, 48000);
assert.equal(s.questions, 1, 'a picture message is not a question');
assert.equal(s.toolCalls, 1);
assert.equal(s.shortened, 1);
assert.equal(s.messages, 5);
// The picture counts as the tokens it costs the model (eyeContext.js IMAGE_TOKENS), not its data URL's length.
assert.ok(s.percent >= 13 && s.percent <= 17, `${s.percent}%`);

console.log('eyeCommands.test.js ok');
