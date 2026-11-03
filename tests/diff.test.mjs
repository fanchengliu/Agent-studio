import test from 'node:test';
import assert from 'node:assert/strict';
import { splitDiff } from '../src/diff.js';
test('side by side diff pairs replacements and preserves independent line numbers', () => {
  const rows = splitDiff(
    'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -2,3 +2,4 @@\n context\n-old\n+new\n+extra\n tail\n',
  );
  assert.equal(rows[2].left.text, 'old');
  assert.equal(rows[2].right.text, 'new');
  assert.equal(rows[3].left, null);
  assert.equal(rows[3].right.text, 'extra');
  assert.equal(rows[4].left.number, 4);
  assert.equal(rows[4].right.number, 5);
});
