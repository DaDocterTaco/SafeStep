import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkedIntent, publicPath, threatPageUrl } from '@safestep/contracts';
import { packageMatches } from '../apps/extension/sites/downloads';
import { publisherChoice, publisherGoal, isPublisherTerminal, publisherInformationTarget } from '../apps/extension/sites/publisher-goal';

const origin='https://winscp.net', setup='winscp_windows_setup',portable='winscp_portable';
test('current publisher package and exclusions survive varied goal wording',()=>{
  for(const [goal,profile] of [['Help me find the standard WinSCP installer for Windows.',setup],
    ['Take me to the correct WinSCP download, but do not download it.',setup],
    ['Show me the portable WinSCP download, not PuTTY or source code.',portable]] as const){
    assert.deepEqual(publisherChoice(goal,origin),{kind:'ready',profile});
    assert(checkedIntent(publisherGoal(goal),goal));
  }
  for(const text of ['WinSCP portable installer for Linux','WinSCP MSI download','Find the WinSCP 6.1 installer',
    'WinSCP installer, not WinSCP','Find the experimental WinSCP x64 portable download','Find the standard and portable WinSCP installer'])
    assert.notEqual(publisherChoice(text,origin).kind,'ready',text);
});
test('exact current Setup and portable paths can be checked but can never be followed by either mode',()=>{
  for(const profile of [setup,portable] as const){
    const expected=profile===setup?'Setup.exe':'Portable.zip';
    const final=origin+'/download/WinSCP-8.3.2-'+expected+'/download';
    assert(packageMatches(profile,new URL(final),'8.3.2'));
    assert.equal(threatPageUrl(final,'target'),final);
    assert.equal(publicPath(new URL(final),'publisher'),null);
    assert.equal(publisherInformationTarget(new URL(final),profile),false);
    for(const wrong of [final.replace('8.3.2','8.1'),final.replace('winscp.net','winscp.net.example.org'),
      final.replace(expected,'Portable-x64-Experimental.zip'),final.replace(expected,'Automation.zip'),final+'?token=123',
      final.replace('https:','http:')])assert(!packageMatches(profile,new URL(wrong),'8.3.2'));
    assert(isPublisherTerminal(new URL(origin+'/eng/downloads.php'),profile));
  }
  assert(!isPublisherTerminal(new URL(origin+'/eng/download.php'),portable));
});
