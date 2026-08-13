// Run: node scripts/lib/simPython.test.mjs
//
// Discovery is mostly OS, and the OS is not mockable here — so what these
// tests pin is the part that is genuinely ours: the probe must FAIL CLEANLY.
// Every candidate in the search order is something that might not exist, might
// exist and not be python (Windows ships a `python3.exe` that is a Store
// advert), or might be python without numpy, and the pipeline that calls this
// has to survive all three and say which one happened. A probe that threw a
// raw spawn error at the first missing venv would never reach the python that
// is actually installed.
//
// The one machine-dependent assertion — that this box HAS a numpy-capable
// python — prints a skip note instead of failing, because a checkout without
// python is a legitimate state for everything except the train stage.

import { describePython, findPython, pythonCandidates, pythonProbe } from './simPython.mjs';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

// ---- the probe rejects things that are not python -------------------------------

{
  // node's own binary: it exists, it is executable, `-c` means something else
  // entirely to it, and it must come back as a clean "no" rather than an
  // exception. This is the shape of the Windows Store-stub case.
  const node = pythonProbe(process.execPath);
  assert(node.ok === false, 'the node binary is not python');
  assert(node.version === null && node.numpy === null, 'a non-python reports no version');
  assert(typeof node.error === 'string' && node.error.length > 0, 'and says why it was rejected');
  assert(node.command === process.execPath, 'the result names the candidate it probed');

  const missing = pythonProbe('aim4-definitely-not-a-real-interpreter');
  assert(missing.ok === false, 'a nonexistent command is not python');
  assert(missing.error === 'not found', `ENOENT reads as "not found", got "${missing.error}"`);

  const empty = pythonProbe('');
  assert(empty.ok === false && empty.error, 'an empty command fails cleanly too');
}

// ---- the search order -----------------------------------------------------------

{
  const order = pythonCandidates({}).map((c) => c.source);
  assert(order[0] === '.venv-sim (windows)', 'venv before PATH');
  assert(order[1] === '.venv-sim (posix)', 'both venv layouts are tried');
  assert(order[2] === 'PATH' && order[3] === 'PATH', 'python3 then python on PATH');
  assert(pythonCandidates({}).length === 4, 'four candidates without an override');

  const withOverride = pythonCandidates({ AIM4_PYTHON: '/opt/py/bin/python' });
  assert(withOverride[0].source === 'AIM4_PYTHON', 'an override is tried first');
  assert(withOverride[0].command === '/opt/py/bin/python', 'and is used verbatim');
}

// ---- an override that cannot work is an error, not a hint -----------------------

{
  const bogus = 'aim4-not-a-python-at-all';
  const saved = process.env.AIM4_PYTHON;
  process.env.AIM4_PYTHON = bogus;
  let message = null;
  try {
    findPython();
  } catch (err) {
    message = err.message;
  } finally {
    if (saved === undefined) delete process.env.AIM4_PYTHON;
    else process.env.AIM4_PYTHON = saved;
  }
  assert(message, 'a broken AIM4_PYTHON throws instead of falling through to PATH');
  assert(message.includes('AIM4_PYTHON'), 'the error names the override');
  assert(message.includes(bogus), 'and quotes the value that did not work');
  assert(message.includes('python -m pip install numpy'), 'and carries the fix command');
}

// ---- this machine ---------------------------------------------------------------

{
  const saved = process.env.AIM4_PYTHON;
  delete process.env.AIM4_PYTHON; // grade the default order, not a local setting
  let py = null;
  let failure = null;
  try {
    py = findPython();
  } catch (err) {
    failure = err.message;
  } finally {
    if (saved !== undefined) process.env.AIM4_PYTHON = saved;
  }

  if (py) {
    assert(py.command && py.version && py.numpy && py.source, 'a hit is fully described');
    assert(/^\d+\./.test(py.version), `a version looks like a version (${py.version})`);
    assert(describePython(py).includes(py.command), 'the banner names the interpreter');
    console.log(`  found: ${describePython(py)}`);
  } else {
    console.log('  note: no numpy-capable python on this machine, so that check is skipped.');
    console.log(
      failure
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n')
    );
  }
}

console.log('simPython: ok');
