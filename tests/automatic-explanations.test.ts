import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExplanationInput, explanationChoices, validatedExplanation } from '@safestep/contracts';

test('a manual AI explanation can cite the reported homepage scope without conferring page or file safety',()=>{
  const input=ExplanationInput.parse({
    operationId:crypto.randomUUID(),bindingToken:crypto.randomUUID(),kind:'website',profile:null,
    platform:null,architecture:null,selected:null,alternatives:[],evidence:[{id:'e1',code:'host'},{id:'e2',code:'url_lookup'}],
    reviewCoverage:'unavailable',threatCoverage:'source',limited:true,
    urlLookup:{scope:'root',status:'match',categories:['UNWANTED_SOFTWARE']},
  });
  const choices=explanationChoices(input),reason=choices.reasons.find(x=>x.evidenceId==='e2')!;
  assert.match(reason.text,/possible unwanted software for this homepage/);
  const response={summary:reason.text,reasons:[reason],nextStep:choices.nextStep,coverageLimits:[choices.limits[0]]};
  assert.ok(validatedExplanation(response,input));
  assert.equal(validatedExplanation({...response,summary:'Every page on this domain is unsafe.'},input),null);
  assert.equal(ExplanationInput.safeParse({...input,urlLookup:undefined}).success,false);
  assert.equal(ExplanationInput.safeParse({...input,threatCoverage:'unavailable'}).success,false);
});
