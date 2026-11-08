import assert from 'node:assert/strict';
import { test } from 'node:test';
import { needsCitationChoice, resolveGoal } from '../apps/extension/sites/profiles';

test('SS7-01 sends ordinary public requests containing citation terms to the general goal flow', () => {
  for (const goal of [
    'Find the Array.map examples on MDN and skip the citation section.',
    'Help me find the HTML cite element on MDN.',
    'Find the Array.map examples on MDN and skip the footnotes.',
  ]) {
    assert.equal(resolveGoal(goal), 'unsupported');
    assert.equal(needsCitationChoice('https://developer.mozilla.org', goal), false);
    assert.equal(needsCitationChoice('https://en.wikipedia.org', goal), false);
  }
  assert(needsCitationChoice('https://en.wikipedia.org', 'Find the MLA citation'));
  assert(needsCitationChoice('https://en.wikipedia.org', 'Find the APA citation for the Moon landing article.'));
  assert.equal(resolveGoal('How do I cite this page?'), 'wikipedia_cite_apa');
});
